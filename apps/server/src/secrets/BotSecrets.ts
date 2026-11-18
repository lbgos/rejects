/**
 * A site secret's value goes to the vault, which types it by reference; a shell secret's stays in
 * the server's secret store, and tool results come back with every such value replaced.
 */
import {
  BOT_SECRET_VALUE_MIN,
  BotSecret,
  type BotSecretAskKind,
  type BotSecretKind,
  type BotRecord,
  OrchestratorMcpFailure,
  type ThreadId,
  onSite,
  sheetFirstSite,
  siteOf,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BotNotifications from "../bots/BotNotifications.ts";
import * as BotRecordings from "../bots/BotRecordings.ts";
import * as BotStore from "../bots/BotStore.ts";
import { chatLanguageOf } from "../bots/language.ts";
import * as ServerConfig from "../config.ts";
import * as ConnectionStore from "../connections/ConnectionStore.ts";
import { ConnectionsError } from "../connections/ConnectionsError.ts";
import { makeContinuations } from "../connections/continuation.ts";
import * as Vault from "../connections/VaultClient.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { redactKeys } from "../push/redact.ts";

const Stored = Schema.Struct({
  ...BotSecret.fields,
  /** The run that asked came from the user's own message, so its continuation may write. */
  writes: Schema.Boolean,
});
type Stored = typeof Stored.Type;
const SecretsFile = Schema.Struct({ secrets: Schema.Array(Stored) });
const LoginFailed = Schema.Struct({ failed: Schema.Boolean });
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(SecretsFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(SecretsFile));

const storeName = (id: string) => `bot-secret-${id}`;
const kindOf = (secret: Pick<BotSecret, "kind">): BotSecretKind => secret.kind ?? "password";

/** A site secret by reference: the vault resolves the value from `id`. */
export interface TypedSecret {
  readonly id: string;
  readonly name: string;
  readonly site: string;
  readonly kind: BotSecretKind;
}
const LABEL_CHARS = 80;
const REASON_CHARS = 300;
/** A `login` name leaves room for `-username` and `-password` within BotSecretName. */
const LOGIN_NAME_CHARS = 55;
const loginLine = (site: string, username: string, password: string) =>
  `Type them with web_browse: account set to the site, action type, secretRef "${username}" into the sign-in name field and "${password}" into the password field. They are typed only on ${site}.`;

export class BotSecrets extends Context.Service<
  BotSecrets,
  {
    readonly ask: (
      scope: McpInvocationContext.McpInvocationScope,
      input: {
        readonly name: string;
        readonly label: string;
        readonly reason: string;
        readonly site?: string | undefined;
        readonly kind?: BotSecretAskKind | undefined;
      },
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly list: Effect.Effect<ReadonlyArray<BotSecret>>;
    readonly save: (id: string, value: string) => Effect.Effect<void, ConnectionsError>;
    readonly remove: (id: string) => Effect.Effect<void, ConnectionsError>;
    readonly typed: (
      botThreadId: ThreadId,
      name: string,
    ) => Effect.Effect<TypedSecret, OrchestratorMcpFailure>;
    /** A code was typed: the vault dropped it, and the bot asks again next time. */
    readonly spent: (secret: TypedSecret) => Effect.Effect<void>;
    /** Whether the bot holds a saved login typed on `site` or one of its hosts. */
    readonly hasLogin: (
      botThreadId: ThreadId,
      hosts: ReadonlyArray<string>,
    ) => Effect.Effect<boolean>;
    /** Deletes every saved login typed on `site` or under it, for every bot. */
    readonly removeSite: (site: string) => Effect.Effect<void, ConnectionsError>;
    readonly forShell: (
      botThreadId: ThreadId,
      name: string,
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly redactor: (botThreadId: ThreadId) => Effect.Effect<(text: string) => string>;
  }
>()("t3/secrets/BotSecrets") {}

const formsOf = (value: string) =>
  [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])]
    .filter((form) => form.length >= BOT_SECRET_VALUE_MIN)
    .toSorted((a, b) => b.length - a.length);

/** Saved values by name, then any key-shaped token: a page may show a key the user never saved. */
const redactWith =
  (secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>) => (text: string) =>
    redactKeys(
      secrets.reduce(
        (out, secret) =>
          formsOf(secret.value).reduce(
            (current, form) => current.split(form).join(`[secret ${secret.name}]`),
            out,
          ),
        text,
      ),
    );

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const vault = yield* Vault.VaultClient;
  const bots = yield* BotStore.BotStore;
  const notifications = yield* BotNotifications.BotNotifications;
  const recordings = yield* BotRecordings.BotRecordings;
  const threads = yield* Threads.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;
  const continuations = yield* makeContinuations;
  const connections = yield* ConnectionStore.ConnectionStore;
  const file = path.join(config.stateDir, "bot-secrets.json");
  const lock = yield* Semaphore.make(1);
  /** The user's Save and Remove, one at a time, so a value is never stored after its entry went. */
  const answers = yield* Semaphore.make(1);
  let secrets: ReadonlyArray<Stored> = yield* fs.readFileString(file).pipe(
    Effect.map((text) =>
      Option.match(decodeFile(text), { onNone: () => [], onSome: (f) => f.secrets }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<Stored> => []),
  );
  const values = new Map<string, string>();

  const mutate = (change: (current: ReadonlyArray<Stored>) => ReadonlyArray<Stored>) =>
    lock.withPermit(
      Effect.gen(function* () {
        const next = change(secrets);
        yield* encodeFile({ secrets: next }).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        secrets = next;
      }),
    );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const refuse = (message: string) =>
    new OrchestratorMcpFailure({ code: "capability_denied", message });
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  const view = ({ writes: _writes, ...secret }: Stored): BotSecret => secret;

  const valueOf = Effect.fn("BotSecrets.valueOf")(function* (id: string) {
    const cached = values.get(id);
    if (cached !== undefined) return Option.some(cached);
    const stored = yield* store.get(storeName(id)).pipe(Effect.orElseSucceed(Option.none));
    const value = Option.map(stored, (bytes) => new TextDecoder().decode(bytes));
    if (Option.isSome(value)) values.set(id, value.value);
    return value;
  });

  /** A kept password the site refused may be asked for again; the vault knows which. */
  const refused = (secret: Stored) =>
    kindOf(secret) !== "password" || secret.site === null
      ? Effect.succeed(false)
      : vault.call("/login/failed", { id: secret.id }, LoginFailed).pipe(
          Effect.map(({ failed }) => failed),
          Effect.orElseSucceed(() => false),
        );

  const ask: BotSecrets["Service"]["ask"] = Effect.fn("BotSecrets.ask")(function* (scope, input) {
    const threadId = scope.thread?.threadId;
    const bot = threadId === undefined ? undefined : yield* bots.owner(threadId);
    if (bot === undefined) return yield* refuse("Only a bot's own threads ask for secrets.");
    const site = input.site === undefined ? null : siteOf(input.site);
    if (site === undefined)
      return yield* invalid("site must be the site's host, such as olx.ua, or left out.");
    if (input.kind !== undefined && site === null)
      return yield* invalid("kind is for a site's sign-in; leave it out for a shell secret.");
    if (site === null && bot.tools !== undefined && !bot.tools.includes("computer_shell"))
      return yield* refuse(
        "A secret without site is for computer_shell, which you do not have. For a site's sign-in give site and kind.",
      );
    if (site !== null && bot.tools !== undefined && !bot.tools.includes("web_browse"))
      return yield* refuse(
        "A secret with site is typed with web_browse and account, which you do not have.",
      );
    // The user signs in to these on the sheet; a card would ask for a password they may not have.
    if (site !== null && input.kind !== "code" && sheetFirstSite(site))
      return yield* refuse(
        `${site} signs in on the sheet, not with a card: call request_login with site ${site} and end your turn.`,
      );
    const label = input.label.replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS);
    const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
    if (!label || !reason) return yield* invalid("Give a label and a reason the user reads.");
    const askKind = input.kind;
    if (askKind === "login")
      return site === null
        ? yield* invalid("kind is for a site's sign-in; leave it out for a shell secret.")
        : yield* askLogin(scope, bot, { name: input.name, label, reason, site });
    const existing = secrets.find((s) => s.botThreadId === bot.threadId && s.name === input.name);
    const useLine = (s: Pick<Stored, "name" | "site" | "kind">) =>
      s.site
        ? `Type it with web_browse: account set to the site, action type, the field's ref and secretRef "${s.name}". It is typed only on ${s.site}${kindOf(s) === "code" ? ", once" : ""}.`
        : `Pass it to computer_shell as secrets: [{"secretRef": "${s.name}", "env": "NAME"}].`;
    // A code is used once, so asking again is a new card; a login stays until the user removes it.
    if (existing?.savedAt && kindOf(existing) !== "code" && !(yield* refused(existing)))
      return `You already have secret "${existing.name}". ${useLine(existing)}`;
    const wanted = askKind ?? "password";
    // A lone name or password is a re-ask next to a saved half; a first sign-in is one login card.
    if (
      site !== null &&
      wanted !== "code" &&
      !secrets.some(
        (s) =>
          s.botThreadId === bot.threadId &&
          s.savedAt !== null &&
          s.site === site &&
          kindOf(s) !== "code",
      )
    )
      return yield* refuse(
        `You hold no sign-in for ${site}, so ask once with kind login: ask_secret with site ${site} and kind login, one card for the name and the password. A username or password alone is only for when you hold the other. One value that is not a sign-in, such as an API key, PIN or invite code, is kind code: typed once, then deleted.`,
      );
    // One sign-in name and one password per host: a second card would ask for what the bot holds.
    const held =
      site === null || wanted === "code"
        ? undefined
        : secrets.find(
            (s) =>
              s.botThreadId === bot.threadId &&
              s.savedAt !== null &&
              s.site === site &&
              kindOf(s) === wanted &&
              s.name !== input.name,
          );
    if (held !== undefined && !(yield* refused(held)))
      return `You already have the saved ${wanted} for ${site}: secretRef "${held.name}". ${useLine(held)}${wanted === "password" ? " If the site refused it, call request_login." : ""}`;
    const writes = yield* continuations.startedByUser(scope, bot.threadId);
    const kind = site === null ? undefined : (askKind ?? existing?.kind);
    const secret: Stored = {
      id: existing?.id ?? (yield* crypto.uuidV4().pipe(Effect.orDie)),
      botThreadId: bot.threadId,
      name: input.name,
      label,
      reason,
      site,
      ...(kind === undefined ? {} : { kind }),
      requestedAt: existing?.requestedAt ?? (yield* now),
      savedAt: null,
      lastUsedAt: null,
      writes: writes || existing?.writes === true,
    };
    yield* mutate((current) => [...current.filter((s) => s.id !== secret.id), secret]).pipe(
      Effect.mapError(() => refuse("Could not save the request.")),
    );
    // An unanswered card asked again gets no second push.
    if (existing === undefined || existing.savedAt !== null)
      yield* notifications
        .notify(
          bot.threadId,
          {
            en: `${bot.name} asks for a secret: ${label}`,
            ru: `${bot.name} просит секрет: ${label}`,
            uk: `${bot.name} просить секрет: ${label}`,
          }[yield* chatLanguageOf(threads, bot.threadId)],
          // Its card in the chat shows the request.
          { inChat: true },
        )
        .pipe(Effect.ignore({ log: true }));
    return `Asked the user for "${label}" in a private card; you never see the value, and never ask for it in chat. End your turn now. You are woken when they save it. ${useLine(secret)}`;
  });

  /**
   * One card for a site's sign-in name and password: two secrets that share `request`. A bot that
   * already holds one of them is told to ask for the other alone.
   */
  const askLogin = Effect.fn("BotSecrets.askLogin")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    bot: BotRecord,
    input: {
      readonly name: string;
      readonly label: string;
      readonly reason: string;
      readonly site: string;
    },
  ) {
    const { name, label, reason, site } = input;
    if (name.length > LOGIN_NAME_CHARS)
      return yield* invalid(
        `A login name becomes ${name}-username and ${name}-password; keep it to ${LOGIN_NAME_CHARS} characters.`,
      );
    const held = (kind: BotSecretKind) =>
      secrets.find(
        (s) =>
          s.botThreadId === bot.threadId &&
          s.savedAt !== null &&
          s.site === site &&
          kindOf(s) === kind,
      );
    const username = held("username");
    const password = held("password");
    const passwordWorks = password !== undefined && !(yield* refused(password));
    if (username !== undefined && passwordWorks)
      return `You already have the saved sign-in for ${site}. ${loginLine(site, username.name, password.name)} If the site refused it, call request_login.`;
    if (username !== undefined)
      return `You already have the saved sign-in name for ${site}: secretRef "${username.name}". Ask only for the password: ask_secret with site ${site} and kind password${password ? ` and name "${password.name}"` : ""}.`;
    if (passwordWorks)
      return `You already have the saved password for ${site}: secretRef "${password.name}". Ask only for the sign-in name: ask_secret with site ${site} and kind username.`;
    const names = { username: `${name}-username`, password: `${name}-password` } as const;
    // The bot's unanswered cards for the host become this one, so a re-sent login replaces them.
    const unanswered = secrets.filter(
      (s) =>
        s.botThreadId === bot.threadId &&
        s.savedAt === null &&
        s.site === site &&
        kindOf(s) !== "code",
    );
    const prior = (kind: keyof typeof names) =>
      secrets.find((s) => s.botThreadId === bot.threadId && s.name === names[kind]) ??
      unanswered.find((s) => kindOf(s) === kind);
    const priors = { username: prior("username"), password: prior("password") };
    const request =
      priors.username?.request ??
      priors.password?.request ??
      (yield* crypto.uuidV4().pipe(Effect.orDie));
    const writes = yield* continuations.startedByUser(scope, bot.threadId);
    const at = yield* now;
    const made: Array<Stored> = [];
    for (const kind of ["username", "password"] as const)
      made.push({
        id: priors[kind]?.id ?? (yield* crypto.uuidV4().pipe(Effect.orDie)),
        botThreadId: bot.threadId,
        name: names[kind],
        label,
        reason,
        site,
        kind,
        request,
        requestedAt: priors[kind]?.requestedAt ?? at,
        savedAt: null,
        lastUsedAt: null,
        writes: writes || priors[kind]?.writes === true,
      });
    const ids = new Set(made.map((s) => s.id));
    yield* mutate((current) => [...current.filter((s) => !ids.has(s.id)), ...made]).pipe(
      Effect.mapError(() => refuse("Could not save the request.")),
    );
    for (const stale of unanswered.filter((s) => !ids.has(s.id)))
      yield* drop(stale).pipe(Effect.ignore({ log: true }));
    // An unanswered card asked again gets no second push.
    if (priors.username?.savedAt !== null || priors.password?.savedAt !== null)
      yield* notifications
        .notify(
          bot.threadId,
          {
            en: `${bot.name} asks you to sign in: ${label}`,
            ru: `${bot.name} просит данные для входа: ${label}`,
            uk: `${bot.name} просить дані для входу: ${label}`,
          }[yield* chatLanguageOf(threads, bot.threadId)],
          // Its card in the chat shows the request.
          { inChat: true },
        )
        .pipe(Effect.ignore({ log: true }));
    return `Asked the user for "${label}" in one private card with the sign-in name and the password; you never see them, and never ask for them in chat. End your turn now. You are woken once they save it. ${loginLine(site, names.username, names.password)}`;
  });

  /** A secret with a site is only typed in the account browser; one without, only given to shell. */
  const find = Effect.fn("BotSecrets.find")(function* (
    botThreadId: ThreadId,
    name: string,
    how: "browser" | "shell",
  ) {
    const mine = secrets.filter((s) => s.botThreadId === botThreadId && s.savedAt !== null);
    const secret = mine.find((s) => s.name === name);
    if (secret === undefined)
      return yield* refuse(
        `You have no saved secret "${name}". ${mine.length ? `Yours: ${mine.map((s) => s.name).join(", ")}.` : ""} Ask with ask_secret.`.trim(),
      );
    if (how === "browser" && secret.site === null)
      return yield* refuse(`Secret "${name}" is for shell commands only, not for typing.`);
    if (how === "shell" && secret.site !== null)
      return yield* refuse(
        `Secret "${name}" is only typed on ${secret.site}, with web_browse and account.`,
      );
    const at = yield* now;
    yield* mutate((current) =>
      current.map((s) => (s.id === secret.id ? { ...s, lastUsedAt: at } : s)),
    ).pipe(Effect.ignore({ log: true }));
    return secret;
  });
  const gone = (name: string) =>
    refuse(`Secret "${name}" is gone. Ask the user again with ask_secret.`);

  const toVault = (secret: Stored & { readonly site: string }, value: string) =>
    vault
      .call(
        "/login/set",
        { id: secret.id, site: secret.site, kind: kindOf(secret), value },
        Schema.Unknown,
      )
      .pipe(Effect.mapError((e) => new ConnectionsError({ message: e.message })));

  /** Drops the entry, then the value wherever it is kept; the entry comes back if that fails. */
  const drop = Effect.fn("BotSecrets.drop")(function* (secret: Stored) {
    yield* mutate((current) => current.filter((s) => s.id !== secret.id)).pipe(
      Effect.mapError(() => new ConnectionsError({ message: "Could not remove the secret." })),
    );
    values.delete(secret.id);
    yield* Effect.gen(function* () {
      if (secret.site !== null)
        yield* vault.call("/login/remove", { id: secret.id }, Schema.Unknown);
      yield* store.remove(storeName(secret.id));
    }).pipe(
      Effect.tapError(() =>
        mutate((current) =>
          current.some((s) => s.id === secret.id) ? current : [...current, secret],
        ).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError(
        () =>
          new ConnectionsError({
            message: "Not removed: the value could not be deleted. Try again.",
          }),
      ),
    );
  });

  const remove = Effect.fn("BotSecrets.remove")(function* (id: string) {
    const secret = yield* answers.withPermit(
      Effect.gen(function* () {
        const secret = secrets.find((s) => s.id === id);
        if (secret === undefined) return undefined;
        // The entry goes first, so a bot mid-run is refused even if the vault is slow.
        yield* drop(secret);
        return secret;
      }),
    );
    if (secret !== undefined) yield* recordings.forget({ secret });
  });

  return BotSecrets.of({
    ask,
    list: Effect.sync(() => secrets.map(view)),
    save: Effect.fn("BotSecrets.save")(function* (id, value) {
      if (value.length < BOT_SECRET_VALUE_MIN)
        return yield* new ConnectionsError({
          message: `A secret needs at least ${BOT_SECRET_VALUE_MIN} characters.`,
        });
      const first = yield* answers.withPermit(
        Effect.gen(function* () {
          const secret = secrets.find((s) => s.id === id);
          if (secret === undefined)
            return yield* new ConnectionsError({ message: "This request no longer exists." });
          if (secret.site === null) {
            yield* store
              .set(storeName(id), new TextEncoder().encode(value))
              .pipe(
                Effect.mapError(
                  () => new ConnectionsError({ message: "Could not store the secret." }),
                ),
              );
            values.set(id, value);
          } else yield* toVault({ ...secret, site: secret.site }, value);
          const at = yield* now;
          yield* mutate((current) =>
            current.map((s) => (s.id === id ? { ...s, savedAt: at } : s)),
          ).pipe(
            Effect.mapError(() => new ConnectionsError({ message: "Could not save the secret." })),
          );
          return secret.savedAt === null ? secret : undefined;
        }),
      );
      if (first === undefined) return;
      // A login card wakes the bot once, when its sign-in name and password are both saved.
      const group =
        first.request === undefined
          ? [first]
          : secrets.filter(
              (s) => s.request === first.request && s.botThreadId === first.botThreadId,
            );
      if (group.some((s) => s.id !== id && s.savedAt === null)) return;
      const site = first.site;
      // A saved password answers the sign-in this bot asked for there, so its sheet card closes.
      if (site !== null && group.some((s) => kindOf(s) === "password"))
        yield* connections
          .mutate((file) => ({
            ...file,
            loginRequests: file.loginRequests.filter(
              (r) =>
                r.botThreadId !== first.botThreadId ||
                r.check !== undefined ||
                !onSite(`https://${site}/`, r.site),
            ),
          }))
          .pipe(Effect.ignore({ log: true }));
      const username = group.find((s) => kindOf(s) === "username");
      const password = group.find((s) => kindOf(s) === "password");
      const line =
        site !== null && group.length > 1 && username && password
          ? `Type secretRef "${username.name}" into the sign-in name field and "${password.name}" into the password field, with web_browse and account, on ${site}.`
          : `Use it as secretRef "${first.name}"${site ? ` with web_browse and account, on ${site}` : " in computer_shell"}.`;
      yield* continuations.continueTask({
        id: `secrets:continue:${first.request ?? id}`,
        botThreadId: first.botThreadId,
        title: group.length > 1 ? `Saved sign-in for ${site}` : `Saved secret ${first.name}`,
        line: `The user saved "${first.label}" for: ${first.reason}\n${line}`,
        writes: group.some((s) => s.writes),
      });
    }),
    remove,
    typed: Effect.fn("BotSecrets.typed")(function* (botThreadId, name) {
      const secret = yield* find(botThreadId, name, "browser");
      if (secret.site === null) return yield* gone(name);
      const site = secret.site;
      // A value saved before logins moved to the vault moves there on its first use.
      const legacy = yield* store.get(storeName(secret.id)).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(legacy)) {
        yield* toVault({ ...secret, site }, new TextDecoder().decode(legacy.value)).pipe(
          Effect.mapError(() => refuse("The account vault did not take the secret.")),
        );
        values.delete(secret.id);
        yield* store.remove(storeName(secret.id)).pipe(Effect.ignore({ log: true }));
      }
      return { id: secret.id, name: secret.name, site, kind: kindOf(secret) };
    }),
    spent: Effect.fn("BotSecrets.spent")(function* (typed) {
      if (typed.kind !== "code") return;
      yield* mutate((current) => current.filter((s) => s.id !== typed.id)).pipe(
        Effect.ignore({ log: true }),
      );
    }),
    hasLogin: Effect.fn("BotSecrets.hasLogin")((botThreadId, hosts) =>
      Effect.sync(() =>
        secrets.some(
          (s) =>
            s.botThreadId === botThreadId &&
            s.savedAt !== null &&
            s.site !== null &&
            hosts.some((host) => onSite(`https://${s.site}/`, host)),
        ),
      ),
    ),
    removeSite: Effect.fn("BotSecrets.removeSite")(function* (site) {
      for (const secret of secrets)
        if (secret.site !== null && onSite(`https://${secret.site}/`, site))
          yield* remove(secret.id);
    }),
    forShell: Effect.fn("BotSecrets.forShell")(function* (botThreadId, name) {
      const secret = yield* find(botThreadId, name, "shell");
      const value = yield* valueOf(secret.id);
      if (Option.isNone(value)) return yield* gone(name);
      return value.value;
    }),
    redactor: Effect.fn("BotSecrets.redactor")(function* (botThreadId) {
      const known: Array<{ name: string; value: string }> = [];
      for (const secret of secrets)
        if (secret.botThreadId === botThreadId && secret.savedAt !== null) {
          const value = yield* valueOf(secret.id);
          if (Option.isSome(value)) known.push({ name: secret.name, value: value.value });
        }
      return redactWith(known);
    }),
  });
});

export const layer = Layer.effect(BotSecrets, make);

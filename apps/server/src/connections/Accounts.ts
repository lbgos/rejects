/** No password or cookie is kept here; Sign out and Disconnect also delete the logins kept for the site. */
import {
  type AccountGrant,
  type BrowserCheck,
  type LoginRequest,
  OrchestratorMcpFailure,
  SheetFrame,
  type SheetInput,
  type ThreadId,
  VaultAccount,
  commonSite,
  onSite,
  sheetFirstHost,
  sheetFirstSite,
  siteName,
  siteOf,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as BotNotifications from "../bots/BotNotifications.ts";
import * as BotRecordings from "../bots/BotRecordings.ts";
import * as BotStore from "../bots/BotStore.ts";
import { blockedStop, type Challenge, challengeStop } from "../bots/challenge.ts";
import { chatLanguageOf } from "../bots/language.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as BotSecrets from "../secrets/BotSecrets.ts";
import type { AccountAction } from "../vault/Vault.ts";
import { ConnectionsError } from "./ConnectionsError.ts";
import * as Store from "./ConnectionStore.ts";
import { makeContinuations } from "./continuation.ts";
import * as Vault from "./VaultClient.ts";

const Ok = Schema.Unknown;
const VaultAccounts = Schema.Struct({ accounts: Schema.Array(VaultAccount) });
export const AccountPage = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  snapshot: Schema.String,
  nextOffset: Schema.optional(Schema.Int),
  blocked: Schema.optional(Schema.String),
  challenge: Schema.optional(Schema.Struct({ vendor: Schema.String, label: Schema.String })),
});
export type AccountPage = typeof AccountPage.Type;

const REASON_CHARS = 300;

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly requestLogin: (
      scope: McpInvocationContext.McpInvocationScope,
      input: { readonly site: string; readonly reason: string; readonly url?: string | undefined },
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly browse: (
      scope: McpInvocationContext.McpInvocationScope,
      site: string,
      action: AccountAction,
      login?: {
        readonly secret?: BotSecrets.TypedSecret | undefined;
        /** Whether the bot holds a saved login on one of these hosts. */
        readonly hasLogin: (hosts: ReadonlyArray<string>) => Effect.Effect<boolean>;
      },
    ) => Effect.Effect<AccountPage, OrchestratorMcpFailure>;
    readonly requestCheck: (
      scope: McpInvocationContext.McpInvocationScope,
      input: {
        readonly url: string;
        readonly challenge: Challenge;
        readonly browser: BrowserCheck["browser"];
      },
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly checkDone: (id: string) => Effect.Effect<void, ConnectionsError>;
    readonly origins: (
      site: string,
      origins: ReadonlyArray<string>,
    ) => Effect.Effect<void, ConnectionsError>;
    readonly pending: Effect.Effect<ReadonlyArray<LoginRequest>>;
    /** The user's "Sign in on the page instead" on a login card. */
    readonly choosePage: (
      secretId: string,
    ) => Effect.Effect<{ readonly site: string; readonly requestId: string }, ConnectionsError>;
    readonly dismiss: (id: string) => Effect.Effect<void, ConnectionsError>;
    readonly sheetOpen: (input: {
      readonly site: string;
      readonly requestId?: string | undefined;
    }) => Effect.Effect<void, ConnectionsError>;
    readonly sheetFrame: (
      site: string,
      after: number,
    ) => Effect.Effect<SheetFrame, ConnectionsError>;
    readonly sheetViewport: (
      site: string,
      viewport: { readonly width: number; readonly height: number; readonly scale: number },
    ) => Effect.Effect<void, ConnectionsError>;
    readonly sheetInput: (site: string, input: SheetInput) => Effect.Effect<void, ConnectionsError>;
    readonly sheetClose: (site: string, done: boolean) => Effect.Effect<void, ConnectionsError>;
    readonly grant: (input: {
      readonly site: string;
      readonly botThreadId: ThreadId;
      readonly granted: boolean;
      readonly scheduledWrites?: boolean | undefined;
    }) => Effect.Effect<void, ConnectionsError>;
    readonly signOut: (site: string) => Effect.Effect<void, ConnectionsError>;
    readonly revoke: (site: string) => Effect.Effect<void, ConnectionsError>;
  }
>()("t3/connections/Accounts") {}

export const loginAsked = (site: string) =>
  `Asked the user to sign in to ${siteName(site, "en")} (${site}) with a card in this chat. Tell them in one short line that they sign in there as usual. End your turn now. Once they have signed in, you are woken to continue with web_browse and account "${site}".`;

/**
 * Sites whose usual entry pages send the vault's Android browser to an app download (measured
 * 2026-11-16). The sheet starts on their sign-in form instead.
 */
const SHEET_STARTS: Readonly<
  Record<string, { readonly start: string; readonly redirects: RegExp }>
> = {
  "slack.com": {
    start: "https://slack.com/workspace-signin",
    redirects: /^(?:slack\.com\/(?:signin\b.*)?|app\.slack\.com\/(?:client\b.*)?)$/,
  },
};

/** The page the sign-in sheet opens; `url` is on the site or undefined. */
const sheetUrl = (site: string, url: string | undefined) => {
  const entry = Object.entries(SHEET_STARTS).find(
    ([key]) => site === key || site.endsWith(`.${key}`),
  )?.[1];
  if (url === undefined) return entry?.start ?? `https://${site}/`;
  if (entry === undefined) return url;
  const { hostname, pathname } = new URL(url);
  return entry.redirects.test(`${hostname.replace(/^www\./, "")}${pathname}`) ? entry.start : url;
};

/** A new account's other hosts, seeded from its common site once; a later edit is the user's. */
const withCommonOrigins = (file: Store.ConnectionsFile, site: string): Store.ConnectionsFile => {
  const origins = commonSite(site)?.origins ?? [];
  return origins.length === 0 || file.origins[site] !== undefined
    ? file
    : { ...file, origins: { ...file.origins, [site]: [...origins] } };
};

const withGrant = (
  grants: ReadonlyArray<AccountGrant> | undefined,
  botThreadId: ThreadId,
  grant: AccountGrant | undefined,
) => [
  ...(grants ?? []).filter((g) => g.botThreadId !== botThreadId),
  ...(grant === undefined ? [] : [grant]),
];

const make = Effect.gen(function* () {
  const store = yield* Store.ConnectionStore;
  const vault = yield* Vault.VaultClient;
  const bots = yield* BotStore.BotStore;
  const notifications = yield* BotNotifications.BotNotifications;
  const recordings = yield* BotRecordings.BotRecordings;
  const secrets = yield* BotSecrets.BotSecrets;
  const threads = yield* Threads.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;
  const { startedByUser, continueTask } = yield* makeContinuations;

  const fail = (message: string) => new ConnectionsError({ message });
  const asFailure = <A, R>(
    effect: Effect.Effect<A, Vault.VaultCallError | Store.ConnectionStoreError, R>,
  ) => effect.pipe(Effect.mapError((e) => fail(e.message)));
  const refuse = (message: string) =>
    new OrchestratorMcpFailure({ code: "capability_denied", message });
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const callingBot = Effect.fn("Accounts.callingBot")(function* (
    scope: McpInvocationContext.McpInvocationScope,
  ) {
    const threadId = scope.thread?.threadId;
    const bot = threadId === undefined ? undefined : yield* bots.owner(threadId);
    if (bot === undefined) return yield* refuse("Only a bot's own threads use accounts.");
    return bot;
  });

  const vaultAccounts = vault
    .call("/state", {}, VaultAccounts)
    .pipe(Effect.map(({ accounts }) => accounts));

  const continueAfter = (request: LoginRequest) =>
    continueTask({
      id: `accounts:continue:${request.id}`,
      botThreadId: request.botThreadId,
      writes: request.writes,
      ...(request.check
        ? {
            title: `Passed the check on ${request.site}`,
            line: `The user passed the ${request.check.label} on ${request.url}.`,
          }
        : {
            title: `Signed in to ${request.site}`,
            line: `The user signed in for: ${request.reason}`,
          }),
    });

  const putRequest = Effect.fn("Accounts.putRequest")(function* (
    make: (existing: LoginRequest | undefined, id: string, at: string) => LoginRequest,
    bot: { readonly threadId: ThreadId },
    site: string,
  ) {
    const existing = (yield* store.read).loginRequests.find(
      (r) => r.botThreadId === bot.threadId && r.site === site,
    );
    const request = make(
      existing,
      existing?.id ?? (yield* crypto.uuidV4().pipe(Effect.orDie)),
      existing?.createdAt ?? (yield* now),
    );
    yield* store
      .mutate((current) => ({
        ...current,
        loginRequests: [...current.loginRequests.filter((r) => r.id !== request.id), request],
      }))
      .pipe(Effect.mapError((e) => refuse(e.message)));
    return { request, created: existing === undefined };
  });

  const pushOnce = (
    created: boolean,
    bot: { readonly threadId: ThreadId; readonly name: string },
    lines: Record<"en" | "ru" | "uk", string>,
  ) =>
    created
      ? Effect.gen(function* () {
          yield* notifications
            .notify(bot.threadId, lines[yield* chatLanguageOf(threads, bot.threadId)])
            .pipe(Effect.ignore({ log: true }));
        })
      : Effect.void;

  const requestCheck = Effect.fn("Accounts.requestCheck")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    input: {
      readonly url: string;
      readonly challenge: Pick<Challenge, "label"> & { readonly vendor: string };
      readonly browser: BrowserCheck["browser"];
      readonly site: string | undefined;
    },
  ) {
    const { site } = input;
    const { label } = input.challenge;
    // A block page is not a check: no request, no push.
    if (input.challenge.vendor === "blocked") return blockedStop(site ?? input.url, input.browser);
    const bot = yield* callingBot(scope);
    if (site === undefined) return challengeStop(label, input.url, false);
    const writes = yield* startedByUser(scope, bot.threadId);
    const { created } = yield* putRequest(
      (existing, id, createdAt) => ({
        id,
        site,
        url: input.url,
        reason: `${label} on ${input.url}`.slice(0, REASON_CHARS),
        botThreadId: bot.threadId,
        writes: writes || existing?.writes === true,
        createdAt,
        check: { label, browser: input.browser },
      }),
      bot,
      site,
    );
    yield* pushOnce(created, bot, {
      en: `${bot.name} needs you to pass a ${label} on ${site}`,
      ru: `${bot.name} просит пройти проверку (${label}) на ${site}`,
      uk: `${bot.name} просить пройти перевірку (${label}) на ${site}`,
    });
    return challengeStop(label, site, true);
  });

  return Accounts.of({
    requestLogin: Effect.fn("Accounts.requestLogin")(function* (scope, input) {
      const bot = yield* callingBot(scope);
      const known = commonSite(input.site)?.site;
      const named = known ?? siteOf(input.site);
      const linked = input.url === undefined ? undefined : siteOf(input.url);
      // Bots name the host and leave the port to the url.
      const site = named && linked?.startsWith(`${named}:`) ? linked : (named ?? linked);
      if (site === undefined)
        return yield* invalid("site must be the site's host, such as olx.ua or forum.example.org.");
      const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
      if (!reason) return yield* invalid("Say in reason what you need the account for.");
      // A bot that can ask for a login card asks for one first. The sheet opens once a login is
      // saved, on a sheet-first host, or after the user chose the page on the card.
      const current = yield* store.read;
      if (
        scope.allowedToolNames?.has("ask_secret") === true &&
        !sheetFirstHost(site) &&
        !(current.pageChosen[site] ?? []).includes(bot.threadId) &&
        !(yield* secrets.hasLogin(bot.threadId, [site, ...Store.originsOf(current, site)]))
      )
        return yield* refuse(
          `Use the login card for ${site} first: call ask_secret with site ${site} and kind login, and end your turn. On the card the user can choose to sign in on the page instead.`,
        );
      const accounts = yield* vaultAccounts.pipe(
        Effect.mapError((e) =>
          e.unavailable ? refuse("The account vault is not answering.") : invalid(e.message),
        ),
      );
      const file = yield* store.read;
      const granted = (file.accounts[site] ?? []).some((g) => g.botThreadId === bot.threadId);
      // Until a bot has used the sign-in, it tries the account first. A login wall after that
      // means the session ended there, and the user gets a new card. A bot's own sign-in sets
      // both times at once, and its request_login after that needs the card.
      const unused = accounts.some(
        (a) =>
          a.site === site &&
          a.signedInAt !== null &&
          (a.lastUsedAt === null || a.lastUsedAt < a.signedInAt),
      );
      if (granted && unused)
        return `You already have ${site}. Use web_browse with account "${site}".`;
      const writes = yield* startedByUser(scope, bot.threadId);
      const { created } = yield* putRequest(
        (existing, id, createdAt) => ({
          id,
          site,
          url: sheetUrl(
            site,
            input.url !== undefined && onSite(input.url, site) ? input.url : existing?.url,
          ),
          reason,
          botThreadId: bot.threadId,
          writes: writes || existing?.writes === true,
          createdAt,
        }),
        bot,
        site,
      );
      yield* pushOnce(created, bot, {
        en: `${bot.name} needs you to sign in to ${siteName(site, "en")}`,
        ru: `${bot.name} просит войти в ${siteName(site, "ru")}`,
        uk: `${bot.name} просить увійти в ${siteName(site, "uk")}`,
      });
      return loginAsked(site);
    }),

    requestCheck: Effect.fn("Accounts.requestCheckFor")(function* (scope, input) {
      return yield* requestCheck(scope, {
        url: input.url,
        challenge: input.challenge,
        browser: input.browser,
        site: siteOf(input.url),
      });
    }),

    checkDone: Effect.fn("Accounts.checkDone")(function* (id) {
      const request = (yield* store.read).loginRequests.find((r) => r.id === id);
      if (request === undefined) return;
      yield* asFailure(
        store.mutate((file) => ({
          ...file,
          loginRequests: file.loginRequests.filter((r) => r.id !== id),
        })),
      );
      yield* continueAfter(request);
    }),

    origins: Effect.fn("Accounts.origins")((site, origins) =>
      asFailure(
        store.mutate((file) => ({
          ...file,
          origins: {
            ...file.origins,
            [site]: [...new Set(origins.filter((origin) => origin !== site))],
          },
        })),
      ).pipe(Effect.asVoid),
    ),

    browse: Effect.fn("Accounts.browse")(function* (scope, site, action, login) {
      const bot = yield* callingBot(scope);
      let file = yield* store.read;
      const hosts = [site, ...Store.originsOf(file, site)];
      let grant = (file.accounts[site] ?? []).find((g) => g.botThreadId === bot.threadId);
      // A login the user saved for this bot on the site, or a code of theirs typed under its grant,
      // is their go-ahead for it to use the account before it is signed in.
      const signIn =
        grant?.codeTyped === true || (login !== undefined && (yield* login.hasLogin(hosts)));
      if (grant === undefined && signIn) {
        grant = { botThreadId: bot.threadId, scheduledWrites: false };
        const added = grant;
        file = yield* store
          .mutate((current) => {
            const first = (current.accounts[site]?.length ?? 0) === 0;
            const next = {
              ...current,
              accounts: {
                ...current.accounts,
                [site]: withGrant(current.accounts[site], bot.threadId, added),
              },
            };
            return first ? withCommonOrigins(next, site) : next;
          })
          .pipe(Effect.mapError((e) => refuse(e.message)));
      }
      if (grant === undefined)
        return yield* refuse(
          sheetFirstSite(site)
            ? `You are not signed in to ${site}. It signs in on the sheet: call request_login with site ${site} and end your turn.`
            : `You are not signed in to ${site}. Sign in yourself: call ask_secret now with kind login and site set to the sign-in page's host, and end your turn. Call request_login only if you have no ask_secret or that sign-in fails.`,
        );
      const writes = grant.scheduledWrites || (yield* startedByUser(scope, bot.threadId));
      const secret = login?.secret;
      const page = yield* vault
        .call(
          "/account/act",
          {
            site,
            action,
            actor: bot.name,
            writes,
            origins: Store.originsOf(file, site),
            ...(signIn ? { signIn } : {}),
            ...(secret === undefined ? {} : { secret: { id: secret.id, name: secret.name } }),
          },
          AccountPage,
          { timeoutMs: 120_000 },
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new OrchestratorMcpFailure({
                code: e.unavailable ? "orchestration_error" : "invalid_request",
                message: e.message,
              }),
          ),
        );
      // A code is gone once typed; the grant keeps the go-ahead it gave until Sign out. The grant
      // is read again here: a Disconnect or switch during the typing wins.
      if (secret?.kind === "code" && grant.codeTyped !== true)
        yield* store
          .mutate((current) => {
            const live = current.accounts[site]?.find((g) => g.botThreadId === bot.threadId);
            if (live === undefined) return current;
            const marked = { ...live, codeTyped: true };
            return {
              ...current,
              accounts: {
                ...current.accounts,
                [site]: withGrant(current.accounts[site], bot.threadId, marked),
              },
            };
          })
          .pipe(Effect.mapError((e) => refuse(e.message)));
      if (page.challenge === undefined) return page;
      return yield* refuse(
        yield* requestCheck(scope, {
          url: page.url,
          challenge: page.challenge,
          browser: "account",
          site,
        }),
      );
    }),

    pending: store.read.pipe(Effect.map((file) => file.loginRequests)),

    choosePage: Effect.fn("Accounts.choosePage")(function* (secretId) {
      const card = (yield* secrets.list).find((s) => s.id === secretId);
      const site = card?.site;
      if (card === undefined || site === null || site === undefined || card.savedAt !== null)
        return yield* fail("This request no longer exists.");
      const bot = yield* bots.get(card.botThreadId);
      if (bot === undefined) return yield* fail("That bot does not exist.");
      yield* asFailure(
        store.mutate((file) => ({
          ...file,
          pageChosen: {
            ...file.pageChosen,
            [site]: [...new Set([...(file.pageChosen[site] ?? []), bot.threadId])],
          },
        })),
      );
      // Done on the sheet grants the account and wakes the bot, as for any sign-in request.
      const { request } = yield* putRequest(
        (_existing, id, createdAt) => ({
          id,
          site,
          url: `https://${site}/`,
          reason: card.reason,
          botThreadId: bot.threadId,
          writes: true,
          createdAt,
        }),
        bot,
        site,
      ).pipe(Effect.mapError((e) => fail(e.message)));
      for (const secret of yield* secrets.list)
        if (
          secret.id === card.id ||
          (card.request !== undefined && secret.request === card.request)
        )
          yield* secrets.remove(secret.id);
      return { site, requestId: request.id };
    }),

    dismiss: Effect.fn("Accounts.dismiss")((id) =>
      asFailure(
        store.mutate((file) => ({
          ...file,
          loginRequests: file.loginRequests.filter((r) => r.id !== id),
        })),
      ).pipe(Effect.asVoid),
    ),

    sheetOpen: Effect.fn("Accounts.sheetOpen")(function* ({ site, requestId }) {
      const request = (yield* store.read).loginRequests.find((r) => r.id === requestId);
      yield* asFailure(
        vault.call("/sheet/open", { site, url: request?.url ?? sheetUrl(site, undefined) }, Ok, {
          timeoutMs: 90_000,
        }),
      );
    }),
    sheetFrame: Effect.fn("Accounts.sheetFrame")((site, after) =>
      asFailure(vault.call("/sheet/frame", { site, after }, SheetFrame, { timeoutMs: 20_000 })),
    ),
    sheetViewport: Effect.fn("Accounts.sheetViewport")((site, viewport) =>
      asFailure(vault.call("/sheet/viewport", { site, ...viewport }, Ok)).pipe(Effect.asVoid),
    ),
    sheetInput: Effect.fn("Accounts.sheetInput")((site, input) =>
      asFailure(vault.call("/sheet/input", { site, input }, Ok)).pipe(Effect.asVoid),
    ),
    sheetClose: Effect.fn("Accounts.sheetClose")(function* (site, done) {
      yield* asFailure(vault.call("/sheet/close", { site, done }, Ok, { timeoutMs: 60_000 }));
      if (!done) return;
      // A check on the bot computer's screen is passed there, not in the account's sheet.
      const onSheet = (r: LoginRequest) => r.site === site && r.check?.browser !== "computer";
      const answered = (yield* store.read).loginRequests.filter(onSheet);
      yield* asFailure(
        store.mutate((file) => {
          const first = (file.accounts[site]?.length ?? 0) === 0;
          const added = [...new Set(answered.map((r) => r.botThreadId))]
            .filter((id) => !file.accounts[site]?.some((g) => g.botThreadId === id))
            .map((botThreadId) => ({ botThreadId, scheduledWrites: false }));
          const next = {
            ...file,
            accounts: { ...file.accounts, [site]: [...(file.accounts[site] ?? []), ...added] },
            loginRequests: file.loginRequests.filter((r) => !onSheet(r)),
          };
          return added.length === 0 || !first ? next : withCommonOrigins(next, site);
        }),
      );
      for (const request of answered) yield* continueAfter(request);
    }),

    grant: Effect.fn("Accounts.grant")(function* ({ site, botThreadId, granted, scheduledWrites }) {
      if (!(yield* bots.get(botThreadId))) return yield* fail("That bot does not exist.");
      yield* asFailure(
        store.mutate((file) => {
          const current = file.accounts[site]?.find((g) => g.botThreadId === botThreadId);
          const first = (file.accounts[site]?.length ?? 0) === 0;
          const next = {
            ...file,
            accounts: {
              ...file.accounts,
              [site]: withGrant(
                file.accounts[site],
                botThreadId,
                granted
                  ? {
                      ...current,
                      botThreadId,
                      scheduledWrites: scheduledWrites ?? current?.scheduledWrites ?? false,
                    }
                  : undefined,
              ),
            },
          };
          return granted && current === undefined && first ? withCommonOrigins(next, site) : next;
        }),
      );
    }),

    signOut: Effect.fn("Accounts.signOut")(function* (site) {
      yield* asFailure(vault.call("/account/sign-out", { site }, Ok, { timeoutMs: 60_000 }));
      // A kept login or a typed code would let the bot use the account again.
      yield* secrets.removeSite(site);
      yield* asFailure(
        store.mutate((file) => {
          const grants = file.accounts[site];
          if (grants === undefined) return file;
          const cleared = grants.map(({ codeTyped: _typed, ...grant }) => grant);
          return { ...file, accounts: { ...file.accounts, [site]: cleared } };
        }),
      );
    }),

    revoke: Effect.fn("Accounts.revoke")(function* (site) {
      // The vault wipes the sign-in first: if it fails, the account and its grants stay as they
      // are, so Connections shows what the vault still holds and Disconnect can be tried again.
      yield* asFailure(vault.call("/account/revoke", { site }, Ok, { timeoutMs: 60_000 }));
      yield* asFailure(
        store.mutate((file) => {
          const { [site]: _removed, ...accounts } = file.accounts;
          const { [site]: _origins, ...origins } = file.origins;
          const { [site]: _chosen, ...pageChosen } = file.pageChosen;
          return {
            ...file,
            accounts,
            origins,
            loginRequests: file.loginRequests.filter((r) => r.site !== site),
            pageChosen,
          };
        }),
      );
      yield* recordings.forget({ site });
      yield* secrets.removeSite(site);
    }),
  });
});

export const layer = Layer.effect(Accounts, make);

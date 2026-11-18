import {
  CONNECTION_FIELDS,
  CONNECTION_KINDS,
  type ConnectionKind,
  type MailAccount,
  type MailSortAction,
  OAUTH_SERVICE_LABEL,
  type OAuthService,
  type SheetInput,
  oauthClientMissing,
  type ThreadId,
  onSite,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { assetOriginsOf } from "./assetOrigins.ts";
import {
  allowedBy,
  type Browsers,
  type PageAction,
  type Pin,
  profileOf,
  type SecretKind,
  type Viewport,
} from "./browser.ts";
import type { Gmail } from "./gmail.ts";
import { type AccountFlow, googleAuthUrl, grantedReadonly, type makeFlows } from "./oauth.ts";
import { authorizeUrl, grantedAll, type OAuthClient, SERVICES } from "./services.ts";
import { scrubSecrets } from "./scrub.ts";
import type { Slack } from "./slack.ts";
import type { KeptLogin, VaultStore } from "./VaultStore.ts";

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  message: Schema.String,
}) {}

/**
 * The reads each API connector serves. A write (send, post, archive) is not in this table, so
 * the vault refuses it whatever asks.
 */
const READ_OPS = {
  gmail: ["mail_search", "mail_read", "feed"],
  slack: ["slack_unread", "slack_read", "feed"],
} as const satisfies Record<ConnectionKind, ReadonlyArray<string>>;

const isReadOp = (kind: ConnectionKind, op: string) =>
  (READ_OPS[kind] as ReadonlyArray<string>).includes(op);

export interface OpArgs {
  readonly query?: string | undefined;
  readonly id?: string | undefined;
  readonly channel?: string | undefined;
  readonly limit?: number | undefined;
  readonly sinceHours?: number | undefined;
}

/** Arguments of one call in a bot's OAuth account; each op reads the ones it needs. */
export interface AccountOpArgs {
  readonly query?: string | undefined;
  readonly id?: string | undefined;
  readonly limit?: number | undefined;
  readonly ids?: ReadonlyArray<string> | undefined;
  readonly action?: MailSortAction | undefined;
  readonly label?: string | undefined;
  readonly draftId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly to?: string | undefined;
  readonly cc?: string | undefined;
  readonly subject?: string | undefined;
  readonly body?: string | undefined;
  readonly replyTo?: string | undefined;
}

/**
 * The calls a bot's account serves. `send` is here for rejects' confirm only: no bot tool names
 * it, and the vault sends only the draft message the user confirmed.
 */
const ACCOUNT_OPS = {
  gmail: ["search", "read", "labels", "sort", "draft", "draft_get", "send"],
} as const satisfies Record<OAuthService, ReadonlyArray<string>>;
export type AccountOp = (typeof ACCOUNT_OPS)[OAuthService][number];

const GMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SORTED = 100;

export type AccountAction = PageAction & { readonly offset?: number | undefined };

const ACCOUNT_PAGE_CHARS = 12_000;
const TYPED_SECRETS_KEPT = 20;
/** A kept password is typed once in this window: a failed sign-in goes to the user, not a retry. */
export const PASSWORD_RETRY_MS = 30 * 60_000;

const clampLimit = (limit: number | undefined, max: number) =>
  Math.max(1, Math.min(max, Math.floor(limit ?? 10)));

const isWrite = (input: PageAction) =>
  input.action === "click" || input.action === "type" || input.action === "press";

const quoted = (text: string | null) => (text ? `"${text}"` : "an element");
/** An address as the audit keeps it: a form sent with GET carries its fields in the query. */
const auditUrl = (url: string) => url.replace(/[?#].*$/s, "");

export const makeVault = (deps: {
  readonly store: VaultStore;
  readonly flows: Effect.Success<typeof makeFlows>;
  readonly gmail: Gmail;
  readonly oauth: OAuthClient;
  readonly slack: Slack;
  readonly browsers: Browsers;
}) => {
  const { store, flows, gmail, oauth, slack, browsers } = deps;
  // Limited here, after the caller scrubbed it: a cut earlier could leave the front of a secret.
  const fail = (message: string) => new VaultError({ message: message.slice(0, 300) });
  const accessTokens = new Map<string, { token: string; expiresAt: number }>();

  const secret = (kind: ConnectionKind, field: string) =>
    store.getSecret(kind, field).pipe(
      Effect.mapError((e) => fail(e.message)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`${kind} is missing ${field}.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const markError = (kind: ConnectionKind, message: string) =>
    store.update(kind, (m) => ({ ...m, error: message })).pipe(Effect.ignore);

  const gmailToken = Effect.fn("Vault.gmailToken")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = accessTokens.get("gmail");
    if (cached && cached.expiresAt > now + 60_000) return cached.token;
    const refreshed = yield* gmail
      .refresh({
        clientId: yield* secret("gmail", "clientId"),
        clientSecret: yield* secret("gmail", "clientSecret"),
        refreshToken: yield* secret("gmail", "refreshToken"),
      })
      .pipe(
        Effect.tapError((e) => (e.reconnect ? markError("gmail", e.message) : Effect.void)),
        Effect.mapError((e) => fail(e.message)),
      );
    accessTokens.set("gmail", {
      token: refreshed.access_token,
      expiresAt: now + refreshed.expires_in * 1000,
    });
    return refreshed.access_token;
  });

  /** The account's access token, refreshed from its own refresh token when near expiry. */
  const accountToken = Effect.fn("Vault.accountToken")(function* (account: MailAccount) {
    const now = yield* Clock.currentTimeMillis;
    const key = `oauth:${account.id}`;
    const cached = accessTokens.get(key);
    if (cached && cached.expiresAt > now + 60_000) return cached.token;
    const refreshToken = yield* store.getOAuthToken(account.id).pipe(
      Effect.mapError((e) => fail(e.message)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`${account.address} has no token. Connect it again.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const client = SERVICES[account.service].client;
    const refreshed = yield* oauth
      .refresh(account.service, {
        clientId: yield* secret(client, "clientId"),
        clientSecret: yield* secret(client, "clientSecret"),
        refreshToken,
      })
      .pipe(
        Effect.tapError((e) =>
          e.reconnect
            ? store
                .updateOAuthAccount(account.id, (a) => a && { ...a, error: e.message })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.mapError((e) => fail(e.message)),
      );
    accessTokens.set(key, {
      token: refreshed.access_token,
      expiresAt: now + refreshed.expires_in * 1000,
    });
    return refreshed.access_token;
  });

  /** One Gmail call in a bot's account. Ids are checked before they reach a URL. */
  const gmailOp = Effect.fn("Vault.gmailOp")(function* (
    account: MailAccount,
    op: AccountOp,
    args: AccountOpArgs,
  ): Effect.fn.Return<unknown, VaultError> {
    const token = yield* accountToken(account);
    const mapped = <A, E extends { readonly message: string; readonly reconnect: boolean }>(
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.tapError((e) =>
          e.reconnect
            ? store
                .updateOAuthAccount(account.id, (a) => a && { ...a, error: e.message })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.mapError((e) => fail(e.message)),
      );
    const id = (value: string | undefined, what: string) =>
      value !== undefined && GMAIL_ID.test(value)
        ? Effect.succeed(value)
        : Effect.fail(fail(`${op} needs ${what}.`));
    switch (op) {
      case "search":
        return yield* mapped(
          gmail.search(token, args.query ?? "in:inbox", clampLimit(args.limit, 25)),
        );
      case "read":
        return yield* mapped(gmail.read(token, yield* id(args.id, "a message id from search")));
      case "labels":
        return (yield* mapped(gmail.labels(token))).map((l) => ({ id: l.id, name: l.name }));
      case "sort": {
        const ids = args.ids ?? [];
        if (ids.length === 0 || ids.length > MAX_SORTED || !ids.every((i) => GMAIL_ID.test(i)))
          return yield* fail(`sort needs 1 to ${MAX_SORTED} message ids from search.`);
        const action = args.action;
        if (action === "trash" || action === "untrash") {
          yield* Effect.forEach(
            ids,
            (messageId) => mapped(gmail.trash(token, messageId, action === "untrash")),
            { concurrency: 4, discard: true },
          );
          return { done: action, count: ids.length };
        }
        const system = { archive: "INBOX", inbox: "INBOX", read: "UNREAD", unread: "UNREAD" };
        if (action === "archive" || action === "read")
          yield* mapped(gmail.modify(token, ids, [], [system[action]]));
        else if (action === "inbox" || action === "unread")
          yield* mapped(gmail.modify(token, ids, [system[action]], []));
        else if (action === "label" || action === "unlabel") {
          const name = args.label?.trim() ?? "";
          if (name.length === 0 || name.length > 200)
            return yield* fail(`${action} needs a label.`);
          const existing = (yield* mapped(gmail.labels(token))).find(
            (l) => l.id === name || l.name.toLowerCase() === name.toLowerCase(),
          );
          if (existing === undefined && action === "unlabel")
            return yield* fail(`There is no label ${name}.`);
          const labelId = existing?.id ?? (yield* mapped(gmail.createLabel(token, name))).id;
          yield* mapped(
            action === "label"
              ? gmail.modify(token, ids, [labelId], [])
              : gmail.modify(token, ids, [], [labelId]),
          );
        } else return yield* fail("sort needs an action.");
        return { done: action, count: ids.length };
      }
      case "draft": {
        if (!args.to || args.subject === undefined || args.body === undefined)
          return yield* fail("A draft needs to, subject and body.");
        const draftId =
          args.draftId === undefined ? undefined : yield* id(args.draftId, "a draft id");
        const replyTo =
          args.replyTo === undefined ? undefined : yield* id(args.replyTo, "a message id");
        return yield* mapped(
          gmail.saveDraft(token, draftId, {
            to: args.to,
            cc: args.cc,
            subject: args.subject,
            body: args.body,
            replyTo,
          }),
        );
      }
      case "draft_get":
        return yield* mapped(gmail.draft(token, yield* id(args.draftId, "a draft id")));
      case "send": {
        const draftId = yield* id(args.draftId, "a draft id");
        const current = yield* mapped(gmail.draft(token, draftId));
        // An edit after the user saw the draft gives it a new message id: that is not what they confirmed.
        if (current.messageId !== args.messageId)
          return yield* fail("The draft changed after the user saw it. Ask again.");
        return yield* mapped(gmail.sendDraft(token, draftId));
      }
    }
  });

  /** Removes an account's token here, and the grant at the provider unless another bot uses it. */
  const dropAccount = Effect.fn("Vault.dropAccount")(function* (account: MailAccount) {
    const shared = store
      .oauthAccounts()
      .some(
        (other) =>
          other.id !== account.id &&
          other.service === account.service &&
          other.address === account.address,
      );
    const token = yield* store
      .getOAuthToken(account.id)
      .pipe(Effect.orElseSucceed(() => Option.none<string>()));
    // One client and Google user share one grant: revoking it would end the other bot's too.
    if (Option.isSome(token) && !shared) yield* oauth.revoke(account.service, token.value);
    yield* store.removeOAuthToken(account.id).pipe(Effect.ignore);
    accessTokens.delete(`oauth:${account.id}`);
    yield* store
      .updateOAuthAccount(account.id, () => undefined)
      .pipe(Effect.mapError((e) => fail(e.message)));
  });

  /** Finishes a bot's connect: the account is stored for that bot, a reconnect replaces its token. */
  const accountCallback = Effect.fn("Vault.accountCallback")(function* (
    flow: AccountFlow,
    input: { readonly code?: string | undefined; readonly error?: string | undefined },
  ) {
    const label = OAUTH_SERVICE_LABEL[flow.service];
    if (input.error !== undefined || input.code === undefined)
      return yield* fail(`${label} did not grant access${input.error ? ` (${input.error})` : ""}.`);
    if (store.redirectUri === null) return yield* fail("The vault has no redirect URI configured.");
    const client = SERVICES[flow.service].client;
    const tokens = yield* oauth
      .exchange(flow.service, {
        clientId: yield* secret(client, "clientId"),
        clientSecret: yield* secret(client, "clientSecret"),
        code: input.code,
        verifier: flow.verifier,
        redirectUri: store.redirectUri,
      })
      .pipe(Effect.mapError((e) => fail(e.message)));
    if (!grantedAll(flow.service, tokens.scope)) {
      if (tokens.refresh_token !== undefined)
        yield* oauth.revoke(flow.service, tokens.refresh_token);
      return yield* fail(
        `Tick every box on ${label}'s page: the bot needs to read, sort and draft. Ask the bot for a new link.`,
      );
    }
    if (tokens.refresh_token === undefined)
      return yield* fail(`${label} sent no refresh token. Ask the bot for a new link.`);
    const address = yield* gmail
      .profile(tokens.access_token)
      .pipe(Effect.mapError((e) => fail(e.message)));
    const existing = store
      .oauthAccounts()
      .find(
        (a) =>
          a.service === flow.service && a.botThreadId === flow.botThreadId && a.address === address,
      );
    const id = existing?.id ?? (yield* store.newId);
    yield* store
      .setOAuthToken(id, tokens.refresh_token)
      .pipe(Effect.mapError((e) => fail(e.message)));
    const at = yield* store.now;
    const account: MailAccount = {
      id,
      service: flow.service,
      botThreadId: flow.botThreadId,
      address,
      connectedAt: at,
      lastUsedAt: existing?.lastUsedAt ?? null,
      error: null,
    };
    yield* store
      .updateOAuthAccount(id, () => account)
      .pipe(Effect.mapError((e) => fail(e.message)));
    const now = yield* Clock.currentTimeMillis;
    accessTokens.set(`oauth:${id}`, {
      token: tokens.access_token,
      expiresAt: now + tokens.expires_in * 1000,
    });
    yield* audit(`${flow.service}:${address}`, "connect", "user", "ok", null);
    return { kind: "account" as const, account, writes: flow.writes };
  });

  /** Runs one read. Results are data from outside; the caller marks them untrusted. */
  const execute = Effect.fn("Vault.execute")(function* (
    kind: ConnectionKind,
    op: string,
    args: OpArgs,
  ): Effect.fn.Return<unknown, VaultError> {
    switch (kind) {
      case "gmail": {
        const token = yield* gmailToken();
        const mapped = <A, E extends { readonly message: string; readonly reconnect: boolean }>(
          effect: Effect.Effect<A, E>,
        ) =>
          effect.pipe(
            Effect.tapError((e) => (e.reconnect ? markError("gmail", e.message) : Effect.void)),
            Effect.mapError((e) => fail(e.message)),
          );
        if (op === "mail_search")
          return yield* mapped(
            gmail.search(token, args.query ?? "in:inbox", clampLimit(args.limit, 25)),
          );
        if (op === "mail_read") {
          if (!args.id || !/^[A-Za-z0-9]{1,64}$/.test(args.id))
            return yield* fail("mail_read needs a message id from mail_search.");
          return yield* mapped(gmail.read(token, args.id));
        }
        return yield* mapped(gmail.feed(token));
      }
      case "slack": {
        const token = yield* secret("slack", "token");
        const mapped = <A, E extends { readonly message: string; readonly reconnect: boolean }>(
          effect: Effect.Effect<A, E>,
        ) =>
          effect.pipe(
            Effect.tapError((e) => (e.reconnect ? markError("slack", e.message) : Effect.void)),
            Effect.mapError((e) => fail(e.message)),
          );
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (op === "slack_read") {
          if (!args.channel || !/^[A-Z0-9]{1,20}$/.test(args.channel))
            return yield* fail("slack_read needs a channel id from slack_unread.");
          return yield* mapped(slack.read(token, args.channel, clampLimit(args.limit, 50)));
        }
        if (op === "slack_unread")
          return yield* mapped(
            slack.unread(token, nowSeconds - Math.min(args.sinceHours ?? 24, 168) * 3600),
          );
        return yield* mapped(slack.feed(token, nowSeconds));
      }
    }
  });

  const countOf = (value: unknown) =>
    Array.isArray(value)
      ? value.length
      : Array.isArray((value as { items?: unknown } | undefined)?.items)
        ? (value as { items: ReadonlyArray<unknown> }).items.length
        : null;

  const now = store.now;
  const typedSecrets = new Map<string, string>();
  /** Codes are typed once and live only here. */
  const codes = new Map<string, { readonly site: string; readonly value: string }>();
  /** A typed password by site, until a page shows it was taken (no sign-in form) or refused. */
  const pendingSignIn = new Map<string, string>();
  const audit = (
    connection: string,
    op: string,
    actor: string,
    status: "ok" | "refused" | "failed",
    detail: string | null,
  ) => store.audit({ connection, op, actor, status, count: null, detail });

  const loginOf = (
    id: string,
  ): Effect.Effect<
    Option.Option<{ site: string; kind: SecretKind; value: string; typedAt?: number | undefined }>,
    VaultError
  > => {
    const code = codes.get(id);
    return code !== undefined
      ? Effect.succeedSome({ ...code, kind: "code" })
      : store.getLogin(id).pipe(Effect.mapError((e) => fail(e.message)));
  };
  /** Updates a kept password's typing record; a refused one may be asked for again. */
  const markPassword = (id: string, mark: Pick<KeptLogin, "typedAt" | "failed">) =>
    store.getLogin(id).pipe(
      Effect.flatMap((login) =>
        Option.isSome(login) && login.value.kind === "password"
          ? store.setLogin(id, { ...login.value, ...mark })
          : Effect.void,
      ),
      Effect.ignore({ log: true }),
    );

  const signedIn = (site: string) => {
    const account = store.account(site);
    if (account === undefined)
      return `${site} is not an account. Call request_login to ask the user to sign in.`;
    if (account.signedInAt === null)
      return `The user signed out of ${site}. Call request_login to ask them to sign in again.`;
    return undefined;
  };

  return {
    state: Effect.sync(() => ({
      redirectUri: store.redirectUri,
      connections: CONNECTION_KINDS.map((kind) => store.view(kind)),
      accounts: store.accounts(),
      oauthAccounts: store.oauthAccounts(),
    })),

    /**
     * A one-time connect link for a bot: the handle only, on the redirect URI's origin. Refused
     * until the service's OAuth client is pasted.
     */
    link: Effect.fn("Vault.link")(function* (input: {
      readonly service: OAuthService;
      readonly botThreadId: ThreadId;
      readonly writes: boolean;
    }) {
      if (store.redirectUri === null)
        return yield* fail("The vault has no redirect URI configured.");
      const client = SERVICES[input.service].client;
      const missing = fail(oauthClientMissing(input.service));
      yield* secret(client, "clientId").pipe(Effect.mapError(() => missing));
      yield* secret(client, "clientSecret").pipe(Effect.mapError(() => missing));
      const link = yield* flows.link(input);
      return { ...link, origin: new URL(store.redirectUri).origin };
    }),
    /** What an unopened link connects, for the page that asks to continue. */
    linkPeek: Effect.fn("Vault.linkPeek")(function* (handle: string) {
      const flow = yield* flows.peek(handle);
      if (flow === undefined)
        return yield* fail("This link expired or was already used. Ask the bot for a new one.");
      return { service: flow.service, botThreadId: flow.botThreadId };
    }),
    /** Uses the link up and returns the provider's consent page for its flow. */
    linkOpen: Effect.fn("Vault.linkOpen")(function* (handle: string) {
      const opened = yield* flows.open(handle);
      if (opened === undefined || store.redirectUri === null)
        return yield* fail("This link expired or was already used. Ask the bot for a new one.");
      const { state, flow } = opened;
      return {
        authUrl: authorizeUrl(flow.service, {
          clientId: yield* secret(SERVICES[flow.service].client, "clientId"),
          redirectUri: store.redirectUri,
          state,
          challenge: flow.challenge,
        }),
      };
    }),

    /**
     * One call in a bot's own account, audited without content. The account must belong to that
     * bot; rejects has already checked the bot may use the service.
     */
    accountOp: Effect.fn("Vault.accountOp")(function* (input: {
      readonly accountId: string;
      readonly botThreadId: ThreadId;
      readonly op: string;
      readonly args: AccountOpArgs;
      readonly actor: string;
    }) {
      const account = store.oauthAccount(input.accountId);
      if (account === undefined || account.botThreadId !== input.botThreadId)
        return yield* fail("That account is not connected to this bot.");
      const connection = `${account.service}:${account.address}`;
      if (!(ACCOUNT_OPS[account.service] as ReadonlyArray<string>).includes(input.op)) {
        yield* audit(connection, input.op, input.actor, "refused", "unknown op");
        return yield* fail(`${OAUTH_SERVICE_LABEL[account.service]} has no ${input.op}.`);
      }
      const op = input.op as AccountOp;
      const result = yield* gmailOp(account, op, input.args).pipe(
        Effect.tapError((e) => audit(connection, op, input.actor, "failed", e.message)),
      );
      const at = yield* store.now;
      yield* store
        .updateOAuthAccount(account.id, (a) => a && { ...a, lastUsedAt: at, error: null })
        .pipe(Effect.ignore);
      yield* store.audit({
        connection,
        op: op === "sort" ? `sort ${input.args.action ?? ""}`.trim() : op,
        actor: input.actor,
        status: "ok",
        count: op === "sort" ? (input.args.ids?.length ?? null) : countOf(result),
        detail: null,
      });
      return result;
    }),

    /** Revokes and deletes one bot account. Unknown ids succeed: the account is gone either way. */
    accountDisconnect: Effect.fn("Vault.accountDisconnect")(function* (accountId: string) {
      const account = store.oauthAccount(accountId);
      if (account === undefined) return;
      yield* dropAccount(account);
      yield* audit(`${account.service}:${account.address}`, "disconnect", "user", "ok", null);
    }),
    audit: store.readAudit,

    /** Stores a write-only field. A Slack token is checked first and refused if it can write. */
    setField: Effect.fn("Vault.setField")(function* (
      kind: ConnectionKind,
      field: string,
      value: string,
    ) {
      if (!(CONNECTION_FIELDS[kind] as ReadonlyArray<string>).includes(field))
        return yield* fail(`${kind} has no field ${field}.`);
      const trimmed = value.trim();
      if (kind === "slack") {
        const account = yield* slack.check(trimmed).pipe(Effect.mapError((e) => fail(e.message)));
        yield* store.setSecret(kind, field, trimmed).pipe(Effect.mapError((e) => fail(e.message)));
        const at = yield* store.now;
        yield* store
          .update(kind, (m) => ({ ...m, account, connectedAt: at, error: null }))
          .pipe(Effect.mapError((e) => fail(e.message)));
      } else {
        yield* store.setSecret(kind, field, trimmed).pipe(Effect.mapError((e) => fail(e.message)));
      }
      yield* store.audit({
        connection: kind,
        op: `set ${field}`,
        actor: "user",
        status: "ok",
        count: null,
        detail: null,
      });
    }),

    start: Effect.fn("Vault.start")(function* (kind: "gmail") {
      if (store.redirectUri === null)
        return yield* fail("The vault has no redirect URI configured.");
      const clientId = yield* secret(kind, "clientId").pipe(
        Effect.mapError(() => fail("Paste the Google client ID and secret first.")),
      );
      yield* secret(kind, "clientSecret").pipe(
        Effect.mapError(() => fail("Paste the Google client ID and secret first.")),
      );
      const flow = yield* flows.start(kind).pipe(Effect.mapError(() => fail("Could not start.")));
      return {
        authUrl: googleAuthUrl({
          clientId,
          redirectUri: store.redirectUri,
          state: flow.state,
          challenge: flow.challenge,
        }),
      };
    }),

    callback: Effect.fn("Vault.callback")(function* (input: {
      readonly state: string;
      readonly code?: string | undefined;
      readonly scope?: string | undefined;
      readonly error?: string | undefined;
    }) {
      const flow = yield* flows.consume(input.state);
      if (flow === undefined)
        return yield* fail(
          "This sign-in link expired or was already used. Start again in rejects.",
        );
      if (flow.kind === "account") return yield* accountCallback(flow, input);
      if (input.error !== undefined || input.code === undefined)
        return yield* fail(`Google did not grant access${input.error ? ` (${input.error})` : ""}.`);
      if (!grantedReadonly(input.scope))
        return yield* fail(
          'Tick "View your email messages and settings" on Google\'s page. Start again in rejects.',
        );
      if (store.redirectUri === null)
        return yield* fail("The vault has no redirect URI configured.");
      const tokens = yield* gmail
        .exchange({
          clientId: yield* secret("gmail", "clientId"),
          clientSecret: yield* secret("gmail", "clientSecret"),
          code: input.code,
          verifier: flow.verifier,
          redirectUri: store.redirectUri,
        })
        .pipe(Effect.mapError((e) => fail(e.message)));
      if (tokens.refresh_token === undefined)
        return yield* fail(
          "Google sent no refresh token. Remove rejects at myaccount.google.com/permissions and connect again.",
        );
      if (!grantedReadonly(tokens.scope))
        return yield* fail(
          "Google did not grant the read-only Gmail scope. Start again in rejects.",
        );
      const account = yield* gmail
        .profile(tokens.access_token)
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* store
        .setSecret("gmail", "refreshToken", tokens.refresh_token)
        .pipe(Effect.mapError((e) => fail(e.message)));
      const now = yield* Clock.currentTimeMillis;
      accessTokens.set("gmail", {
        token: tokens.access_token,
        expiresAt: now + tokens.expires_in * 1000,
      });
      const at = yield* store.now;
      yield* store
        .update("gmail", (m) => ({ ...m, account, connectedAt: at, error: null, paused: false }))
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* store.audit({
        connection: "gmail",
        op: "connect",
        actor: "user",
        status: "ok",
        count: null,
        detail: null,
      });
      return { kind: "gmail" as const, account };
    }),

    disconnect: Effect.fn("Vault.disconnect")(function* (kind: ConnectionKind) {
      if (kind === "gmail") {
        const refresh = yield* store
          .getSecret("gmail", "refreshToken")
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        if (Option.isSome(refresh)) yield* gmail.revoke(refresh.value);
        yield* store.removeSecret("gmail", "refreshToken").pipe(Effect.ignore);
        accessTokens.delete("gmail");
      }
      if (kind === "slack") {
        const token = yield* store
          .getSecret("slack", "token")
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        if (Option.isSome(token)) yield* slack.revoke(token.value);
        yield* store.removeSecret("slack", "token").pipe(Effect.ignore);
      }
      yield* store
        .update(kind, (m) => ({
          ...m,
          account: null,
          connectedAt: null,
          error: null,
          paused: false,
          // The Google client stays so a reconnect needs no new paste; a Slack token does not.
          fields: kind === "slack" ? {} : m.fields,
        }))
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* store.audit({
        connection: kind,
        op: "disconnect",
        actor: "user",
        status: "ok",
        count: null,
        detail: null,
      });
    }),

    pause: (kind: ConnectionKind, paused: boolean) =>
      store
        .update(kind, (m) => ({ ...m, paused }))
        .pipe(
          Effect.tap(() =>
            store.audit({
              connection: kind,
              op: paused ? "pause" : "resume",
              actor: "user",
              status: "ok",
              count: null,
              detail: null,
            }),
          ),
          Effect.mapError((e) => fail(e.message)),
          Effect.asVoid,
        ),

    op: Effect.fn("Vault.op")(function* (
      kind: ConnectionKind,
      op: string,
      args: OpArgs,
      actor: string,
    ) {
      const refuse = (detail: string, message: string) =>
        store
          .audit({ connection: kind, op, actor, status: "refused", count: null, detail })
          .pipe(Effect.andThen(Effect.fail(fail(message))));
      if (!isReadOp(kind, op))
        return yield* refuse(
          "not a read",
          "Only reads run in the vault. Posting, sending or changing anything needs the user's confirmation in rejects.",
        );
      const meta = store.meta(kind);
      if (meta.paused) return yield* refuse("paused", `The user paused ${kind}.`);
      if (meta.account === null)
        return yield* refuse("not connected", `${kind} is not connected yet.`);
      const result = yield* execute(kind, op, args).pipe(
        Effect.tapError((e) =>
          store.audit({
            connection: kind,
            op,
            actor,
            status: "failed",
            count: null,
            detail: e.message,
          }),
        ),
      );
      const at = yield* store.now;
      yield* store.update(kind, (m) => ({ ...m, lastUsedAt: at, error: null })).pipe(Effect.ignore);
      yield* store.audit({
        connection: kind,
        op,
        actor,
        status: "ok",
        count: countOf(result),
        detail: null,
      });
      return result;
    }),

    sheetOpen: Effect.fn("Vault.sheetOpen")(function* (site: string, url: string) {
      const at = yield* now;
      yield* store
        .updateAccount(
          site,
          (account) => account ?? { createdAt: at, signedInAt: null, lastUsedAt: null },
        )
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* browsers
        .openSheet(profileOf(site), onSite(url, site) ? url : `https://${site}/`)
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* audit(site, "sheet", "user", "ok", null);
    }),
    sheetFrame: (site: string, after: number) =>
      browsers.frame(profileOf(site), after).pipe(Effect.mapError((e) => fail(e.message))),
    sheetViewport: (site: string, viewport: Viewport) =>
      browsers.viewport(profileOf(site), viewport).pipe(Effect.mapError((e) => fail(e.message))),
    sheetInput: (site: string, input: SheetInput) =>
      browsers.input(profileOf(site), input).pipe(Effect.mapError((e) => fail(e.message))),
    sheetClose: Effect.fn("Vault.sheetClose")(function* (site: string, done: boolean) {
      yield* browsers.closeSheet(profileOf(site)).pipe(Effect.ignore);
      if (!done || store.account(site) === undefined) return;
      const at = yield* now;
      yield* store
        .updateAccount(site, (account) => account && { ...account, signedInAt: at })
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* audit(site, "sign in", "user", "ok", null);
    }),
    signOut: Effect.fn("Vault.signOut")(function* (site: string) {
      if (store.account(site) === undefined) return yield* fail(`${site} is not an account.`);
      yield* store
        .updateAccount(site, (account) => account && { ...account, signedInAt: null })
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* browsers.wipe(profileOf(site)).pipe(Effect.mapError((e) => fail(e.message)));
      yield* audit(site, "sign out", "user", "ok", null);
    }),
    /**
     * Ends the account: no action runs from the first step on, then the profile is deleted and
     * the account forgotten. A failed delete keeps it signed out so the user can try again.
     */
    revoke: Effect.fn("Vault.revoke")(function* (site: string) {
      if (store.account(site) === undefined) return;
      yield* store
        .updateAccount(site, (account) => account && { ...account, signedInAt: null })
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* browsers.wipe(profileOf(site)).pipe(
        Effect.tapError((e) => audit(site, "revoke", "user", "failed", e.message)),
        Effect.mapError((e) => fail(`Signed out, but the profile was not deleted: ${e.message}`)),
      );
      yield* store
        .updateAccount(site, () => undefined)
        .pipe(Effect.mapError((e) => fail(e.message)));
      yield* audit(site, "revoke", "user", "ok", null);
    }),
    /** A login the user typed into a bot's card; a code is kept in memory for one typing. */
    loginSet: Effect.fn("Vault.loginSet")(function* (
      input: { readonly id: string } & Pick<KeptLogin, "site" | "value"> & {
          readonly kind: KeptLogin["kind"] | "code";
        },
    ) {
      const { id, site, value } = input;
      if (input.kind === "code") {
        yield* store.removeLogin(id).pipe(Effect.mapError((e) => fail(e.message)));
        codes.set(id, { site, value });
      } else {
        codes.delete(id);
        yield* store
          .setLogin(id, { site, kind: input.kind, value })
          .pipe(Effect.mapError((e) => fail(e.message)));
      }
      yield* audit(site, `save ${input.kind}`, "user", "ok", null);
    }),
    loginFailed: Effect.fn("Vault.loginFailed")(function* (id: string) {
      const login = yield* store.getLogin(id).pipe(Effect.mapError((e) => fail(e.message)));
      return { failed: Option.isSome(login) && login.value.failed === true };
    }),
    loginRemove: Effect.fn("Vault.loginRemove")(function* (id: string) {
      codes.delete(id);
      yield* store.removeLogin(id).pipe(Effect.mapError((e) => fail(e.message)));
    }),
    /**
     * A secret is audited by name only. Navigations stay on the site and its allowed origins, and every one stopped is audited as refused.
     * A run that may not write follows links but does not click, type or press.
     */
    act: Effect.fn("Vault.act")(function* (input: {
      readonly site: string;
      readonly action: AccountAction;
      readonly actor: string;
      readonly writes: boolean;
      readonly origins?: ReadonlyArray<string> | undefined;
      /** A kept login or code by its id; the vault holds the value and the host it is typed on. */
      readonly secret?: { readonly id: string; readonly name: string } | undefined;
      /** The bot holds a login for this site, so it may use the account before it is signed in. */
      readonly signIn?: boolean | undefined;
    }) {
      const { site, actor, writes, secret } = input;
      const pin: Pin = { site, origins: input.origins ?? [], assets: assetOriginsOf(site) };
      const login = secret === undefined ? Option.none() : yield* loginOf(secret.id);
      if (Option.isSome(login)) {
        typedSecrets.delete(login.value.value);
        typedSecrets.set(login.value.value, secret?.name ?? "");
        for (const [value] of typedSecrets)
          if (typedSecrets.size > TYPED_SECRETS_KEPT) typedSecrets.delete(value);
      }
      // A typed secret can turn up in a field label, an error or a page address, in any later
      // action; nothing that goes to the bot or the audit log leaves it in.
      const scrub = (text: string) => scrubSecrets(text, typedSecrets);
      const refuse = (detail: string, message: string) =>
        audit(site, input.action.action, actor, "refused", scrub(detail)).pipe(
          Effect.andThen(Effect.fail(fail(scrub(message)))),
        );
      const unusable = signedIn(site);
      if (unusable !== undefined) {
        if (input.signIn !== true) return yield* refuse("no account", unusable);
        const at = yield* now;
        yield* store
          .updateAccount(
            site,
            (account) => account ?? { createdAt: at, signedInAt: null, lastUsedAt: null },
          )
          .pipe(Effect.mapError((e) => fail(e.message)));
      }
      let action: PageAction = input.action;
      if (action.action === "open" && !allowedBy(pin, action.url))
        return yield* refuse(
          `off allowlist: ${auditUrl(action.url)}`,
          `${action.url} is not on ${site} or a site the user allowed for it. With an account you stay there; use web_browse without account elsewhere.`,
        );
      if (secret !== undefined) {
        if (action.action !== "type") return yield* refuse("secret", "A secret is only typed.");
        if (Option.isNone(login))
          return yield* refuse(
            `secret "${secret.name}" gone`,
            `Secret "${secret.name}" is gone (a code is typed once). Ask the user again with ask_secret.`,
          );
        const typedAt = login.value.kind === "password" ? login.value.typedAt : undefined;
        const clock = yield* Clock.currentTimeMillis;
        if (
          login.value.kind === "password" &&
          typedAt !== undefined &&
          clock - typedAt < PASSWORD_RETRY_MS
        )
          return yield* refuse(
            `secret "${secret.name}" again`,
            `You typed saved password "${secret.name}" ${Math.max(1, Math.round((clock - typedAt) / 60_000))} min ago. If that sign-in failed, do not type it again: call request_login so the user signs in.`,
          );
        action = {
          ...action,
          text: login.value.value,
          secret: { site: login.value.site, kind: login.value.kind },
        };
      }
      const profile = profileOf(site);
      if (!writes && action.action === "click") {
        // Read-only runs follow allowed links as plain page loads, so no page script acts.
        const href = yield* browsers
          .linkOf(profile, pin, action.ref)
          .pipe(Effect.mapError((e) => fail(scrub(e.message))));
        if (href !== null && allowedBy(pin, href)) action = { action: "open", url: href };
      }
      if (!writes && isWrite(action))
        return yield* refuse(
          "read-only run",
          `This run may only read ${site}: it was not started by the user's own message. Ask the user, or they can allow writes on schedules for you in Connections.`,
        );
      const page = yield* browsers.act(profile, pin, action).pipe(
        Effect.tapError((e) => audit(site, action.action, actor, "failed", scrub(e.message))),
        // A password the field refuses may be mislabeled (a value saved before kinds existed is
        // kept as a password), so the bot may ask the user for it again.
        Effect.tapError((e) =>
          e.wrongField === true && secret !== undefined
            ? markPassword(secret.id, { failed: true })
            : Effect.void,
        ),
        Effect.mapError((e) => fail(scrub(e.message))),
      );
      const typed = secret === undefined ? null : `secret "${secret.name}"`;
      const landed = auditUrl(page.url);
      const detail =
        action.action === "type"
          ? `${typed ?? `"${action.text}"`} into ${quoted(page.element)}${action.submit ? " + Enter" : ""} · ${landed}`
          : action.action === "click"
            ? `${quoted(page.element)} · ${landed}`
            : action.action === "press"
              ? `${action.key} · ${landed}`
              : landed;
      yield* audit(site, action.action, actor, "ok", scrub(detail));
      if (page.blocked)
        yield* audit(
          site,
          "navigate",
          actor,
          "refused",
          scrub(`off allowlist: ${auditUrl(page.blocked)}`),
        );
      if (page.challenge)
        yield* audit(site, "check", actor, "refused", scrub(`${page.challenge.label} · ${landed}`));
      const at = yield* now;
      const kind = Option.isSome(login) ? login.value.kind : undefined;
      if (secret !== undefined && kind === "code") codes.delete(secret.id);
      if (secret !== undefined && kind === "password") {
        yield* markPassword(secret.id, { typedAt: yield* Clock.currentTimeMillis });
        pendingSignIn.set(site, secret.id);
      }
      // Signed in only once a page shows no sign-in form after the password; a submit that leaves
      // the password field on the page means the site refused it.
      const pending = pendingSignIn.get(site);
      const fillingIn = action.action === "type" && !action.submit;
      let signedInNow = false;
      if (pending !== undefined && !fillingIn && !page.challenge && !page.blocked) {
        if (page.form === null) {
          signedInNow = true;
          pendingSignIn.delete(site);
          yield* markPassword(pending, { failed: false });
        } else if (page.form === "password" && isWrite(action)) {
          pendingSignIn.delete(site);
          yield* markPassword(pending, { failed: true });
        }
      }
      yield* store
        .updateAccount(
          site,
          (account) =>
            account && { ...account, lastUsedAt: at, ...(signedInNow ? { signedInAt: at } : {}) },
        )
        .pipe(Effect.ignore);
      const offset = input.action.action === "snapshot" ? (input.action.offset ?? 0) : 0;
      const end = offset + ACCOUNT_PAGE_CHARS;
      // Scrubbed whole before slicing, so a secret cut by the page boundary is still caught.
      const text = scrub(page.text);
      return {
        url: scrub(page.url),
        title: scrub(page.title),
        snapshot: text.slice(offset, end),
        ...(end < text.length ? { nextOffset: end } : {}),
        ...(page.blocked
          ? {
              blocked: `Stopped a page or popup off ${site} and its allowed sites: ${scrub(page.blocked).slice(0, 200)}`,
            }
          : {}),
        ...(page.challenge
          ? { challenge: { ...page.challenge, label: scrub(page.challenge.label) } }
          : {}),
      };
    }),
  };
};
export type Vault = ReturnType<typeof makeVault>;

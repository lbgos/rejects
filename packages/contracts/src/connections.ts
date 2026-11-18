/** No endpoint here returns a secret. */
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";

export const ConnectionKind = Schema.Literals(["gmail", "slack"]);
export type ConnectionKind = typeof ConnectionKind.Type;
export const CONNECTION_KINDS: ReadonlyArray<ConnectionKind> = ["gmail", "slack"];
export const isConnectionKind = Schema.is(ConnectionKind);

/** Write-only fields per kind. The UI only ever learns when each was set. */
export const CONNECTION_FIELDS = {
  gmail: ["clientId", "clientSecret"],
  slack: ["token"],
} as const satisfies Record<ConnectionKind, ReadonlyArray<string>>;

export const CONNECTION_LABEL = {
  gmail: "Gmail",
  slack: "Slack",
} as const satisfies Record<ConnectionKind, string>;

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

/**
 * Services a bot connects its own accounts to through OAuth, several per bot. The bot mints a
 * one-time link in chat; the vault keeps each account's refresh token. Endpoints and scopes live
 * in the vault's registry (`apps/server/src/vault/services.ts`).
 */
export const OAuthService = Schema.Literals(["gmail"]);
export type OAuthService = typeof OAuthService.Type;
export const OAUTH_SERVICE_LABEL = {
  gmail: "Gmail",
} as const satisfies Record<OAuthService, string>;

/** The vault's refusal while a service's OAuth client is missing; the server matches it exactly. */
export const oauthClientMissing = (service: OAuthService) =>
  `The ${OAUTH_SERVICE_LABEL[service]} OAuth client is not set up. The owner pastes it in rejects → Connections.`;

/** What a bot does to messages in its own Gmail account; each has its way back. */
export const MAIL_SORT_ACTIONS = [
  "archive",
  "inbox",
  "read",
  "unread",
  "label",
  "unlabel",
  "trash",
  "untrash",
] as const;
export type MailSortAction = (typeof MAIL_SORT_ACTIONS)[number];

/** One connected account of a bot. The address is the only thing about it the chat shows. */
export const MailAccount = Schema.Struct({
  id: Schema.String,
  service: OAuthService,
  botThreadId: ThreadId,
  address: Schema.String,
  connectedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** The last call failed for this reason; a revoked grant needs a new link. */
  error: Schema.NullOr(Schema.String),
});
export type MailAccount = typeof MailAccount.Type;

/**
 * A draft a bot asked to send. Only the user's confirm sends it, and only while the draft is the
 * one they saw: `messageId` changes whenever the draft is edited.
 */
export const MailSendRequest = Schema.Struct({
  id: Schema.String,
  botThreadId: ThreadId,
  accountId: Schema.String,
  address: Schema.String,
  draftId: Schema.String,
  messageId: Schema.String,
  /** The draft's To, Cc and Bcc headers in full: everyone the send reaches. */
  to: Schema.String,
  cc: Schema.optionalKey(Schema.String),
  bcc: Schema.optionalKey(Schema.String),
  subject: Schema.String,
  status: Schema.Literals(["pending", "sent", "denied", "failed"]),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type MailSendRequest = typeof MailSendRequest.Type;

export const MailState = Schema.Struct({
  accounts: Schema.Array(MailAccount),
  sends: Schema.Array(MailSendRequest),
});
export type MailState = typeof MailState.Type;
const SLACK_READ_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

export const slackManifest = (): string =>
  JSON.stringify(
    {
      display_information: { name: "rejects read-only" },
      oauth_config: { scopes: { user: [...SLACK_READ_SCOPES] } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false },
    },
    null,
    2,
  );

export const ConnectionStatus = Schema.Literals(["setup", "connected", "paused", "error"]);
export type ConnectionStatus = typeof ConnectionStatus.Type;

export const ConnectionField = Schema.Struct({
  name: Schema.String,
  setAt: Schema.NullOr(Schema.String),
});
export type ConnectionField = typeof ConnectionField.Type;

export const VaultConnection = Schema.Struct({
  kind: ConnectionKind,
  status: ConnectionStatus,
  account: Schema.NullOr(Schema.String),
  fields: Schema.Array(ConnectionField),
  connectedAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type VaultConnection = typeof VaultConnection.Type;

const Vip = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const ConnectionSettings = Schema.Struct({
  watch: Schema.Boolean,
  model: Schema.NullOr(ModelSelection),
  vip: Schema.Array(Vip).check(Schema.isMaxLength(100)),
  bots: Schema.Array(ThreadId),
});
export type ConnectionSettings = typeof ConnectionSettings.Type;

export const ConnectionView = Schema.Struct({
  ...VaultConnection.fields,
  ...ConnectionSettings.fields,
});
export type ConnectionView = typeof ConnectionView.Type;

export const ConnectionAuditEntry = Schema.Struct({
  at: Schema.String,
  connection: Schema.String,
  op: Schema.String,
  actor: Schema.String,
  status: Schema.Literals(["ok", "refused", "failed"]),
  count: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
});
export type ConnectionAuditEntry = typeof ConnectionAuditEntry.Type;

export const AlertReason = Schema.Literals(["vip", "dm", "mention", "model"]);
export type AlertReason = typeof AlertReason.Type;

export const ConnectionAlert = Schema.Struct({
  at: Schema.String,
  kind: ConnectionKind,
  id: Schema.String,
  from: Schema.String,
  title: Schema.String,
  why: Schema.String,
  reason: AlertReason,
});
export type ConnectionAlert = typeof ConnectionAlert.Type;

const SITE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * An account's site from a URL or a bare host: the hostname without `www.`, with the port when
 * the URL names one. Undefined for anything that is not an http(s) host with a dot.
 */
export const siteOf = (input: string): string | undefined => {
  const raw = input.trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^www\./, "");
  if (!SITE_HOST.test(host)) return undefined;
  return url.port ? `${host}:${url.port}` : host;
};

export const onSite = (url: string, site: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const [host = "", port = ""] = site.split(":");
  return parsed.port === port && (parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
};

export const AccountSite = Schema.String.check(
  Schema.makeFilter((site: string) => siteOf(site) === site, { expected: "a site such as olx.ua" }),
);

/**
 * A bot that may use an account. Runs the user starts with a chat message may write; wakes,
 * workers and messages from other bots only read unless `scheduledWrites` is on.
 */
export const AccountGrant = Schema.Struct({
  botThreadId: ThreadId,
  scheduledWrites: Schema.Boolean,
  /** The user's code was typed under this grant, so the bot may use the account before it is signed in. */
  codeTyped: Schema.optionalKey(Schema.Boolean),
});
export type AccountGrant = typeof AccountGrant.Type;

export const VaultAccount = Schema.Struct({
  site: AccountSite,
  createdAt: Schema.String,
  signedInAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
});
export type VaultAccount = typeof VaultAccount.Type;

export const AccountView = Schema.Struct({
  ...VaultAccount.fields,
  bots: Schema.Array(AccountGrant),
  origins: Schema.Array(AccountSite),
});
export type AccountView = typeof AccountView.Type;

export const BrowserCheck = Schema.Struct({
  label: Schema.String,
  browser: Schema.Literals(["account", "computer"]),
});
export type BrowserCheck = typeof BrowserCheck.Type;

export const LoginRequest = Schema.Struct({
  id: Schema.String,
  site: AccountSite,
  url: Schema.String,
  reason: Schema.String,
  botThreadId: ThreadId,
  writes: Schema.Boolean,
  createdAt: Schema.String,
  check: Schema.optionalKey(BrowserCheck),
});
export type LoginRequest = typeof LoginRequest.Type;

export const BotSecretName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/));
export const BOT_SECRET_VALUE_MAX = 4096;
/** Shorter values would match ordinary text, so tool results could not be redacted safely. */
export const BOT_SECRET_VALUE_MIN = 3;

/** What a site secret is typed into: a sign-in name, a password (only into a password field) or a one-time code. */
export const BotSecretKind = Schema.Literals(["username", "password", "code"]);
export type BotSecretKind = typeof BotSecretKind.Type;
/** What a bot asks for: `login` is one card that keeps a sign-in name and a password. */
export const BotSecretAskKind = Schema.Literals(["username", "password", "code", "login"]);
export type BotSecretAskKind = typeof BotSecretAskKind.Type;

/**
 * No value is ever here. With `site`, the vault keeps the value and types it only on that exact
 * host (a code once, then it is gone); without, the server keeps it for that bot's shell commands.
 */
export const BotSecret = Schema.Struct({
  id: Schema.String,
  botThreadId: ThreadId,
  name: BotSecretName,
  label: Schema.String,
  reason: Schema.String,
  site: Schema.NullOr(AccountSite),
  /** Site secrets only; absent means password. */
  kind: Schema.optionalKey(BotSecretKind),
  /** Shared by the sign-in name and password one `login` card asks for. */
  request: Schema.optionalKey(Schema.String),
  requestedAt: Schema.String,
  savedAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
});
export type BotSecret = typeof BotSecret.Type;

export const ConnectionsState = Schema.Struct({
  available: Schema.Boolean,
  /** The Gmail OAuth redirect URI to register at Google, exactly. */
  redirectUri: Schema.NullOr(Schema.String),
  connections: Schema.Array(ConnectionView),
  accounts: Schema.Array(AccountView),
  loginRequests: Schema.Array(LoginRequest),
  secrets: Schema.Array(BotSecret),
  audit: Schema.Array(ConnectionAuditEntry),
  alerts: Schema.Array(ConnectionAlert),
});
export type ConnectionsState = typeof ConnectionsState.Type;

export const SheetInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tap"),
    x: Schema.Number,
    y: Schema.Number,
    /** Echoed in `SheetFrame.focus.tap` once the page's focus after this tap is read. */
    id: Schema.optional(Schema.Int),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.Literals(["Enter", "Backspace", "Tab", "Escape"]),
  }),
  Schema.Struct({ type: Schema.Literal("scroll"), dy: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("back") }),
  Schema.Struct({ type: Schema.Literal("forward") }),
  Schema.Struct({ type: Schema.Literal("reload") }),
  Schema.Struct({ type: Schema.Literal("closePopup") }),
]);
export type SheetInput = typeof SheetInput.Type;

export const SheetField = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
});
export type SheetField = typeof SheetField.Type;

/**
 * The page's focus, read right after each tap and whenever the page settles. `editing` is null
 * when focus is inside a frame the vault cannot read; `tap` is the id of the latest tap before
 * the read. `fields` are the visible text fields in page pixels.
 */
export const SheetFocus = Schema.Struct({
  editing: Schema.NullOr(Schema.Boolean),
  fields: Schema.Array(SheetField),
  tap: Schema.NullOr(Schema.Int),
});
export type SheetFocus = typeof SheetFocus.Type;

export const SheetFrame = Schema.Struct({
  open: Schema.Boolean,
  seq: Schema.Int,
  image: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  width: Schema.Int,
  height: Schema.Int,
  offsetTop: Schema.optional(Schema.Number),
  popup: Schema.optional(Schema.Boolean),
  focus: Schema.optional(SheetFocus),
});
export type SheetFrame = typeof SheetFrame.Type;

const Ok = Schema.Struct({});

export const CONNECTIONS_ENDPOINTS = {
  state: {
    path: "/api/connections/state",
    payload: Schema.Struct({}),
    success: ConnectionsState,
    scope: AuthOrchestrationReadScope,
  },
  /** Sets a write-only field. The value goes straight to the vault and never comes back. */
  setField: {
    path: "/api/connections/field",
    payload: Schema.Struct({
      kind: ConnectionKind,
      field: Schema.String,
      value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  start: {
    path: "/api/connections/start",
    payload: Schema.Struct({ kind: Schema.Literal("gmail") }),
    success: Schema.Struct({ authUrl: Schema.String }),
    scope: AuthOrchestrationOperateScope,
  },
  disconnect: {
    path: "/api/connections/disconnect",
    payload: Schema.Struct({ kind: ConnectionKind }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  pause: {
    path: "/api/connections/pause",
    payload: Schema.Struct({ kind: ConnectionKind, paused: Schema.Boolean }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  settings: {
    path: "/api/connections/settings",
    payload: Schema.Struct({
      kind: ConnectionKind,
      watch: Schema.optional(Schema.Boolean),
      model: Schema.optional(Schema.NullOr(ModelSelection)),
      vip: Schema.optional(Schema.Array(Vip).check(Schema.isMaxLength(100))),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  grant: {
    path: "/api/connections/grant",
    payload: Schema.Struct({
      kind: ConnectionKind,
      botThreadId: ThreadId,
      granted: Schema.Boolean,
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  sheetOpen: {
    path: "/api/connections/sheet/open",
    payload: Schema.Struct({ site: AccountSite, requestId: Schema.optional(Schema.String) }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  sheetFrame: {
    path: "/api/connections/sheet/frame",
    payload: Schema.Struct({ site: AccountSite, after: Schema.Int }),
    success: SheetFrame,
    scope: AuthOrchestrationOperateScope,
  },
  /** The vault caps `scale` at 3. The page relayouts at that size and frames follow the scale. */
  sheetViewport: {
    path: "/api/connections/sheet/viewport",
    payload: Schema.Struct({
      site: AccountSite,
      width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
      scale: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  sheetInput: {
    path: "/api/connections/sheet/input",
    payload: Schema.Struct({ site: AccountSite, input: SheetInput }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  sheetClose: {
    path: "/api/connections/sheet/close",
    payload: Schema.Struct({ site: AccountSite, done: Schema.Boolean }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  loginRequests: {
    path: "/api/connections/login-requests",
    payload: Schema.Struct({}),
    success: Schema.Array(LoginRequest),
    scope: AuthOrchestrationReadScope,
  },
  /** The user chose the sign-in page over a bot's login card: the card goes, a sheet request comes. */
  secretChoosePage: {
    path: "/api/connections/secrets/page",
    payload: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ site: AccountSite, requestId: Schema.String }),
    scope: AuthOrchestrationOperateScope,
  },
  loginDismiss: {
    path: "/api/connections/login-requests/dismiss",
    payload: Schema.Struct({ id: Schema.String }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  accountGrant: {
    path: "/api/connections/account/grant",
    payload: Schema.Struct({
      site: AccountSite,
      botThreadId: ThreadId,
      granted: Schema.Boolean,
      scheduledWrites: Schema.optional(Schema.Boolean),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  accountSignOut: {
    path: "/api/connections/account/sign-out",
    payload: Schema.Struct({ site: AccountSite }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  accountRevoke: {
    path: "/api/connections/account/revoke",
    payload: Schema.Struct({ site: AccountSite }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  accountOrigins: {
    path: "/api/connections/account/origins",
    payload: Schema.Struct({
      site: AccountSite,
      origins: Schema.Array(AccountSite).check(Schema.isMaxLength(20)),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  checkDone: {
    path: "/api/connections/check/done",
    payload: Schema.Struct({ id: Schema.String }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  /** Every bot's connected mail accounts and send requests. */
  mailState: {
    path: "/api/connections/mail/state",
    payload: Schema.Struct({}),
    success: MailState,
    scope: AuthOrchestrationReadScope,
  },
  /** Revokes the account's grant at the provider and deletes its token. */
  mailDisconnect: {
    path: "/api/connections/mail/disconnect",
    payload: Schema.Struct({ id: Schema.String }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  /** The user's answer to a send request. Confirm sends that exact draft once. */
  mailSendDecide: {
    path: "/api/connections/mail/send",
    payload: Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
    success: MailSendRequest,
    scope: AuthOrchestrationOperateScope,
  },
  secrets: {
    path: "/api/connections/secrets",
    payload: Schema.Struct({}),
    success: Schema.Array(BotSecret),
    scope: AuthOrchestrationReadScope,
  },
  /**
   * The user's answer from the secure sheet. The value goes to the server's secret store, never
   * comes back, and the bot that asked is woken to continue.
   */
  secretSave: {
    path: "/api/connections/secrets/save",
    payload: Schema.Struct({
      id: Schema.String,
      value: Schema.String.check(
        Schema.isMinLength(BOT_SECRET_VALUE_MIN),
        Schema.isMaxLength(BOT_SECRET_VALUE_MAX),
      ),
    }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
  secretRemove: {
    path: "/api/connections/secrets/remove",
    payload: Schema.Struct({ id: Schema.String }),
    success: Ok,
    scope: AuthOrchestrationOperateScope,
  },
} as const;

const CHEAP_MODELS = [/deepseek.*flash/i, /flash/i, /haiku/i, /luna/i, /mini|nano|lite/i];

export const cheapestModel = (
  providers: ReadonlyArray<{
    readonly instanceId: ModelSelection["instanceId"];
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  }>,
): ModelSelection | null => {
  for (const pattern of CHEAP_MODELS)
    for (const provider of providers) {
      const model = provider.models.find((m) => pattern.test(m.slug));
      if (model) return { instanceId: provider.instanceId, model: model.slug };
    }
  const owner = providers.find((p) => p.models.length > 0);
  const first = owner?.models[0];
  return owner && first ? { instanceId: owner.instanceId, model: first.slug } : null;
};

export const CONNECTIONS_CALLBACK_PATH = "/api/connections/callback";
/** A bot's one-time connect link on the same origin; it carries no rejects session. */
export const CONNECTIONS_LINK_PATH = "/api/connections/link";

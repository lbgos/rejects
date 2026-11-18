/** Nothing read from here leaves the vault except `view` and `accounts`, which name fields, sites and dates, never values. */
import {
  AccountSite,
  CONNECTION_FIELDS,
  CONNECTION_KINDS,
  ConnectionAuditEntry,
  type ConnectionKind,
  MailAccount,
  type VaultAccount,
  type VaultConnection,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const AUDIT_KEPT = 2_000;
const AUDIT_SHOWN = 300;
const AUDIT_DETAIL_CHARS = 1_000;

const Meta = Schema.Struct({
  account: Schema.NullOr(Schema.String),
  connectedAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
  paused: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  fields: Schema.Record(Schema.String, Schema.String),
});
export type Meta = typeof Meta.Type;
const emptyMeta: Meta = {
  account: null,
  connectedAt: null,
  lastUsedAt: null,
  paused: false,
  error: null,
  fields: {},
};
// Keyed by string so a file that still names removed kinds loads; only known kinds are kept.
const MetaFile = Schema.Record(Schema.String, Meta);
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(MetaFile));
const encodeMeta = Schema.encodeSync(Schema.fromJsonString(MetaFile));
const AccountRecord = Schema.Struct({
  createdAt: Schema.String,
  signedInAt: Schema.NullOr(Schema.String),
  lastUsedAt: Schema.NullOr(Schema.String),
});
type AccountRecord = typeof AccountRecord.Type;
const AccountsFile = Schema.Record(Schema.String, AccountRecord);
const decodeAccounts = Schema.decodeUnknownOption(Schema.fromJsonString(AccountsFile));
const encodeAccounts = Schema.encodeSync(Schema.fromJsonString(AccountsFile));
/** Bots' OAuth accounts by id; tokens are secrets named `oauth.<id>`. */
const OAuthAccountsFile = Schema.Record(Schema.String, MailAccount);
const decodeOAuthAccounts = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthAccountsFile));
const encodeOAuthAccounts = Schema.encodeSync(Schema.fromJsonString(OAuthAccountsFile));
/**
 * A login a bot types by reference: the value, the one host it is typed on, and its field kind.
 * A password also keeps when it was last typed and whether the site refused it, so a restart does
 * not reset the one-try rule.
 */
export const KeptLogin = Schema.Struct({
  site: AccountSite,
  kind: Schema.Literals(["username", "password"]),
  value: Schema.String,
  typedAt: Schema.optional(Schema.Number),
  failed: Schema.optional(Schema.Boolean),
});
export type KeptLogin = typeof KeptLogin.Type;
const decodeLogin = Schema.decodeUnknownOption(Schema.fromJsonString(KeptLogin));
const encodeLogin = Schema.encodeSync(Schema.fromJsonString(KeptLogin));
const Config = Schema.Struct({ redirectUri: Schema.NullOr(Schema.String) });
const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Config));
const decodeAudit = Schema.decodeUnknownOption(ConnectionAuditEntry);
const encodeAudit = Schema.encodeSync(Schema.fromJsonString(ConnectionAuditEntry));
/** One audit line; lines from before accounts name their connector as `kind`. */
const auditLine = (line: string) => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return Option.none();
  }
  const legacy = raw as { kind?: unknown; connection?: unknown };
  return decodeAudit(
    typeof legacy.kind === "string" && legacy.connection === undefined
      ? { ...legacy, connection: legacy.kind }
      : raw,
  );
};

/** Secret names are `<kind>.<field>`, so one kind's secrets never answer for another. */
const secretName = (kind: ConnectionKind, field: string) => `${kind}.${field}`;

const statusOf = (meta: Meta): VaultConnection["status"] =>
  meta.paused
    ? "paused"
    : meta.account === null
      ? "setup"
      : meta.error === null
        ? "connected"
        : "error";

export class VaultStoreError extends Schema.TaggedError<VaultStoreError>()("VaultStoreError", {
  message: Schema.String,
}) {}

export const make = Effect.fn("VaultStore.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.chmod(stateDir, 0o700);
  const secrets = yield* ServerSecretStore.makeAt(path.join(stateDir, "secrets"));
  const metaFile = path.join(stateDir, "connections.json");
  const accountsFile = path.join(stateDir, "accounts.json");
  const auditFile = path.join(stateDir, "audit.jsonl");
  const oauthAccountsFile = path.join(stateDir, "oauth-accounts.json");
  const lock = yield* Semaphore.make(1);
  const crypto = yield* SecureRandom.SecureRandom;
  const fail = (message: string) => () => new VaultStoreError({ message });

  /** Writes 0600 through a temporary file, so a crash never leaves half a file. */
  const writePrivate = Effect.fn("VaultStore.writePrivate")(function* (
    file: string,
    contents: string,
  ) {
    const temp = `${file}.${yield* crypto.uuidV4()}.tmp`;
    yield* fs.writeFileString(temp, contents, { mode: 0o600 });
    yield* fs.chmod(temp, 0o600);
    yield* fs.rename(temp, file);
  });

  const config = yield* fs.readFileString(path.join(stateDir, "config.json")).pipe(
    Effect.map((text) => Option.getOrElse(decodeConfig(text), () => ({ redirectUri: null }))),
    Effect.orElseSucceed(() => ({ redirectUri: null })),
  );
  let meta = yield* fs.readFileString(metaFile).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeMeta(text))),
    Effect.orElseSucceed(() => undefined),
  );
  const current = (kind: ConnectionKind): Meta => meta?.[kind] ?? emptyMeta;
  let accounts: Record<string, AccountRecord> = yield* fs.readFileString(accountsFile).pipe(
    Effect.map((text) => Option.getOrElse(decodeAccounts(text), () => ({}))),
    Effect.orElseSucceed(() => ({})),
  );

  let oauthAccounts: Record<string, MailAccount> = yield* fs.readFileString(oauthAccountsFile).pipe(
    Effect.map((text) => Option.getOrElse(decodeOAuthAccounts(text), () => ({}))),
    Effect.orElseSucceed(() => ({})),
  );

  const update = (kind: ConnectionKind, change: (current: Meta) => Meta) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const next: Record<string, Meta> = Object.fromEntries(
            CONNECTION_KINDS.map((k) => [k, k === kind ? change(current(k)) : current(k)]),
          );
          yield* writePrivate(metaFile, encodeMeta(next));
          meta = next;
          return next[kind] ?? emptyMeta;
        }),
      )
      .pipe(Effect.mapError(fail("Could not save the vault state.")));

  const updateAccount = (
    site: string,
    change: (current: AccountRecord | undefined) => AccountRecord | undefined,
  ) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const { [site]: existing, ...rest } = accounts;
          const changed = change(existing);
          const next = changed === undefined ? rest : { ...rest, [site]: changed };
          yield* writePrivate(accountsFile, encodeAccounts(next));
          accounts = next;
          return changed;
        }),
      )
      .pipe(Effect.mapError(fail("Could not save the vault accounts.")));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const oauthSecret = (id: string) => `oauth.${id}`;
  const loginSecret = (id: string) => `login.${id}`;

  return {
    newId: crypto.uuidV4().pipe(Effect.mapError(fail("Could not make an id."))),
    oauthAccounts: (): ReadonlyArray<MailAccount> =>
      Object.values(oauthAccounts).toSorted(
        (a, b) => a.botThreadId.localeCompare(b.botThreadId) || a.address.localeCompare(b.address),
      ),
    oauthAccount: (id: string): MailAccount | undefined => oauthAccounts[id],
    /** Applies `change` to one account; undefined removes it. */
    updateOAuthAccount: (
      id: string,
      change: (current: MailAccount | undefined) => MailAccount | undefined,
    ) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const { [id]: existing, ...rest } = oauthAccounts;
            const changed = change(existing);
            const next = changed === undefined ? rest : { ...rest, [id]: changed };
            yield* writePrivate(oauthAccountsFile, encodeOAuthAccounts(next));
            oauthAccounts = next;
            return changed;
          }),
        )
        .pipe(Effect.mapError(fail("Could not save the vault accounts."))),
    getOAuthToken: (id: string) =>
      secrets
        .get(oauthSecret(id))
        .pipe(
          Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
          Effect.mapError(fail("Could not read a vault secret.")),
        ),
    setOAuthToken: (id: string, token: string) =>
      secrets
        .set(oauthSecret(id), new TextEncoder().encode(token))
        .pipe(Effect.mapError(fail("Could not save a vault secret."))),
    removeOAuthToken: (id: string) =>
      secrets
        .remove(oauthSecret(id))
        .pipe(Effect.mapError(fail("Could not delete a vault secret."))),
    getLogin: (id: string) =>
      secrets
        .get(loginSecret(id))
        .pipe(
          Effect.map(Option.flatMap((bytes) => decodeLogin(new TextDecoder().decode(bytes)))),
          Effect.mapError(fail("Could not read a vault secret.")),
        ),
    setLogin: (id: string, login: KeptLogin) =>
      secrets
        .set(loginSecret(id), new TextEncoder().encode(encodeLogin(login)))
        .pipe(Effect.mapError(fail("Could not save a vault secret."))),
    removeLogin: (id: string) =>
      secrets
        .remove(loginSecret(id))
        .pipe(Effect.mapError(fail("Could not delete a vault secret."))),
    redirectUri: config.redirectUri,
    meta: current,
    update,
    account: (site: string): AccountRecord | undefined => accounts[site],
    accounts: (): ReadonlyArray<VaultAccount> =>
      Object.entries(accounts)
        .map(([site, record]) => ({ site, ...record }))
        .toSorted((a, b) => a.site.localeCompare(b.site)),
    updateAccount,
    view: (kind: ConnectionKind): VaultConnection => {
      const m = current(kind);
      return {
        kind,
        status: statusOf(m),
        account: m.account,
        fields: CONNECTION_FIELDS[kind].map((name) => ({ name, setAt: m.fields[name] ?? null })),
        connectedAt: m.connectedAt,
        lastUsedAt: m.lastUsedAt,
        error: m.error,
      };
    },
    getSecret: (kind: ConnectionKind, field: string) =>
      secrets
        .get(secretName(kind, field))
        .pipe(
          Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
          Effect.mapError(fail("Could not read a vault secret.")),
        ),
    setSecret: Effect.fn("VaultStore.setSecret")(function* (
      kind: ConnectionKind,
      field: string,
      value: string,
    ) {
      yield* secrets
        .set(secretName(kind, field), new TextEncoder().encode(value))
        .pipe(Effect.mapError(fail("Could not save a vault secret.")));
      if ((CONNECTION_FIELDS[kind] as ReadonlyArray<string>).includes(field)) {
        const at = yield* now;
        yield* update(kind, (m) => ({ ...m, fields: { ...m.fields, [field]: at } }));
      }
    }),
    removeSecret: (kind: ConnectionKind, field: string) =>
      secrets
        .remove(secretName(kind, field))
        .pipe(Effect.mapError(fail("Could not delete a vault secret."))),
    now,
    /** Appends one entry. Never fails the caller: a lost audit line is logged instead. */
    audit: Effect.fn("VaultStore.audit")(function* (entry: Omit<ConnectionAuditEntry, "at">) {
      const line = encodeAudit({
        ...entry,
        at: yield* now,
        detail: entry.detail === null ? null : entry.detail.slice(0, AUDIT_DETAIL_CHARS),
      });
      yield* lock
        .withPermit(
          Effect.gen(function* () {
            const lines = yield* fs.readFileString(auditFile).pipe(
              Effect.map((text) => text.split("\n").filter((l) => l.length > 0)),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            );
            yield* writePrivate(
              auditFile,
              `${[...lines.slice(-AUDIT_KEPT + 1), line].join("\n")}\n`,
            );
          }),
        )
        .pipe(Effect.ignore({ log: true }));
    }),
    readAudit: fs.readFileString(auditFile).pipe(
      Effect.map((text) =>
        text
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(-AUDIT_SHOWN)
          .flatMap((line) => Option.toArray(auditLine(line))),
      ),
      Effect.orElseSucceed((): ReadonlyArray<ConnectionAuditEntry> => []),
    ),
  };
});
export type VaultStore = Effect.Success<ReturnType<typeof make>>;

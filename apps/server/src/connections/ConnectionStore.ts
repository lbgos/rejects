/** No secrets live here; they stay in the vault. Kept free of orchestration dependencies so the runtime policy and /mcp can ask `held`. */
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  AccountGrant,
  CONNECTION_KINDS,
  ConnectionAlert,
  type ConnectionKind,
  ConnectionSettings,
  LoginRequest,
  MailSendRequest,
  type ThreadId,
  isConnectionKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

const SEEN_KEPT = 500;
const ALERTS_KEPT = 100;
const LOGIN_REQUESTS_KEPT = 50;
const SENDS_KEPT = 100;

export const ConnectionsFile = Schema.Struct({
  /** API connectors. Keyed by string so kinds from older files load and drop out. */
  settings: Schema.Record(Schema.String, ConnectionSettings),
  accounts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(AccountGrant))),
  origins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  loginRequests: Schema.optionalKey(Schema.Array(LoginRequest)),
  /** Bots, by site, whose sign-in the user chose to do on the page rather than in a login card. */
  pageChosen: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Drafts bots asked to send, with the user's answer. */
  sends: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  seen: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  alerts: Schema.Array(Schema.Unknown),
});
type StoredFile = typeof ConnectionsFile.Type;

export interface ConnectionsFileState {
  readonly settings: Readonly<Record<ConnectionKind, ConnectionSettings>>;
  readonly accounts: Readonly<Record<string, ReadonlyArray<AccountGrant>>>;
  readonly origins: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly loginRequests: ReadonlyArray<LoginRequest>;
  readonly pageChosen: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly sends: ReadonlyArray<MailSendRequest>;
  readonly seen: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly alerts: ReadonlyArray<ConnectionAlert>;
}
export type ConnectionsFile = ConnectionsFileState;
const isAlert = Schema.is(ConnectionAlert);
const decodeSend = Schema.decodeUnknownOption(MailSendRequest);

const defaultSettings: ConnectionSettings = { watch: false, model: null, vip: [], bots: [] };
const defaultConnectorSettings = {
  gmail: defaultSettings,
  slack: defaultSettings,
} satisfies Record<ConnectionKind, ConnectionSettings>;
const emptyConnectionsFile: ConnectionsFile = {
  settings: defaultConnectorSettings,
  accounts: {},
  origins: {},
  loginRequests: [],
  pageChosen: {},
  sends: [],
  seen: {},
  alerts: [],
};

const fromStored = (stored: StoredFile): ConnectionsFile => ({
  settings: {
    gmail: stored.settings.gmail ?? defaultSettings,
    slack: stored.settings.slack ?? defaultSettings,
  },
  accounts: stored.accounts ?? {},
  origins: stored.origins ?? {},
  loginRequests: stored.loginRequests ?? [],
  pageChosen: stored.pageChosen ?? {},
  // Row by row, so one row that no longer decodes is dropped instead of the whole file.
  sends: (stored.sends ?? []).flatMap((row) => Option.toArray(decodeSend(row))),
  seen: Object.fromEntries(Object.entries(stored.seen).filter(([kind]) => isConnectionKind(kind))),
  alerts: stored.alerts.filter(isAlert),
});

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionsFile));

/** The file's text as state; text that does not decode as a whole starts empty. */
export const parseConnectionsFile = (text: string): ConnectionsFile =>
  Option.match(decodeFile(text), { onNone: () => emptyConnectionsFile, onSome: fromStored });

const bounded = (file: ConnectionsFile): ConnectionsFile => ({
  ...file,
  loginRequests: file.loginRequests.slice(-LOGIN_REQUESTS_KEPT),
  sends: file.sends.slice(-SENDS_KEPT),
  alerts: file.alerts.slice(-ALERTS_KEPT),
  seen: Object.fromEntries(
    Object.entries(file.seen).map(([kind, ids]) => [kind, ids.slice(-SEEN_KEPT)]),
  ),
});

export const originsOf = (file: ConnectionsFile, site: string): ReadonlyArray<string> =>
  file.origins[site] ?? [];

export class ConnectionStoreError extends Schema.TaggedError<ConnectionStoreError>()(
  "ConnectionStoreError",
  { message: Schema.String },
) {}

export class ConnectionStore extends Context.Service<
  ConnectionStore,
  {
    readonly read: Effect.Effect<ConnectionsFile>;
    readonly settings: (kind: ConnectionKind) => Effect.Effect<ConnectionSettings>;
    readonly mutate: (
      change: (current: ConnectionsFile) => ConnectionsFile,
    ) => Effect.Effect<ConnectionsFile, ConnectionStoreError>;
    /**
     * Whether the bot reads any API connector. Such a bot runs without egress tools or native
     * shell. Accounts do not count: a bot uses them through its web tools.
     */
    readonly held: (botThreadId: ThreadId) => Effect.Effect<boolean>;
    readonly grantsOf: (botThreadId: ThreadId) => Effect.Effect<ReadonlyArray<ConnectionKind>>;
  }
>()("t3/connections/ConnectionStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, "connections.json");
  const lock = yield* Semaphore.make(1);
  const encode = Schema.encodeEffect(Schema.fromJsonString(ConnectionsFile));
  let state: ConnectionsFile = yield* fs.readFileString(file).pipe(
    Effect.map(parseConnectionsFile),
    Effect.orElseSucceed(() => emptyConnectionsFile),
  );
  const grantsOf = (botThreadId: ThreadId) =>
    CONNECTION_KINDS.filter((kind) => state.settings[kind].bots.includes(botThreadId));
  return ConnectionStore.of({
    read: Effect.sync(() => state),
    settings: Effect.fn("ConnectionStore.settings")((kind) =>
      Effect.sync(() => state.settings[kind]),
    ),
    mutate: Effect.fn("ConnectionStore.mutate")((change) =>
      lock.withPermit(
        Effect.gen(function* () {
          const next = bounded(change(state));
          yield* encode(next).pipe(
            Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          state = next;
          return next;
        }).pipe(
          Effect.mapError(
            () => new ConnectionStoreError({ message: "Could not save connections." }),
          ),
        ),
      ),
    ),
    held: Effect.fn("ConnectionStore.held")((botThreadId) =>
      Effect.sync(() => grantsOf(botThreadId).length > 0),
    ),
    grantsOf: Effect.fn("ConnectionStore.grantsOf")((botThreadId) =>
      Effect.sync(() => grantsOf(botThreadId)),
    ),
  });
});

export const layer = Layer.effect(ConnectionStore, make);

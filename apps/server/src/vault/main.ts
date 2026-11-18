// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer.layer takes node:http's createServer.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AccountSite,
  BOT_SECRET_VALUE_MAX,
  BOT_SECRET_VALUE_MIN,
  ConnectionKind,
  MAIL_SORT_ACTIONS,
  OAuthService,
  SheetInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { makeBrowsers } from "./browser.ts";
import { makeSshLease } from "./lease.ts";
import { EGRESS_PORTS } from "./egress.ts";
import { makeGmail } from "./gmail.ts";
import { makeFlows } from "./oauth.ts";
import { makeOAuthClient } from "./services.ts";
import { makeSlack } from "./slack.ts";
import { makeVault, type Vault } from "./Vault.ts";
import * as VaultStore from "./VaultStore.ts";

const Optional = Schema.optional;
const Ref = Schema.String.check(Schema.isPattern(/^e\d{1,6}$/));
const AccountAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("open"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot"), offset: Optional(Schema.Int) }),
  Schema.Struct({ action: Schema.Literal("click"), ref: Ref }),
  Schema.Struct({
    action: Schema.Literal("type"),
    ref: Ref,
    text: Schema.String.check(Schema.isMaxLength(5000)),
    submit: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("press"), key: Schema.String }),
  Schema.Struct({ action: Schema.Literal("scroll"), direction: Schema.Literals(["up", "down"]) }),
  Schema.Struct({ action: Schema.Literal("back") }),
]);
const Handle = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{20,100}$/));
const Line = Schema.String.check(Schema.isMaxLength(2000));
const VaultRequests = {
  "/state": Schema.Struct({}),
  "/audit": Schema.Struct({}),
  "/field": Schema.Struct({ kind: ConnectionKind, field: Schema.String, value: Schema.String }),
  "/start": Schema.Struct({ kind: Schema.Literal("gmail") }),
  "/callback": Schema.Struct({
    state: Schema.String,
    code: Optional(Schema.String),
    scope: Optional(Schema.String),
    error: Optional(Schema.String),
  }),
  "/disconnect": Schema.Struct({ kind: ConnectionKind }),
  "/pause": Schema.Struct({ kind: ConnectionKind, paused: Schema.Boolean }),
  "/op": Schema.Struct({
    kind: ConnectionKind,
    op: Schema.String,
    actor: Schema.String,
    args: Schema.Struct({
      query: Optional(Schema.String),
      id: Optional(Schema.String),
      channel: Optional(Schema.String),
      limit: Optional(Schema.Number),
      sinceHours: Optional(Schema.Number),
    }),
  }),
  "/link": Schema.Struct({ service: OAuthService, botThreadId: ThreadId, writes: Schema.Boolean }),
  "/link/peek": Schema.Struct({ handle: Handle }),
  "/link/open": Schema.Struct({ handle: Handle }),
  "/oauth/op": Schema.Struct({
    accountId: Schema.String,
    botThreadId: ThreadId,
    op: Schema.String,
    actor: Schema.String,
    args: Schema.Struct({
      query: Optional(Line),
      id: Optional(Schema.String),
      limit: Optional(Schema.Number),
      ids: Optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
      action: Optional(Schema.Literals(MAIL_SORT_ACTIONS)),
      label: Optional(Line),
      draftId: Optional(Schema.String),
      messageId: Optional(Schema.String),
      to: Optional(Line),
      cc: Optional(Line),
      subject: Optional(Line),
      body: Optional(Schema.String.check(Schema.isMaxLength(100_000))),
      replyTo: Optional(Schema.String),
    }),
  }),
  "/oauth/disconnect": Schema.Struct({ accountId: Schema.String }),
  "/sheet/open": Schema.Struct({ site: AccountSite, url: Schema.String }),
  "/sheet/frame": Schema.Struct({ site: AccountSite, after: Schema.Int }),
  "/sheet/viewport": Schema.Struct({
    site: AccountSite,
    width: Schema.Int,
    height: Schema.Int,
    scale: Schema.Number,
  }),
  "/sheet/input": Schema.Struct({ site: AccountSite, input: SheetInput }),
  "/sheet/close": Schema.Struct({ site: AccountSite, done: Schema.Boolean }),
  "/account/sign-out": Schema.Struct({ site: AccountSite }),
  "/account/revoke": Schema.Struct({ site: AccountSite }),
  "/account/act": Schema.Struct({
    site: AccountSite,
    action: AccountAction,
    actor: Schema.String,
    writes: Schema.Boolean,
    origins: Optional(Schema.Array(AccountSite)),
    secret: Optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
    signIn: Optional(Schema.Boolean),
  }),
  "/login/set": Schema.Struct({
    id: Schema.String,
    site: AccountSite,
    kind: Schema.Literals(["username", "password", "code"]),
    value: Schema.String.check(
      Schema.isMinLength(BOT_SECRET_VALUE_MIN),
      Schema.isMaxLength(BOT_SECRET_VALUE_MAX),
    ),
  }),
  "/login/remove": Schema.Struct({ id: Schema.String }),
  "/login/failed": Schema.Struct({ id: Schema.String }),
} as const;
type Requests = typeof VaultRequests;

const handlers = (
  vault: Vault,
): {
  [K in keyof Requests]: (
    input: Requests[K]["Type"],
  ) => Effect.Effect<unknown, { readonly message: string }>;
} => ({
  "/state": () => vault.state,
  "/audit": () => vault.audit,
  "/field": ({ kind, field, value }) => vault.setField(kind, field, value),
  "/start": ({ kind }) => vault.start(kind),
  "/callback": (input) => vault.callback(input),
  "/disconnect": ({ kind }) => vault.disconnect(kind),
  "/pause": ({ kind, paused }) => vault.pause(kind, paused),
  "/op": ({ kind, op, args, actor }) => vault.op(kind, op, args, actor),
  "/link": (input) => vault.link(input),
  "/link/peek": ({ handle }) => vault.linkPeek(handle),
  "/link/open": ({ handle }) => vault.linkOpen(handle),
  "/oauth/op": (input) => vault.accountOp(input),
  "/oauth/disconnect": ({ accountId }) => vault.accountDisconnect(accountId),
  "/sheet/open": ({ site, url }) => vault.sheetOpen(site, url),
  "/sheet/frame": ({ site, after }) => vault.sheetFrame(site, after),
  "/sheet/viewport": ({ site, width, height }) => vault.sheetViewport(site, { width, height }),
  "/sheet/input": ({ site, input }) => vault.sheetInput(site, input),
  "/sheet/close": ({ site, done }) => vault.sheetClose(site, done),
  "/account/sign-out": ({ site }) => vault.signOut(site),
  "/account/revoke": ({ site }) => vault.revoke(site),
  "/account/act": (input) => vault.act(input),
  "/login/set": (input) => vault.loginSet(input),
  "/login/remove": ({ id }) => vault.loginRemove(id),
  "/login/failed": ({ id }) => vault.loginFailed(id),
});

const routes = (vault: Vault) => {
  const table = handlers(vault);
  return (Object.keys(VaultRequests) as Array<keyof Requests>)
    .map((path) => {
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(VaultRequests[path]));
      const handle = table[path] as (
        input: unknown,
      ) => Effect.Effect<unknown, { readonly message: string }>;
      return HttpRouter.add(
        "POST",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.text.pipe(Effect.option);
          const input = Option.isSome(body)
            ? yield* decode(body.value).pipe(Effect.option)
            : Option.none();
          if (Option.isNone(input))
            return HttpServerResponse.jsonUnsafe(
              { error: { message: "Invalid request." } },
              { status: 400 },
            );
          const result = yield* handle(input.value).pipe(Effect.result);
          return result._tag === "Success"
            ? HttpServerResponse.jsonUnsafe(result.success ?? {})
            : HttpServerResponse.jsonUnsafe(
                { error: { message: result.failure.message } },
                { status: 400 },
              );
        }),
      );
    })
    .reduce((all, route) => Layer.merge(all, route));
};

const flag = (argv: ReadonlyArray<string>, name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

const portRange = (text: string): readonly [number, number] => {
  const [low, high] = text.split("-").map(Number);
  if (
    !Number.isInteger(low) ||
    !Number.isInteger(high) ||
    low! < 1024 ||
    high! < low! ||
    high! > 65535
  )
    throw new Error(`--egress-ports must be like 38000-38099, got ${text}`);
  return [low!, high!];
};

export function runVault(argv: ReadonlyArray<string>) {
  const stateDir = flag(argv, "state-dir", "/var/lib/rejects-vault");
  const socket = flag(argv, "socket", "/run/rejects-vault/vault.sock");
  const sessionsHost = flag(argv, "sessions-host", "127.0.0.1");
  const sessionsUser = flag(argv, "sessions-user", "rejects-sessions");
  const sessionStore = flag(argv, "session-store", "");
  const egressPorts = portRange(flag(argv, "egress-ports", EGRESS_PORTS.join("-")));
  const sshTarget = {
    host: sessionsHost,
    user: sessionsUser,
    identityFile: `${stateDir}/.ssh/id_ed25519`,
    knownHostsFile: `${stateDir}/.ssh/known_hosts`,
  };
  const program = Effect.gen(function* () {
    // A socket left by a crash would make listen fail; the directory belongs to this user.
    yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(socket, { force: true })));
    const store = yield* VaultStore.make(stateDir);
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const vault = makeVault({
      store,
      flows: yield* makeFlows,
      gmail: yield* makeGmail,
      oauth: yield* makeOAuthClient,
      slack: yield* makeSlack,
      browsers: makeBrowsers(sshTarget, undefined, {
        proxyPorts: egressPorts,
        trace: (line) => runFork(Effect.logInfo(line)),
        ...(sessionStore ? { lease: makeSshLease(sshTarget, sessionStore) } : {}),
      }),
    });
    yield* Effect.logInfo("vault listening", { socket });
    return yield* Layer.launch(
      HttpRouter.serve(routes(vault), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { path: socket })),
      ),
    );
  });
  program.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}

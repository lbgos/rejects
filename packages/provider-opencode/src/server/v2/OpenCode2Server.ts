import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
// One OpenCode 2 process serves all directories; share it across an instance's threads in one agent sandbox.
import type { OpenCodeClient } from "@opencode/client/effect";
import { AgentSandbox, AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientError from "effect/http/HttpClientError";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_TIMEOUT_MS = 5_000;

export interface OpenCode2Connection extends OpenCode2Client.OpenCode2Api {
  readonly url: string;
  readonly version: string;
  readonly external: boolean;
  /** Only owned processes have an authoritative lifetime signal. */
  readonly processExit?: Effect.Effect<void>;
}

export class OpenCode2Server extends Context.Service<
  OpenCode2Server,
  {
    readonly withConnection: <A, E, R>(
      use: (connection: OpenCode2Connection) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
    /** Drops a configured server's verified connection, so the next use reads its version again. */
    readonly forget: Effect.Effect<void>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Server") {}

/**
 * OpenCode 2 always requires one and prints a generated one to stdout
 * otherwise, so T3 supplies its own and keeps it in memory.
 */
const generatePassword = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const bytes = yield* random.randomBytes(32);
  return Redacted.make(Base64Url.encode(bytes), { label: "OPENCODE_PASSWORD" });
});

/** OPENCODE_PASSWORD overrides OPENCODE_SERVER_PASSWORD; drop the inherited 1.x variable. */
export const serverEnvironment = (
  environment: NodeJS.ProcessEnv,
  password: Redacted.Redacted,
): NodeJS.ProcessEnv => {
  const { OPENCODE_SERVER_PASSWORD: _inherited, ...rest } = environment;
  return { ...rest, OPENCODE_PASSWORD: Redacted.value(password) };
};

export const httpFailureOf = (cause: unknown): HttpClientError.HttpClientError | undefined => {
  if (HttpClientError.isHttpClientError(cause)) return cause;
  if (
    P.isTagged(cause, "ClientError") &&
    P.hasProperty(cause, "cause") &&
    HttpClientError.isHttpClientError(cause.cause)
  ) {
    return cause.cause;
  }
  return undefined;
};

// Empty 401s still reject passwords; undecodable 2xx may be 1.x HTML, not OpenCode 2.
const describeInfoFailure = (cause: unknown) => {
  const failure = httpFailureOf(cause);
  if (failure?.reason._tag === "TransportError") {
    return "Could not reach the OpenCode server.";
  }
  const status = failure?.response?.status;
  if (status === 401) return "The OpenCode server rejected the server password.";
  if (status !== undefined && (status < 200 || status >= 300)) {
    return `The OpenCode server returned HTTP ${status}.`;
  }
  return "The server is not an OpenCode 2 server.";
};

/** Only server info proves readiness; keep credential-bearing failure details out of client text. */
export const verifyServer = (client: OpenCodeClient, environment?: NodeJS.ProcessEnv) =>
  client.server.info().pipe(
    Effect.timeoutOrElse({
      duration: resolveProviderProbeTimeoutMs("opencode", INFO_TIMEOUT_MS, environment),
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "Timed out waiting for the OpenCode server.",
          }),
        ),
    }),
    Effect.catchTags({
      UnauthorizedError: (cause) =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: "The OpenCode server rejected the server password.",
            cause,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      OpenCodeRuntime.isOpenCodeRuntimeError(cause)
        ? cause
        : new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: describeInfoFailure(cause),
            cause,
          }),
    ),
    Effect.map((info) => info.version),
  );

export const make = Effect.fn("OpenCode2Server.make")(function* (input: {
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const opencode = yield* OpenCode2Client.OpenCode2Client;
  const connectTo = Effect.fn("OpenCode2Server.connectTo")(function* (
    url: string,
    password: Redacted.Redacted,
    external: boolean,
  ) {
    const api = yield* opencode.connect({ baseUrl: url, password });
    const version = yield* verifyServer(api.client, input.environment);
    return { ...api, url, version, external } satisfies OpenCode2Connection;
  });
  let latest: OpenCode2Connection | undefined;
  const remember = (connection: OpenCode2Connection) =>
    Effect.sync(() => {
      latest = connection;
      return connection.version;
    });

  const serverUrl = input.serverUrl.trim();
  if (serverUrl.length > 0) {
    const connect = connectTo(serverUrl, Redacted.make(input.serverPassword), true).pipe(
      Effect.tap(remember),
    );
    return OpenCode2Server.of({
      withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
        return Effect.suspend(() => (latest === undefined ? connect : Effect.succeed(latest))).pipe(
          Effect.flatMap(use),
        );
      }),
      forget: Effect.sync(() => {
        latest = undefined;
      }),
    });
  }

  // A server runs in the agent sandbox of the thread that starts it, and a bot's sandbox mounts
  // only its own files, so each sandbox gets its own server; threads on the host share one.
  const scope = yield* Effect.scope;
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const crypto = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const owners = new Map<
    string,
    {
      readonly owner: OpenCodeServerOwner.OpenCodeServerOwner["Service"];
      readonly latest: () => OpenCode2Connection | undefined;
    }
  >();
  const ownerFor = (sandbox: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const known = owners.get(sandbox);
        if (known !== undefined) return known;
        const password = yield* generatePassword;
        let verified: OpenCode2Connection | undefined;
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: input.binaryPath,
          directory: input.directory,
          environment: serverEnvironment(input.environment, password),
          verify: (url) =>
            connectTo(url, password, false).pipe(
              Effect.map((connection) => {
                verified = connection;
                return connection.version;
              }),
            ),
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        );
        const created = { owner, latest: () => verified };
        owners.set(sandbox, created);
        return created;
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, crypto)),
    );
  const ownerForThread = Effect.gen(function* () {
    const threadId = yield* AgentScopeThreadId;
    const sandbox =
      threadId === undefined ? Option.none() : yield* (yield* AgentSandbox).identity(threadId);
    return yield* ownerFor(Option.getOrElse(sandbox, () => ""));
  });
  return OpenCode2Server.of({
    withConnection: Effect.fn("OpenCode2Server.withConnection")(function (use) {
      return ownerForThread.pipe(
        Effect.flatMap(({ owner, latest }) =>
          owner.withServer((server) => {
            const connection = latest();
            return connection?.url === server.url
              ? use({ ...connection, processExit: server.exitCode.pipe(Effect.asVoid) })
              : Effect.die(new Error("OpenCode 2 server was lent before verification."));
          }),
        ),
      );
    }),
    forget: Effect.void,
  });
});

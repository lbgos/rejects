// @effect-diagnostics nodeBuiltinImport:off - Effect's HttpClient cannot reach a unix socket.
/**
 * rejects' client for the vault's unix socket. Only rejects' group can enter the socket's
 * directory; bot processes run under another user and cannot.
 */
import * as NodeHttp from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const DEFAULT_VAULT_SOCKET = "/run/rejects-vault/vault.sock";

export class VaultCallError extends Schema.TaggedError<VaultCallError>()("VaultCallError", {
  message: Schema.String,
  unavailable: Schema.Boolean,
}) {}

const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

export class VaultClient extends Context.Service<
  VaultClient,
  {
    readonly call: <S extends Schema.Top>(
      path: string,
      body: object,
      success: S,
      options?: { readonly timeoutMs?: number },
    ) => Effect.Effect<S["Type"], VaultCallError, S["DecodingServices"]>;
  }
>()("t3/connections/VaultClient") {}

const post = (socketPath: string, path: string, body: string, timeoutMs: number) =>
  Effect.callback<{ status: number; text: string }, VaultCallError>((resume) => {
    const request = NodeHttp.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () =>
      resume(
        Effect.fail(
          new VaultCallError({ message: "The vault is not answering.", unavailable: true }),
        ),
      ),
    );
    request.end(body);
    return Effect.sync(() => request.destroy());
  });

const make = (socketPath: string) =>
  VaultClient.of({
    call: Effect.fn("VaultClient.call")(function* <S extends Schema.Top>(
      path: string,
      body: object,
      success: S,
      options?: { readonly timeoutMs?: number },
    ) {
      // @effect-diagnostics-next-line globalJsonInEffect:off - the vault decodes every request against its own schema.
      const request = JSON.stringify(body);
      const { status, text } = yield* post(socketPath, path, request, options?.timeoutMs ?? 60_000);
      if (status !== 200) {
        const error = decodeError(text);
        return yield* new VaultCallError({
          message:
            error._tag === "Some" ? error.value.error.message : `The vault answered ${status}.`,
          unavailable: false,
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(success))(text).pipe(
        Effect.mapError(
          () =>
            new VaultCallError({
              message: "The vault's answer was unexpected.",
              unavailable: false,
            }),
        ),
      );
    }),
  });

export const layer = Layer.sync(VaultClient, () =>
  make(process.env.REJECTS_VAULT_SOCKET ?? DEFAULT_VAULT_SOCKET),
);

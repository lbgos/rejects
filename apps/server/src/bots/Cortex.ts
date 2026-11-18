import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Config from "../config.ts";
const ConfigFile = Schema.Struct({
  url: Schema.String,
  bearerToken: Schema.String,
  writeBearerToken: Schema.optional(Schema.String),
});
const Reply = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(Schema.Unknown),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Unknown),
});
const decodeReply = Schema.decodeUnknownEffect(Reply);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const encodeContent = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
export class Cortex extends Context.Service<
  Cortex,
  {
    readonly call: (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
  }
>()("t3/bots/Cortex") {}
/** Ends every unavailable error, so the model reports it once instead of retrying or claiming success. */
const UNAVAILABLE =
  "Nothing was read or stored. Tell the user in one line and do not call Cortex tools again this turn.";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  return Cortex.of({
    call: Effect.fn("Cortex.call")(
      function* (name, args) {
        // The bearer remains in this server-owned MCP file. It is never model context.
        const settings = yield* fs
          .readFileString(path.join(config.stateDir, "cortex-mcp.json"))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile))));
        const writes = name === "cortex_record" || name === "cortex_add_source";
        const token = writes
          ? (settings.writeBearerToken ?? settings.bearerToken)
          : settings.bearerToken;
        const request = yield* HttpClientRequest.post(settings.url).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJson({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        );
        const response = yield* http.execute(request).pipe(Effect.timeout("30 seconds"));
        if (response.status !== 200)
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Cortex is unavailable: check its server-side MCP configuration. ${UNAVAILABLE}`,
          });
        const reply = yield* decodeReply(yield* response.json);
        if (!reply.result || reply.error || reply.result.isError)
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Cortex rejected the request: ${(reply.result ? yield* encodeContent(reply.result.content) : "no result").slice(0, 1500)}`,
          });
        return yield* encodeContent(reply.result.content);
      },
      Effect.mapError((error) =>
        isMcpFailure(error)
          ? error
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Cortex is unavailable: check cortex-mcp.json in the server state directory. ${UNAVAILABLE}`,
            }),
      ),
    ),
  });
});
export const layer = Layer.effect(Cortex, make);

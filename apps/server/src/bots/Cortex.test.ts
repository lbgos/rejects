import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Config from "../config.ts";
import * as Cortex from "./Cortex.ts";

it.effect(
  "uses the scoped write credential for writes, the read credential for reads, and relays Cortex errors",
  () =>
    Effect.gen(function* () {
      const readToken = "test-read-credential";
      const writeToken = "test-write-credential";
      const client = HttpClient.make((request) => {
        const body = request.body;
        assert.equal(body._tag, "Uint8Array");
        if (body._tag !== "Uint8Array") return Effect.die("Expected JSON request body");
        const payload = JSON.parse(new TextDecoder().decode(body.body)) as {
          params: { name: string };
        };
        if (payload.params.name === "cortex_beliefs")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                result: { content: [{ type: "text", text: "invalid kind" }], isError: true },
              }),
            ),
          );
        const writes = ["cortex_record", "cortex_add_source"].includes(payload.params.name);
        const authorized =
          request.headers.authorization === `Bearer ${writes ? writeToken : readToken}`;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            authorized
              ? Response.json({ result: { content: [{ type: "text", text: "ok" }] } })
              : new Response(null, { status: 403 }),
          ),
        );
      });
      const layer = Cortex.layer.pipe(
        Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "cortex-bridge-test-" })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* Config.ServerConfig;
        yield* fs.writeFileString(
          path.join(stateDir, "cortex-mcp.json"),
          JSON.stringify({
            url: "http://cortex.test/mcp",
            bearerToken: readToken,
            writeBearerToken: writeToken,
          }),
        );
        const cortex = yield* Cortex.Cortex;
        for (const name of ["cortex_search", "cortex_read", "cortex_record", "cortex_add_source"]) {
          assert.deepEqual(JSON.parse(yield* cortex.call(name, {})), [
            { type: "text", text: "ok" },
          ]);
        }
        const rejected = yield* cortex.call("cortex_beliefs", {}).pipe(Effect.flip);
        assert.include(rejected.message, "invalid kind");
      }).pipe(Effect.provide(layer));
    }),
);

// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - a fake provider on loopback; fetch reads the answer chunk by chunk.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as Config from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ModelProxy from "./BotModelProxy.ts";

interface Received {
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const fakeProvider = Effect.gen(function* () {
  const received: Received[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        request.on("end", () => {
          received.push({ url: request.url, headers: request.headers, body });
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("event: one\n\n");
          void released.then(() => response.end("event: two\n\n"));
        });
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const port = (server.address() as NodeNet.AddressInfo).port;
  return { received, release: () => release(), baseUrl: `http://127.0.0.1:${port}/anthropic` };
});

const proxyServer = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.merge(ModelProxy.routeLayer, ServerHttp.layerHttpCompression), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(ModelProxy.layer),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "bot-model-proxy-" })),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  return { proxy: Context.get(services, ModelProxy.BotModelProxy), origin };
});

const send = (url: string, init: RequestInit = {}) => Effect.promise(() => fetch(url, init));

describe("bot model route", () => {
  it.live("forwards a bot's call with the real key in place of its token, streaming", () =>
    Effect.gen(function* () {
      const provider = yield* fakeProvider;
      const { proxy, origin } = yield* proxyServer;
      const { token } = yield* proxy.grant("news", "/var/lib/rejects/.claude", {
        baseUrl: provider.baseUrl,
        headers: { authorization: "Bearer sk-real-model-key" },
      });
      const route = `${origin}${ModelProxy.MODEL_PROXY_PREFIX}`;
      const call = (path: string, authorization?: string) =>
        send(`${route}${path}`, {
          method: "POST",
          headers: authorization === undefined ? {} : { authorization },
          body: "{}",
        });

      assert.strictEqual((yield* call("/v1/messages")).status, 401);
      assert.strictEqual((yield* call("/v1/messages", "Bearer t3bot-not-granted")).status, 401);
      // The real key is not a bot token either.
      assert.strictEqual((yield* call("/v1/messages", "Bearer sk-real-model-key")).status, 401);
      // Only the provider's model API: no other path of the upstream gets the key.
      assert.strictEqual((yield* call("/admin", `Bearer ${token}`)).status, 404);
      assert.strictEqual((yield* call("/v1/%2F..%2Fadmin", `Bearer ${token}`)).status, 404);
      assert.lengthOf(provider.received, 0);

      const response = yield* send(`${route}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "accept-encoding": "gzip, br",
        },
        body: '{"model":"deepseek-v4.1-flash"}',
      });
      assert.strictEqual(response.status, 200);
      const reader = response.body!.getReader();
      const first = yield* Effect.promise(() => reader.read());
      assert.include(new TextDecoder().decode(first.value), "event: one");
      provider.release();
      let rest = "";
      for (let part = yield* Effect.promise(() => reader.read()); !part.done;) {
        rest += new TextDecoder().decode(part.value);
        part = yield* Effect.promise(() => reader.read());
      }
      assert.include(rest, "event: two");

      assert.lengthOf(provider.received, 1);
      const [forwarded] = provider.received;
      assert.strictEqual(forwarded!.url, "/anthropic/v1/messages?beta=true");
      assert.strictEqual(forwarded!.headers.authorization, "Bearer sk-real-model-key");
      assert.strictEqual(forwarded!.headers["anthropic-version"], "2023-06-01");
      assert.strictEqual(forwarded!.body, '{"model":"deepseek-v4.1-flash"}');
      assert.notInclude(JSON.stringify(forwarded!.headers), token);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("sandboxClaudeSettings", () => {
  it("drops every credential the host's settings hold and points the CLI at the route", () => {
    const host = {
      env: {
        ANTHROPIC_BASE_URL: "https://models.example/anthropic/",
        ANTHROPIC_AUTH_TOKEN: "sk-a",
        ANTHROPIC_API_KEY: "sk-b",
        ANTHROPIC_CUSTOM_HEADERS: "x-team-secret: sk-c",
        AWS_SECRET_ACCESS_KEY: "sk-d",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
        ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      },
      apiKeyHelper: "print-key",
      awsAuthRefresh: "refresh",
      otelHeadersHelper: "headers",
      permissions: { allow: ["Bash(ls:*)"] },
    };
    const grant = { url: "http://127.0.0.1:3774/api/bots/model", token: "t3bot-x" };
    assert.deepEqual(ModelProxy.sandboxClaudeSettings(host, grant), {
      env: {
        ANTHROPIC_BASE_URL: grant.url,
        ANTHROPIC_AUTH_TOKEN: "t3bot-x",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
        ANTHROPIC_MODEL: "deepseek-v4.1-flash",
      },
      permissions: { allow: ["Bash(ls:*)"] },
    });
    assert.deepEqual(ModelProxy.claudeUpstream(host, {}), {
      baseUrl: "https://models.example/anthropic",
      headers: {
        "x-team-secret": "sk-c",
        authorization: "Bearer sk-a",
        "x-api-key": "sk-b",
      },
    });
  });
});

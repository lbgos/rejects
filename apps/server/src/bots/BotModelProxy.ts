// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ServerConfig from "../config.ts";
import { runtimeOriginForConfig } from "../serverRuntimeState.ts";

/** The server keeps the provider's real key; a bot's sandbox gets this route's loopback URL and a token that works nowhere else. */
export const MODEL_PROXY_PREFIX = "/api/bots/model";

export interface ModelUpstream {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ModelGrant {
  readonly url: string;
  readonly token: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const claudeUpstream = (
  settings: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): ModelUpstream | undefined => {
  const env: Record<string, unknown> = {
    ...environment,
    ...(isRecord(settings) && isRecord(settings.env) ? settings.env : {}),
  };
  const value = (name: string) => {
    const entry = env[name];
    return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
  };
  const token = value("ANTHROPIC_AUTH_TOKEN");
  const apiKey = value("ANTHROPIC_API_KEY");
  if (token === undefined && apiKey === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const line of value("ANTHROPIC_CUSTOM_HEADERS")?.split("\n") ?? []) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (apiKey !== undefined) headers["x-api-key"] = apiKey;
  const baseUrl = (value("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return { baseUrl, headers };
};

// `*_TOKENS` settings are counts, not credentials.
const CREDENTIAL_NAME = /secret|token(?!s)|key|password|auth|credential|header/i;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi;

const withoutCredentials = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(URL_USERINFO, "$1");
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, entry]) =>
        CREDENTIAL_NAME.test(name) ? [] : [[name, withoutCredentials(entry)]],
      ),
    );
  return value;
};

/**
 * The `settings.json` a bot's sandbox sees for a Claude Code home: the host's without anything
 * that names a credential, and with the model route and the bot's token when it has a grant.
 */
export const sandboxClaudeSettings = (host: unknown, grant: ModelGrant | undefined) => {
  const settings = withoutCredentials(host);
  const clean = isRecord(settings) ? settings : {};
  if (grant === undefined) return clean;
  return {
    ...clean,
    env: {
      ...(isRecord(clean.env) ? clean.env : {}),
      ANTHROPIC_BASE_URL: grant.url,
      ANTHROPIC_AUTH_TOKEN: grant.token,
    },
  };
};

export class BotModelProxy extends Context.Service<
  BotModelProxy,
  {
    /**
     * The route's URL and a bot's token for one provider home. The token holds for the server's
     * lifetime, so a running session keeps it; the upstream is replaced, so a new key applies.
     */
    readonly grant: (
      bot: string,
      home: string,
      upstream: ModelUpstream,
    ) => Effect.Effect<ModelGrant>;
    readonly resolve: (
      token: string,
    ) => Effect.Effect<{ readonly bot: string; readonly upstream: ModelUpstream } | undefined>;
  }
>()("t3/bots/BotModelProxy") {}

const digest = (token: string) => NodeCrypto.createHash("sha256").update(token).digest();

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  // Sandboxes reach this server only on loopback, at the port the network rule lists.
  const url = `${runtimeOriginForConfig(config, config.port)}${MODEL_PROXY_PREFIX}`;
  const grants = new Map<
    string,
    {
      readonly bot: string;
      readonly token: string;
      readonly digest: Buffer;
      upstream: ModelUpstream;
    }
  >();
  return BotModelProxy.of({
    grant: (bot, home, upstream) =>
      Effect.sync(() => {
        const key = `${bot}\0${home}`;
        const existing = grants.get(key);
        if (existing !== undefined) {
          existing.upstream = upstream;
          return { url, token: existing.token };
        }
        const token = `t3bot-${NodeCrypto.randomBytes(32).toString("base64url")}`;
        grants.set(key, { bot, token, digest: digest(token), upstream });
        return { url, token };
      }),
    resolve: (token) =>
      Effect.sync(() => {
        const presented = digest(token);
        for (const entry of grants.values())
          if (NodeCrypto.timingSafeEqual(presented, entry.digest))
            return { bot: entry.bot, upstream: entry.upstream };
        return undefined;
      }),
  });
});

export const layer = Layer.effect(BotModelProxy, make);

/** `/v1/...` only; dot segments and escapes never reach the upstream's other paths. */
const MODEL_PATH = /^\/v1(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
]);

const isLoopback = (address: Option.Option<string>) =>
  Option.isSome(address) && /^(127\.|::1$|::ffff:127\.)/.test(address.value);

/** Anthropic's error shape, so the CLI shows the reason. */
const refusal = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ type: "error", error: { type, message } }, { status });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isLoopback(request.remoteAddress))
    return refusal(403, "permission_error", "The bot model route answers on loopback only.");
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  const presented = bearer ?? request.headers["x-api-key"];
  const proxy = yield* BotModelProxy;
  const granted = presented ? yield* proxy.resolve(presented) : undefined;
  if (granted === undefined)
    return refusal(401, "authentication_error", "This token is not a bot's model token.");
  const url = HttpServerRequest.toURL(request);
  const path = Option.isSome(url) ? url.value.pathname.slice(MODEL_PROXY_PREFIX.length) : "";
  const method =
    request.method === "GET" || request.method === "HEAD" || request.method === "POST"
      ? request.method
      : undefined;
  if (Option.isNone(url) || !MODEL_PATH.test(path) || method === undefined)
    return refusal(404, "not_found_error", "The bot model route forwards /v1 requests only.");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
  const target = `${granted.upstream.baseUrl}${path}${url.value.search}`;
  const forwarded = HttpClientRequest.make(method)(target).pipe(
    HttpClientRequest.setHeaders({ ...headers, ...granted.upstream.headers }),
    method === "POST"
      ? HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        })
      : (self) => self,
  );
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client.execute(forwarded).pipe(Effect.option);
  if (Option.isNone(response)) {
    yield* Effect.logWarning("A bot's model request did not reach its provider", {
      bot: granted.bot,
      upstream: granted.upstream.baseUrl.replace(URL_USERINFO, "$1"),
    });
    return refusal(502, "api_error", "The bot model route could not reach the provider.");
  }
  const answer: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.value.headers))
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) answer[name] = value;
  // Compression would hold back a streamed answer until it ends.
  answer["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    headers: answer,
    ...(answer["content-type"] ? { contentType: answer["content-type"] } : {}),
  });
});

export const routeLayer = HttpRouter.add("*", `${MODEL_PROXY_PREFIX}/*`, handler);

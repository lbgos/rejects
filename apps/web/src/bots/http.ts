import { type EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { connectionAtomRuntime } from "../connection/runtime";
import { countEffect } from "../observability/stuckControl";
import { t } from "../i18n";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

const BotErrorResponse = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeError = Schema.decodeOption(Schema.fromJsonString(BotErrorResponse));
const jsonCodecs = new WeakMap<Schema.Codec<unknown, unknown>, ReturnType<typeof compileJson>>();
function compileJson<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  const json = Schema.fromJsonString(schema);
  return { encode: Schema.encodeUnknownEffect(json), decode: Schema.decodeUnknownEffect(json) };
}
function codecFor<S extends Schema.Codec<unknown, unknown>>(schema: S) {
  const existing = jsonCodecs.get(schema);
  if (existing) return existing as ReturnType<typeof compileJson<S>>;
  const compiled = compileJson(schema);
  jsonCodecs.set(schema, compiled);
  return compiled;
}

export async function postToEnvironment(
  environmentId: EnvironmentId,
  path: `/api/${string}`,
  body:
    | { readonly text: string; readonly contentType: string }
    | { readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType: string },
  signal?: AbortSignal,
): Promise<string> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error(t("Not connected to the environment."));
  countEffect();
  const url = new URL(path, prepared.httpBaseUrl).toString();
  const authorization = prepared.httpAuthorization;
  const effect = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(url).pipe(
      "text" in body
        ? HttpClientRequest.bodyText(body.text, body.contentType)
        : HttpClientRequest.bodyUint8Array(body.bytes, body.contentType),
    );
    if (authorization?._tag === "Bearer")
      request = HttpClientRequest.bearerToken(request, authorization.token);
    if (authorization?._tag === "Dpop") {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const proof = yield* signer.createProof({
        method: "POST",
        url,
        accessToken: authorization.accessToken,
      });
      request = HttpClientRequest.setHeaders(request, {
        authorization: `DPoP ${authorization.accessToken}`,
        dpop: proof,
      });
    }
    const response = yield* http.execute(request);
    return { status: response.status, text: yield* response.text };
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: authorization === null ? "include" : "omit",
    }),
  );
  const result = await executeAtomQuery(appAtomRegistry, connectionAtomRuntime.atom(effect), {
    ...(signal ? { signal } : {}),
    reportFailure: false,
    reportDefect: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const { status, text } = result.value;
  if (status < 200 || status >= 300) {
    const decoded = decodeError(text);
    throw new Error(
      decoded._tag === "Some"
        ? decoded.value.error.message
        : t("Request failed ({status}).", { status }),
    );
  }
  return text;
}

export async function botRequest<
  E extends {
    readonly path: `/api/${string}`;
    readonly payload: Schema.Codec<unknown, unknown>;
    readonly success: Schema.Codec<unknown, unknown>;
    readonly scope: AuthEnvironmentScope;
  },
>(
  environmentId: EnvironmentId,
  endpoint: E,
  payload: E["payload"]["Type"],
  signal?: AbortSignal,
): Promise<E["success"]["Type"]> {
  const text = await Effect.runPromise(codecFor(endpoint.payload).encode(payload));
  const response = await postToEnvironment(
    environmentId,
    endpoint.path,
    { text, contentType: "application/json" },
    signal,
  );
  return Effect.runPromise(codecFor(endpoint.success).decode(response));
}

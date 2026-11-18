// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no Ed25519 public keys.
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { FLEET_HANDOFF_PATH, verifyFleetHandoff } from "@t3tools/shared/fleetHandoff";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

/**
 * Fleet instances sit behind a control plane that signs the user in and form-POSTs a handoff token
 * here. With `T3CODE_FLEET_HANDOFF_PUBLIC_KEY` (PEM) and `T3CODE_FLEET_INSTANCE_ID` set, a valid
 * token opens a browser session without pairing; each token works once. Without them it is off.
 */
export const makeFleetHandoff = (environment: NodeJS.ProcessEnv) => {
  const pem = environment.T3CODE_FLEET_HANDOFF_PUBLIC_KEY?.trim().replaceAll("\\n", "\n");
  const instanceId = environment.T3CODE_FLEET_INSTANCE_ID?.trim();
  if (!pem || !instanceId) return undefined;
  const publicKey = NodeCrypto.createPublicKey(pem);
  // jti -> exp (seconds); kept only until the token would expire anyway.
  const accepted = new Map<string, number>();
  return (token: string, nowMillis: number): boolean => {
    const nowSeconds = Math.floor(nowMillis / 1000);
    for (const [jti, exp] of accepted) if (exp <= nowSeconds) accepted.delete(jti);
    const result = verifyFleetHandoff(token, { instanceId, publicKey, nowSeconds });
    if (!result.ok || accepted.has(result.jti)) return false;
    accepted.set(result.jti, result.exp);
    return true;
  };
};

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const accept = makeFleetHandoff(yield* HostProcess.Environment);
    if (accept === undefined) return Layer.empty;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    return HttpRouter.add(
      "POST",
      FLEET_HANDOFF_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = yield* request.urlParamsBody.pipe(
          Effect.map((params) => Option.getOrUndefined(UrlParams.getFirst(params, "token"))),
          Effect.orElseSucceed(() => undefined),
        );
        if (token === undefined || !accept(token, yield* Clock.currentTimeMillis))
          return HttpServerResponse.text("This sign-in link is invalid or already used.", {
            status: 401,
          });
        const created = yield* serverAuth
          .issueStartupPairingCredential()
          .pipe(
            Effect.flatMap((issued) =>
              serverAuth.createBrowserSession(
                issued.credential,
                deriveAuthClientMetadata({ request }),
              ),
            ),
          );
        return yield* HttpServerResponse.setCookie(
          HttpServerResponse.redirect("/", {
            status: 303,
            headers: { "cache-control": "no-store" },
          }),
          created.cookieName ?? sessions.cookieName,
          created.sessionToken,
          {
            expires: DateTime.toDate(created.response.expiresAt),
            httpOnly: true,
            path: "/",
            sameSite: "lax",
          },
        );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("fleet handoff failed", { cause }).pipe(
            Effect.as(HttpServerResponse.text("Sign-in failed.", { status: 500 })),
          ),
        ),
      ),
    );
  }),
);

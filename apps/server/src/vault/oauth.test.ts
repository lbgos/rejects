import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GMAIL_READONLY_SCOPE } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { FLOW_TTL_MS, googleAuthUrl, grantedReadonly, makeFlows, pkceChallenge } from "./oauth.ts";

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("vault OAuth", (it) => {
  it.effect("derives the S256 challenge of RFC 7636 appendix B", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      );
    }),
  );

  it.effect("matches a state once, and never after it expires", () =>
    Effect.gen(function* () {
      const flows = yield* makeFlows;
      const first = yield* flows.start("gmail");
      const second = yield* flows.start("gmail");
      assert.notStrictEqual(first.state, second.state);
      assert.isAtLeast(first.state.length, 43);
      assert.strictEqual(first.challenge, yield* pkceChallenge(first.verifier));

      assert.strictEqual((yield* flows.consume(first.state))?.verifier, first.verifier);
      assert.isUndefined(yield* flows.consume(first.state));
      assert.isUndefined(yield* flows.consume("forged"));

      yield* TestClock.adjust(FLOW_TTL_MS + 1);
      assert.isUndefined(yield* flows.consume(second.state));
    }),
  );

  it("asks Google for read-only Gmail with PKCE and a refresh token", () => {
    const url = new URL(
      googleAuthUrl({
        clientId: "id.apps.googleusercontent.com",
        redirectUri: "https://host.example:8443/api/connections/callback",
        state: "state",
        challenge: "challenge",
      }),
    );
    assert.strictEqual(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const params = Object.fromEntries(url.searchParams);
    assert.deepInclude(params, {
      scope: GMAIL_READONLY_SCOPE,
      redirect_uri: "https://host.example:8443/api/connections/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state",
    });
  });

  it("refuses a grant without the read-only scope", () => {
    assert.isTrue(grantedReadonly(`openid ${GMAIL_READONLY_SCOPE}`));
    assert.isFalse(grantedReadonly("openid email"));
    assert.isFalse(grantedReadonly(`${GMAIL_READONLY_SCOPE}.extra`));
    assert.isFalse(grantedReadonly(undefined));
  });
});

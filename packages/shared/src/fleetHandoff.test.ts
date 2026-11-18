// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 key pairs.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { signFleetHandoff, verifyFleetHandoff } from "./fleetHandoff.ts";

const control = NodeCrypto.generateKeyPairSync("ed25519");
const other = NodeCrypto.generateKeyPairSync("ed25519");
const NOW = 1_800_000_000;
const token = signFleetHandoff(
  { instanceId: "inst-a", userId: "user_1", nowSeconds: NOW },
  control.privateKey,
);
const expected = { instanceId: "inst-a", publicKey: control.publicKey, nowSeconds: NOW + 10 };

describe("verifyFleetHandoff", () => {
  it("accepts the control plane's token for this instance", () => {
    expect(verifyFleetHandoff(token, expected)).toMatchObject({
      ok: true,
      userId: "user_1",
      exp: NOW + 60,
    });
  });

  it.each([
    {
      case: "another signer",
      token,
      expected: { ...expected, publicKey: other.publicKey },
      reason: "signature",
    },
    {
      case: "another instance",
      token,
      expected: { ...expected, instanceId: "inst-b" },
      reason: "audience",
    },
    {
      case: "after its minute",
      token,
      expected: { ...expected, nowSeconds: NOW + 60 },
      reason: "expired",
    },
    {
      case: "a payload edited after signing",
      token: `${Buffer.from(JSON.stringify({ aud: "inst-a", sub: "user_2", jti: "j", iat: NOW, exp: NOW + 60 })).toString("base64url")}.${token.split(".")[1]}`,
      expected,
      reason: "signature",
    },
    {
      case: "a signed token that claims a longer life",
      token: (() => {
        const body = Buffer.from(
          JSON.stringify({ aud: "inst-a", sub: "user_1", jti: "j", iat: NOW, exp: NOW + 86_400 }),
        ).toString("base64url");
        return `${body}.${NodeCrypto.sign(null, Buffer.from(body), control.privateKey).toString("base64url")}`;
      })(),
      expected,
      reason: "expired",
    },
    { case: "a value that is not a token", token: "abc", expected, reason: "malformed" },
  ])("refuses $case", ({ token: candidate, expected: against, reason }) => {
    expect(verifyFleetHandoff(candidate, against)).toEqual({ ok: false, reason });
  });
});

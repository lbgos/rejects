// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 key pairs.
import * as NodeCrypto from "node:crypto";
import { signFleetHandoff } from "@t3tools/shared/fleetHandoff";
import { describe, expect, it } from "vite-plus/test";

import { makeFleetHandoff } from "./fleetHandoff.ts";

const keys = NodeCrypto.generateKeyPairSync("ed25519");
const NOW = 1_800_000_000;
const env = {
  T3CODE_FLEET_HANDOFF_PUBLIC_KEY: keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  T3CODE_FLEET_INSTANCE_ID: "inst-a",
};
const mint = () =>
  signFleetHandoff({ instanceId: "inst-a", userId: "user_1", nowSeconds: NOW }, keys.privateKey);

describe("makeFleetHandoff", () => {
  it("is off without the key and instance id", () => {
    expect(makeFleetHandoff({})).toBeUndefined();
    expect(makeFleetHandoff({ T3CODE_FLEET_INSTANCE_ID: "inst-a" })).toBeUndefined();
  });

  it("accepts each token once", () => {
    const accept = makeFleetHandoff(env)!;
    const token = mint();
    expect(accept(token, NOW * 1000 + 1_000)).toBe(true);
    expect(accept(token, NOW * 1000 + 2_000)).toBe(false);
    expect(accept(mint(), NOW * 1000 + 3_000)).toBe(true);
  });
});

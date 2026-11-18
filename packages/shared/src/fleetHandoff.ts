// @effect-diagnostics nodeBuiltinImport:off - Ed25519 signing runs on the fleet control plane and the instance server only.
import * as NodeCrypto from "node:crypto";

/**
 * Sign-in handoff from the fleet control plane to one instance. The control plane signs the user in
 * (Clerk), then the browser form-POSTs a short-lived token to the instance's `FLEET_HANDOFF_PATH`;
 * the instance verifies it with the control plane's Ed25519 public key and opens a browser session.
 * Token: `base64url(JSON payload) "." base64url(Ed25519 signature over the first part)`.
 */
export const FLEET_HANDOFF_PATH = "/api/auth/fleet-handoff";
const FLEET_HANDOFF_TTL_SECONDS = 60;

export interface FleetHandoffPayload {
  /** Instance id the token is for. */
  readonly aud: string;
  /** Control-plane user id (the Clerk user id). */
  readonly sub: string;
  /** Random id; the instance accepts each one once. */
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export const signFleetHandoff = (
  input: { readonly instanceId: string; readonly userId: string; readonly nowSeconds: number },
  privateKey: NodeCrypto.KeyObject | string,
): string => {
  const payload: FleetHandoffPayload = {
    aud: input.instanceId,
    sub: input.userId,
    jti: NodeCrypto.randomBytes(16).toString("base64url"),
    iat: input.nowSeconds,
    exp: input.nowSeconds + FLEET_HANDOFF_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${NodeCrypto.sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
};

export type FleetHandoffResult =
  | { readonly ok: true; readonly userId: string; readonly jti: string; readonly exp: number }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "audience" | "expired" };

const isPayload = (value: unknown): value is FleetHandoffPayload =>
  typeof value === "object" &&
  value !== null &&
  "aud" in value &&
  typeof value.aud === "string" &&
  "sub" in value &&
  typeof value.sub === "string" &&
  value.sub.length > 0 &&
  "jti" in value &&
  typeof value.jti === "string" &&
  value.jti.length > 0 &&
  "iat" in value &&
  typeof value.iat === "number" &&
  "exp" in value &&
  typeof value.exp === "number";

export const verifyFleetHandoff = (
  token: string,
  expected: {
    readonly instanceId: string;
    readonly publicKey: NodeCrypto.KeyObject | string;
    readonly nowSeconds: number;
  },
): FleetHandoffResult => {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return { ok: false, reason: "malformed" };
  let valid = false;
  try {
    valid = NodeCrypto.verify(
      null,
      Buffer.from(body),
      expected.publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!valid) return { ok: false, reason: "signature" };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayload(payload)) return { ok: false, reason: "malformed" };
  if (payload.aud !== expected.instanceId) return { ok: false, reason: "audience" };
  // A token that claims a longer life than the control plane issues is not trusted for it.
  if (
    expected.nowSeconds >= payload.exp ||
    payload.exp - payload.iat > FLEET_HANDOFF_TTL_SECONDS ||
    payload.iat > expected.nowSeconds + 5
  )
    return { ok: false, reason: "expired" };
  return { ok: true, userId: payload.sub, jti: payload.jti, exp: payload.exp };
};

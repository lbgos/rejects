/**
 * Pending OAuth flows in the vault. The callback lands in the phone's Safari without rejects'
 * cookie, so the 256-bit `state` is the only thing tying it to a flow: single use, 10 minutes.
 * A bot's connect link names a separate 256-bit handle: opened once, it reveals the state to
 * Google's page, and the callback only completes a flow whose link was opened.
 */
import { GMAIL_READONLY_SCOPE, type OAuthService, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Ref from "effect/Ref";

export const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

export type PendingFlow =
  | { readonly kind: "gmail"; readonly verifier: string; readonly expiresAt: number }
  | {
      readonly kind: "account";
      readonly service: OAuthService;
      readonly botThreadId: ThreadId;
      /** The bot asked from the user's own message, so its continuation may write. */
      readonly writes: boolean;
      readonly handle: string;
      readonly opened: boolean;
      readonly verifier: string;
      readonly challenge: string;
      readonly expiresAt: number;
    };
export type AccountFlow = Extract<PendingFlow, { readonly kind: "account" }>;

export const pkceChallenge = Effect.fn("VaultOAuth.pkceChallenge")(function* (verifier: string) {
  const digest = yield* Digest.Digest;
  return Base64Url.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)));
});

export const googleAuthUrl = (input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    // Offline plus consent returns a refresh token on every connect, also after a revoke.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

/** Google's granular consent lets the user untick the scope; such a grant is refused. */
export const grantedReadonly = (scope: string | undefined) =>
  (scope ?? "").split(/\s+/).includes(GMAIL_READONLY_SCOPE);

export const makeFlows = Effect.gen(function* () {
  const crypto = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const flows = yield* Ref.make(new Map<string, PendingFlow>());
  const random = (bytes: number) => crypto.randomBytes(bytes).pipe(Effect.map(Base64Url.encode));
  const keep = (current: Map<string, PendingFlow>, now: number, state: string, flow: PendingFlow) =>
    new Map([
      ...[...current].filter(([, f]) => f.expiresAt > now).slice(-MAX_PENDING + 1),
      [state, flow],
    ]);
  const byHandle = (current: Map<string, PendingFlow>, handle: string, now: number) =>
    [...current].find(
      (entry): entry is [string, AccountFlow] =>
        entry[1].kind === "account" && entry[1].handle === handle && entry[1].expiresAt > now,
    );
  return {
    /** A bot's connect flow; the bot gets only the handle for its link. */
    link: Effect.fn("VaultOAuth.link")(function* (input: {
      readonly service: OAuthService;
      readonly botThreadId: ThreadId;
      readonly writes: boolean;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* random(32);
      const handle = yield* random(32);
      const verifier = yield* random(32);
      const challenge = yield* pkceChallenge(verifier).pipe(
        Effect.provideService(Digest.Digest, digest),
      );
      const flow: AccountFlow = {
        kind: "account",
        ...input,
        handle,
        opened: false,
        verifier,
        challenge,
        expiresAt: now + FLOW_TTL_MS,
      };
      yield* Ref.update(flows, (current) => keep(current, now, state, flow));
      return { handle, expiresAt: flow.expiresAt };
    }),
    /** The unopened flow behind a link, for the page that asks to continue. */
    peek: Effect.fn("VaultOAuth.peek")(function* (handle: string) {
      const now = yield* Clock.currentTimeMillis;
      const found = byHandle(yield* Ref.get(flows), handle, now);
      return found && !found[1].opened ? found[1] : undefined;
    }),
    /** Marks the link used and returns its state; a second open finds nothing. */
    open: Effect.fn("VaultOAuth.open")(function* (handle: string) {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(flows, (current) => {
        const found = byHandle(current, handle, now);
        if (!found || found[1].opened) return [undefined, current] as const;
        const [state, flow] = found;
        const next = new Map(current);
        next.set(state, { ...flow, opened: true });
        return [{ state, flow }, next] as const;
      });
    }),
    start: Effect.fn("VaultOAuth.start")(function* (kind: "gmail") {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* random(32);
      const verifier = yield* random(32);
      yield* Ref.update(flows, (current) =>
        keep(current, now, state, { kind, verifier, expiresAt: now + FLOW_TTL_MS }),
      );
      const challenge = yield* pkceChallenge(verifier).pipe(
        Effect.provideService(Digest.Digest, digest),
      );
      return { state, verifier, challenge };
    }),
    consume: Effect.fn("VaultOAuth.consume")(function* (state: string) {
      const now = yield* Clock.currentTimeMillis;
      const flow = yield* Ref.modify(flows, (current) => {
        const next = new Map(current);
        const found = next.get(state);
        next.delete(state);
        return [found, next] as const;
      });
      if (flow === undefined || flow.expiresAt <= now) return undefined;
      return flow.kind === "account" && !flow.opened ? undefined : flow;
    }),
  };
});

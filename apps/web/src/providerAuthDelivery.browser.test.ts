import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexAuthDeliveryUrl } from "@t3tools/shared/codexAuthHandoff";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  reloads: 0,
  finishSignIn: null as (() => void) | null,
  requestReload: null as (() => void) | null,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), () => ({
  runAtomCommand: () =>
    new Promise((resolve) => {
      mocks.finishSignIn = () => resolve({ _tag: "Success", value: undefined } as never);
    }),
}));
vi.mock(import("./state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  const connected = Atom.make({ connection: { phase: "connected" } });
  return { environmentPresentations: { presentationAtom: () => connected } } as never;
});
vi.mock(import("./state/server"), () => ({ serverEnvironment: {} }) as never);
vi.mock(import("./components/ui/toast"), () => ({ toastManager: { add: () => "" } }) as never);
vi.mock(import("./workerReload"), async () => {
  const { createWorkerReloadGate } = await import("./workerReloadGate");
  const gate = createWorkerReloadGate(() => {
    mocks.reloads += 1;
  });
  mocks.requestReload = gate.request;
  return { holdWorkerReload: gate.hold };
});

import { startProviderAuthDelivery } from "./providerAuthDelivery";
// Builds the gate the worker message goes through, whether or not the delivery holds it.
import "./workerReload";

const authorizationUrl = () => {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:54213/auth/callback",
    state: "a".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
};
const callbackUrl = `http://127.0.0.1:54213/auth/callback?state=${"a".repeat(43)}&code=one-time-code&client_id=oaiapp_test`;

function setup() {
  const address = window.location.href;
  mocks.reloads = 0;
  mocks.finishSignIn = null;
  return {
    [Symbol.dispose]() {
      window.history.replaceState(null, "", address);
    },
  };
}

it("holds a service worker reload until the ChatGPT sign-in code is spent", async () => {
  using _cleanup = setup();
  const delivery = codexAuthDeliveryUrl(
    {
      authorizationUrl: authorizationUrl(),
      returnUrl: `${window.location.origin}/welcome#agents:remote-environment`,
      environmentId: EnvironmentId.make("remote-environment"),
      instanceId: ProviderInstanceId.make("work-codex"),
      flowId: "flow-one",
    },
    callbackUrl,
  );
  window.history.replaceState(null, "", delivery);
  startProviderAuthDelivery();
  expect(window.location.hash).not.toContain("codex-auth");

  // The worker's update message arrives while the code is only in memory.
  mocks.requestReload?.();
  expect(mocks.reloads).toBe(0);

  mocks.finishSignIn?.();
  await vi.waitFor(() => expect(mocks.reloads).toBe(1));
});

import { flushComposerDraftStorage } from "./composerDraftStore";
import { createWorkerReloadGate } from "./workerReloadGate";

const gate = createWorkerReloadGate(() => {
  // iOS skips `beforeunload`, so drafts are written before the page goes.
  flushComposerDraftStorage();
  location.reload();
});

export const holdWorkerReload = gate.hold;

/** Answers the worker's update message so it leaves the reload to this page. */
export function startWorkerReloadListener(): void {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return;
  container.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data !== "object" || data === null || !("type" in data)) return;
    if (data.type !== "worker-updated") return;
    event.ports[0]?.postMessage("reloading");
    gate.request();
  });
  container.startMessages();
}

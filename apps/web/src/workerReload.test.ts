import { describe, expect, it } from "vite-plus/test";

import { createWorkerReloadGate } from "./workerReloadGate";

describe("worker reload gate", () => {
  it("waits for notification setup to finish before reloading", () => {
    let reloads = 0;
    const gate = createWorkerReloadGate(() => {
      reloads += 1;
    });
    const releasePush = gate.hold();
    const releasePicker = gate.hold();
    gate.request();
    expect(reloads).toBe(0);
    releasePush();
    releasePush();
    expect(reloads).toBe(0);
    releasePicker();
    expect(reloads).toBe(1);
  });

  it("reloads at once when nothing holds it", () => {
    let reloads = 0;
    createWorkerReloadGate(() => {
      reloads += 1;
    }).request();
    expect(reloads).toBe(1);
  });
});

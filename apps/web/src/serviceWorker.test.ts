// @effect-diagnostics nodeBuiltinImport:off - runs the worker script in a VM sandbox.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeWorkerThreads from "node:worker_threads";
import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

// Ports that do not keep the test process alive once the worker stops listening.
class UnrefMessageChannel extends NodeWorkerThreads.MessageChannel {
  constructor() {
    super();
    this.port1.unref();
    this.port2.unref();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startWorker({ replacing, answers }: { replacing: boolean; answers: boolean }) {
  const listeners = new Map<string, (event: unknown) => void>();
  const timers: Array<() => void> = [];
  const navigated: Array<string> = [];
  const posted = deferred();
  const answered = deferred();
  const navigation = deferred();
  let matched = 0;
  const client = {
    url: "https://bots.example/bots",
    postMessage: (_message: unknown, ports: ReadonlyArray<NodeWorkerThreads.MessagePort>) => {
      if (answers) ports[0]?.postMessage("reloading");
      posted.resolve();
    },
    navigate: async (url: string) => {
      navigated.push(url);
      navigation.resolve();
    },
  };
  NodeVM.runInNewContext(source, {
    MessageChannel: UnrefMessageChannel,
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => answered.resolve(),
    self: {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      registration: { active: replacing ? {} : null },
      skipWaiting: async () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () => {
          matched += 1;
          return [client];
        },
      },
    },
  });
  listeners.get("install")?.({});
  const waits: Array<Promise<unknown>> = [];
  listeners.get("activate")?.({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
  return {
    navigated,
    matched: () => matched,
    activated: Promise.all(waits),
    posted: posted.promise,
    answered: answered.promise,
    navigation: navigation.promise,
    fireTimers: () => timers.splice(0).forEach((callback) => callback()),
  };
}

describe("service worker activation", () => {
  it("leaves pages alone on a first install, which runs inside turning on notifications", async () => {
    const worker = startWorker({ replacing: false, answers: false });
    // A reload chain hangs off claim() ahead of this await, so it would have reached matchAll.
    await worker.activated;
    expect(worker.matched()).toBe(0);
    expect(worker.navigated).toEqual([]);
  });

  it("leaves the reload to a page that answers when it replaces an older worker", async () => {
    const worker = startWorker({ replacing: true, answers: true });
    await worker.answered;
    worker.fireTimers();
    await worker.activated;
    expect(worker.navigated).toEqual([]);
  });

  it("reloads a page that does not answer, which runs an older bundle", async () => {
    const worker = startWorker({ replacing: true, answers: false });
    await worker.posted;
    worker.fireTimers();
    await worker.navigation;
    expect(worker.navigated).toEqual(["https://bots.example/bots"]);
  });
});

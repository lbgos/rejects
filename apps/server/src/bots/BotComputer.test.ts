// @effect-diagnostics nodeBuiltinImport:off - runs the remote capper as the computer does.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import { Tool } from "effect/ai";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Config from "../config.ts";
import { ComputerShellToolkit } from "../mcp/toolkits/computer/tools.ts";
import * as Computer from "./BotComputer.ts";
import {
  BotComputerError,
  type BrowserInput,
  browserInputProblem,
  parseShellOutput,
  SHELL_CAP,
  SHELL_OUTPUT_CAP,
} from "./computer.ts";
import * as Machine from "./ComputerMachine.ts";
import { OutputCap, playwrightChord } from "./LocalComputer.ts";

const news = ThreadId.make("news");
const vocab = ThreadId.make("vocab");
const open = (host: string): BrowserInput => ({ action: "open", url: `https://${host}` });

const setup = Effect.gen(function* () {
  const started = yield* Queue.unbounded<string>();
  const log: string[] = [];
  const opened: string[] = [];
  const gates = new Map<string, Deferred.Deferred<void>>();
  const navigating = new Set<ThreadId>();
  const browser = { down: false };
  const browserCall = (entry: string) =>
    browser.down
      ? Effect.fail(new BotComputerError({ detail: "Could not reach the bot computer's browser." }))
      : Effect.sync(() => void log.push(entry));
  const gate = (key: string) => {
    const existing = gates.get(key);
    if (existing) return existing;
    const made = Deferred.makeUnsafe<void>();
    gates.set(key, made);
    return made;
  };
  const reach = (key: string) =>
    Effect.sync(() => log.push(`start ${key}`)).pipe(
      Effect.andThen(Queue.offer(started, key)),
      Effect.andThen(Deferred.await(gate(key))),
      Effect.andThen(Effect.sync(() => log.push(`end ${key}`))),
    );
  const machine = Machine.ComputerMachine.of({
    desktop: (_settings, threadId, input) =>
      reach(`${threadId} ${input.action}`).pipe(Effect.as({ url: "", title: "" })),
    release: (_settings, threadId) => browserCall(`release ${threadId}`),
    browse: (_settings, threadId, input) =>
      reach(`${threadId} ${input.url}`).pipe(
        Effect.as({ result: { url: input.url ?? "", title: "" } }),
      ),
    capture: (_settings, threadId, open) =>
      (navigating.has(threadId) ? reach(`${threadId} capture`) : Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (open) opened.push(threadId);
            return { url: `https://${threadId}.test/`, title: threadId, image: "data:" };
          }),
        ),
      ),
    closeTab: (_settings, threadId) => browserCall(`close ${threadId}`),
    shell: (_settings, threadId, command) =>
      reach(`${threadId} ${command}`).pipe(
        Effect.as({ exitCode: 0, timedOut: false, truncated: false, output: "" }),
      ),
    stopShell: (_settings, threadId) => Effect.sync(() => void log.push(`stop ${threadId}`)),
    putFile: (_settings, _threadId, name) => Effect.succeed(`inbox/${name}`),
    getFile: () => Effect.succeed({ ok: false as const, reason: "missing" as const }),
  });
  const layer = Layer.effect(Computer.BotComputer, Computer.make).pipe(
    Layer.provide(Layer.succeed(Machine.ComputerMachine, machine)),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "bot-computer-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const configure = (enabled: boolean, desktopBridge?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        path.join(stateDir, "bot-computer.json"),
        JSON.stringify({
          enabled,
          host: "bots.test",
          user: "bots",
          identityFile: "/keys/fleet",
          desktopBridge,
        }),
      );
    });
  return { started, log, opened, gate, navigating, browser, layer, configure };
});

it.effect("is off until configured and enabled, and checks input before queueing", () =>
  Effect.gen(function* () {
    const { log, layer, configure } = yield* setup;
    yield* Effect.gen(function* () {
      const computer = yield* Computer.BotComputer;
      const off = yield* Effect.flip(computer.browse(news, open("a.test")));
      assert.match(off.message, /No bot computer is configured/);
      assert.isFalse((yield* computer.screen(news)).available);
      yield* configure(false);
      assert.isFalse((yield* computer.screen(news)).available);
      yield* configure(true);
      const screen = yield* computer.screen(news);
      assert.deepEqual(
        { available: screen.available, url: screen.url, activity: screen.activity },
        { available: true, url: "https://news.test/", activity: null },
      );
      const bad = yield* Effect.flip(computer.browse(news, { action: "open", url: "file:///" }));
      assert.match(bad.message, /http or https/);
      assert.deepEqual(log, []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("runs one task per bot at a time while other bots keep going", () =>
  Effect.gen(function* () {
    const { started, log, gate, layer, configure } = yield* setup;
    yield* Effect.gen(function* () {
      yield* configure(true);
      const computer = yield* Computer.BotComputer;
      const first = yield* computer.browse(news, open("a")).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(started), "news https://a");
      assert.equal((yield* computer.screen(news)).activity, "open https://a");
      const second = yield* computer.shell(news, { command: "ls" }).pipe(Effect.forkChild);
      const other = yield* computer.browse(vocab, open("c")).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(started), "vocab https://c");
      yield* Deferred.succeed(gate("news https://a"), undefined);
      assert.equal(yield* Queue.take(started), "news ls");
      assert.isBelow(log.indexOf("end news https://a"), log.indexOf("start news ls"));
      yield* Deferred.succeed(gate("news ls"), undefined);
      yield* Deferred.succeed(gate("vocab https://c"), undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(other);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stop ends the task and its command, resets the tab, and ignores a down browser", () =>
  Effect.gen(function* () {
    const { started, log, gate, browser, layer, configure } = yield* setup;
    yield* Effect.gen(function* () {
      yield* configure(true);
      const computer = yield* Computer.BotComputer;
      const running = yield* computer
        .shell(news, { command: "sleep 600" })
        .pipe(Effect.flip, Effect.forkChild);
      assert.equal(yield* Queue.take(started), "news sleep 600");
      yield* computer.stop(news, { reset: true });
      assert.match((yield* Fiber.join(running)).message, /user stopped your computer task/);
      assert.isFalse(log.includes("end news sleep 600"));
      assert.deepEqual(log.slice(1), ["stop news", "close news"]);
      assert.isNull((yield* computer.screen(news)).activity);
      yield* Deferred.succeed(gate("news https://b"), undefined);
      assert.equal((yield* computer.browse(news, open("b"))).result.url, "https://b");
      yield* configure(true, "/opt/desktop.py");
      browser.down = true;
      yield* computer.stop(news, { reset: true });
      assert.deepEqual(log.slice(-1), ["stop news"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "takeover interrupts bot work, opens the screen, gates input, and expires after the viewer leaves",
  () =>
    Effect.gen(function* () {
      const { started, opened, gate, layer, configure } = yield* setup;
      yield* Effect.gen(function* () {
        yield* configure(true);
        const computer = yield* Computer.BotComputer;
        assert.match(
          (yield* computer.input(news, { action: "type", text: "hello" }).pipe(Effect.flip))
            .message,
          /Take control/,
        );
        yield* computer.screen(news);
        assert.deepEqual(opened, []);
        const work = yield* computer
          .desktop(news, { action: "wait", seconds: 10 })
          .pipe(Effect.flip, Effect.forkChild);
        assert.equal(yield* Queue.take(started), "news wait");
        yield* computer.control(news, true);
        assert.match((yield* Fiber.join(work)).message, /user stopped/);
        assert.isTrue((yield* computer.screen(news)).controlling);
        assert.deepEqual(opened, ["news"]);
        assert.match(
          (yield* computer.browse(news, open("a")).pipe(Effect.flip)).message,
          /user controls/,
        );
        yield* Deferred.succeed(gate("news type"), undefined);
        yield* computer.input(news, { action: "type", text: "hello" });
        assert.equal(yield* Queue.take(started), "news type");
        yield* computer.control(news, false);
        assert.isFalse((yield* computer.screen(news)).controlling);
        yield* computer.control(news, true);
        const human = yield* computer
          .input(news, { action: "wait", seconds: 10 })
          .pipe(Effect.flip, Effect.forkChild);
        assert.equal(yield* Queue.take(started), "news wait");
        yield* computer.control(news, false);
        assert.match((yield* Fiber.join(human)).message, /user stopped/);
        yield* computer.control(news, true);
        yield* TestClock.adjust("16 seconds");
        assert.isFalse((yield* computer.screen(news)).controlling);
        yield* Deferred.succeed(gate("news https://b"), undefined);
        assert.equal((yield* computer.browse(news, open("b"))).result.url, "https://b");
      }).pipe(Effect.provide(layer));
    }),
);

it("checks tool arguments and reads the remote shell result", () => {
  assert.deepEqual(
    [
      browserInputProblem({ action: "open", url: "https://example.com" }),
      browserInputProblem({ action: "open", url: "javascript:alert(1)" }),
      browserInputProblem({ action: "open" }),
      browserInputProblem({ action: "click" }),
      browserInputProblem({ action: "type", ref: "e2" }),
      browserInputProblem({ action: "type", ref: "e2", text: "" }),
      browserInputProblem({ action: "press" }),
      browserInputProblem({ action: "snapshot", ref: "e9" }),
    ].map((problem) => problem ?? "ok"),
    [
      "ok",
      "open needs an http or https url.",
      "open needs an http or https url.",
      "click needs a ref from the latest snapshot.",
      "type needs a ref from the latest snapshot and text.",
      "ok",
      "press needs text naming a key, such as Enter.",
      "ok",
    ],
  );
  assert.notInclude(
    JSON.stringify(Tool.getJsonSchema(ComputerShellToolkit.tools.computer_shell)),
    "Infinity",
  );
  assert.deepEqual(parseShellOutput("hi\nthere\n3 9"), {
    exitCode: 3,
    timedOut: false,
    truncated: false,
    output: "hi\nthere",
  });
  assert.deepEqual(parseShellOutput(`…\n124 ${SHELL_OUTPUT_CAP + 1}`), {
    exitCode: 124,
    timedOut: true,
    truncated: true,
    output: "…",
  });
  assert.isUndefined(parseShellOutput("ssh: connect to host bots.test port 22"));
});

it("keeps a runaway command's output within the cap as it streams", () => {
  const code = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bot-shell-")),
    "code",
  );
  NodeFS.writeFileSync(code, "7\n");
  const stdout = NodeChildProcess.execFileSync(
    "python3",
    ["-c", SHELL_CAP, String(SHELL_OUTPUT_CAP), code],
    {
      input: `start${"y\n".repeat(5_000_000)}end`,
    },
  ).toString();
  const result = parseShellOutput(stdout)!;
  assert.include(result, { exitCode: 7, truncated: true });
  assert.isBelow(stdout.length, SHELL_OUTPUT_CAP + 64);
  assert.match(result.output, /^start[\s\S]*\n…\n[\s\S]*end$/);
  const local = new OutputCap(SHELL_OUTPUT_CAP);
  for (const chunk of ["start", ..."y\n".repeat(50_000).match(/[\s\S]{1,4096}/g)!, "end"])
    local.push(Buffer.from(chunk));
  assert.isAbove(local.size, SHELL_OUTPUT_CAP);
  assert.isBelow(Buffer.byteLength(local.text()), SHELL_OUTPUT_CAP + 8);
  assert.match(local.text(), /^start[\s\S]*\n…\n[\s\S]*end$/);
});

it("translates xdotool chords to Playwright keys", () => {
  assert.deepEqual(
    ["ctrl+l", "Return", "ctrl+shift+Tab", "BackSpace", "Page_Down", "super+F5", "a"].map(
      playwrightChord,
    ),
    ["Control+l", "Enter", "Control+Shift+Tab", "Backspace", "PageDown", "Meta+F5", "a"],
  );
});

it.effect("shows the running task while a navigating tab cannot be captured", () =>
  Effect.gen(function* () {
    const { started, gate, navigating, layer, configure } = yield* setup;
    yield* Effect.gen(function* () {
      yield* configure(true);
      const computer = yield* Computer.BotComputer;
      const before = yield* computer.screen(news);
      navigating.add(news);
      const task = yield* computer.browse(news, open("slow.test")).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(started), "news https://slow.test");
      const polled = yield* computer.screen(news).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(started), "news capture");
      yield* TestClock.adjust("2 seconds");
      const screen = yield* Fiber.join(polled);
      assert.deepEqual(
        { activity: screen.activity, url: screen.url, image: screen.image },
        { activity: "open https://slow.test", url: before.url, image: before.image },
      );
      yield* Deferred.succeed(gate("news https://slow.test"), undefined);
      yield* Fiber.join(task);
    }).pipe(Effect.provide(layer));
  }),
);

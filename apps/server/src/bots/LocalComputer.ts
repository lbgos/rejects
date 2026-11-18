// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns sandboxed child processes and Playwright outside the Effect runtime.
import type { ComputerAction, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { BotSandbox, type SandboxCommand } from "./BotSandbox.ts";
import {
  BotComputerError,
  type BrowserResult,
  type ComputerSettings,
  GET_SCRIPT,
  parseGetFileOutput,
  PUT_SCRIPT,
  SHELL_OUTPUT_CAP,
  type ShellResult,
} from "./computer.ts";
import {
  abortable,
  act,
  attempt,
  loadPlaywright,
  type MachineShape,
  secretMask,
} from "./ComputerMachine.ts";
import { SECRETS_EXPORT, SECRETS_UNPACK, shellSecretsHeader } from "./shellSecrets.ts";

const VIEWPORT = { width: 1280, height: 800 } as const;
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** The shell's environment: no server variables reach a bot's command. */
const shellEnvironment = (host: NodeJS.ProcessEnv) => ({
  PATH: host.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  LANG: host.LANG ?? "C.UTF-8",
});

export class OutputCap {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private readonly cap: number;
  size = 0;
  constructor(cap: number) {
    this.cap = cap;
  }
  push(chunk: Buffer) {
    this.size += chunk.length;
    const keep = Math.floor(this.cap / 4);
    const room = Math.max(0, keep - this.head.length);
    if (room > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, room)]);
    const rest = chunk.subarray(room);
    const tailCap = this.cap - keep;
    this.tail = Buffer.concat([this.tail, rest]);
    if (this.tail.length > tailCap) this.tail = this.tail.subarray(this.tail.length - tailCap);
  }
  text() {
    const gap = this.size > this.cap ? "\n…\n" : "";
    return `${this.head.toString("utf8")}${gap}${this.tail.toString("utf8")}`;
  }
}

export const playwrightChord = (chord: string) =>
  chord
    .split("+")
    .map((key) => {
      const named: Record<string, string> = {
        ctrl: "Control",
        control: "Control",
        control_l: "Control",
        control_r: "Control",
        alt: "Alt",
        alt_l: "Alt",
        alt_r: "Alt",
        shift: "Shift",
        shift_l: "Shift",
        shift_r: "Shift",
        super: "Meta",
        super_l: "Meta",
        meta: "Meta",
        cmd: "Meta",
        return: "Enter",
        enter: "Enter",
        kp_enter: "Enter",
        backspace: "Backspace",
        escape: "Escape",
        esc: "Escape",
        tab: "Tab",
        delete: "Delete",
        space: "Space",
        up: "ArrowUp",
        down: "ArrowDown",
        left: "ArrowLeft",
        right: "ArrowRight",
        home: "Home",
        end: "End",
        page_up: "PageUp",
        prior: "PageUp",
        page_down: "PageDown",
        next: "PageDown",
        insert: "Insert",
      };
      const lower = key.toLowerCase();
      if (named[lower]) return named[lower];
      if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
      return key;
    })
    .join("+");

const desktopAct = async (
  page: Page,
  input: ComputerAction,
  signal: AbortSignal,
): Promise<BrowserResult> => {
  const mouse = page.mouse;
  switch (input.action) {
    case "screenshot": {
      const png = await page.screenshot({ type: "png", mask: secretMask(page) });
      return {
        url: page.url(),
        title: await page.title(),
        screenshot: {
          mimeType: "image/png",
          data: png.toString("base64"),
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        },
      };
    }
    case "click":
    case "double-click":
      await mouse.click(input.x, input.y, {
        button: input.button ?? "left",
        clickCount: input.action === "double-click" ? 2 : 1,
      });
      break;
    case "drag":
      await mouse.move(input.x, input.y);
      await mouse.down();
      try {
        await mouse.move(input.toX, input.toY, { steps: 10 });
      } finally {
        await mouse.up();
      }
      break;
    case "scroll": {
      const distance = (input.amount ?? 3) * 100;
      await mouse.move(input.x, input.y);
      await mouse.wheel(
        input.direction === "left" ? -distance : input.direction === "right" ? distance : 0,
        input.direction === "up" ? -distance : input.direction === "down" ? distance : 0,
      );
      break;
    }
    case "type":
      await page.keyboard.insertText(input.text);
      break;
    case "key":
      await page.keyboard.press(playwrightChord(input.text));
      break;
    case "wait":
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, input.seconds * 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Computer action stopped"));
          },
          { once: true },
        );
      });
      break;
  }
  return { url: page.url(), title: await page.title() };
};

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const decodePreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Chromium decodes a page that declares no charset as its UI language's legacy default,
 * windows-1252 for en-US, which garbles Cyrillic. The profile's default charset makes it UTF-8.
 */
const preferUtf8 = async (profile: string) => {
  const file = NodePath.join(profile, "Default", "Preferences");
  const text = await NodeFS.promises
    .readFile(file, "utf8")
    .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "{}" : undefined));
  // A file that does not parse stays Chromium's to repair; rewriting it would drop the profile's prefs.
  const preferences = text === undefined ? Option.none() : decodePreferences(text);
  if (Option.isNone(preferences)) return;
  const intl = isRecord(preferences.value.intl) ? preferences.value.intl : {};
  if (intl.charset_default === "UTF-8") return;
  await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.t3-${process.pid}`;
  await NodeFS.promises.writeFile(
    next,
    JSON.stringify({ ...preferences.value, intl: { ...intl, charset_default: "UTF-8" } }),
    { mode: 0o600 },
  );
  await NodeFS.promises.rename(next, file);
};

interface SandboxRun {
  readonly stdout: string;
  readonly size: number;
  readonly stderr: string;
  readonly code: number | null;
}

/** Neither the browser nor the commands have a port or a socket another bot could reach. */
export const makeLocal = Effect.gen(function* () {
  const sandbox = yield* BotSandbox;
  const host = yield* HostProcess.Environment;
  const contexts = new Map<ThreadId, { context: BrowserContext; lastUsed: number }>();
  const launchLock = yield* Semaphore.make(1);
  const shells = new Map<ThreadId, NodeChildProcess.ChildProcess>();

  // Under the launch lock, so a new browser never starts on a profile the old one still writes.
  const closeIdle = launchLock.withPermit(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [threadId, entry] of contexts) {
        if (now - entry.lastUsed <= IDLE_CLOSE_MS) continue;
        contexts.delete(threadId);
        yield* attempt(() => entry.context.close()).pipe(Effect.ignore);
      }
    }),
  );
  yield* closeIdle.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...contexts.values()], (entry) =>
      attempt(() => entry.context.close()).pipe(Effect.ignore),
    ).pipe(Effect.andThen(Effect.sync(() => contexts.clear()))),
  );

  const contextFor = (settings: ComputerSettings, threadId: ThreadId, create: boolean) =>
    launchLock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const known = contexts.get(threadId);
        if (known) {
          known.lastUsed = now;
          return known.context;
        }
        if (!create) return undefined;
        const launch = yield* sandbox.browser(threadId, settings.chromium ?? "chromium");
        if (typeof launch === "string") return yield* new BotComputerError({ detail: launch });
        yield* attempt(() => preferUtf8(launch.profile));
        const context = yield* attempt(() =>
          loadPlaywright().chromium.launchPersistentContext(launch.profile, {
            executablePath: launch.executable,
            headless: true,
            viewport: VIEWPORT,
            args: ["--disable-dev-shm-usage", "--disable-gpu", "--lang=en-US"],
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            timeout: LAUNCH_TIMEOUT_MS,
          }),
        );
        const entry = { context, lastUsed: now };
        contexts.set(threadId, entry);
        context.on("close", () => {
          if (contexts.get(threadId) === entry) contexts.delete(threadId);
        });
        return context;
      }),
    );

  const pageFor = Effect.fn("LocalComputer.pageFor")(function* (
    settings: ComputerSettings,
    threadId: ThreadId,
    create: boolean,
  ) {
    const context = yield* contextFor(settings, threadId, create);
    if (!context) return undefined;
    const page = context.pages()[0];
    if (page || !create) return page;
    return yield* attempt(() => context.newPage());
  });

  const run = Effect.fn("LocalComputer.run")(function* (
    threadId: ThreadId,
    script: string,
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly cap?: number;
      readonly timeoutMs: number;
      readonly command?: boolean;
    },
  ) {
    const launch: SandboxCommand | string = yield* sandbox.shell(threadId);
    if (typeof launch === "string") return yield* new BotComputerError({ detail: launch });
    return yield* Effect.callback<SandboxRun, BotComputerError>((resume) => {
      const child = NodeChildProcess.spawn(
        launch.command,
        [...launch.args, "/bin/sh", "-c", script, "bot-computer", ...args],
        { detached: true, stdio: ["pipe", "pipe", "pipe"], env: shellEnvironment(host) },
      );
      if (options.command) shells.set(threadId, child);
      const kill = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {}
      };
      const capped = options.cap === undefined ? undefined : new OutputCap(options.cap);
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (capped) capped.push(chunk);
        else chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });
      child.once("error", (cause) => {
        if (shells.get(threadId) === child) shells.delete(threadId);
        resume(
          Effect.fail(new BotComputerError({ detail: "The bot sandbox did not start.", cause })),
        );
      });
      child.once("close", (code) => {
        if (shells.get(threadId) === child) shells.delete(threadId);
        const stdout = capped ? capped.text() : Buffer.concat(chunks).toString("utf8");
        resume(Effect.succeed({ stdout, size, stderr, code }));
      });
      child.stdin?.end(options.stdin ?? "");
      return Effect.sync(kill);
    }).pipe(
      // The command's own timeout ends it first; this covers a sandbox that never exits.
      Effect.timeoutOrElse({
        duration: Duration.millis(options.timeoutMs),
        orElse: () =>
          Effect.fail(new BotComputerError({ detail: "The bot sandbox did not finish." })),
      }),
    );
  });

  const machine: MachineShape<ComputerSettings> = {
    desktop: Effect.fn("LocalComputer.desktop")(function* (settings, threadId, input) {
      const page = yield* pageFor(settings, threadId, true);
      if (!page) return yield* new BotComputerError({ detail: "Could not open a tab." });
      return yield* abortable((signal) => desktopAct(page, input, signal));
    }),
    release: Effect.fn("LocalComputer.release")(function* (settings, threadId) {
      const page = yield* pageFor(settings, threadId, false);
      if (!page) return;
      yield* attempt(async () => {
        for (const button of ["left", "middle", "right"] as const)
          await page.mouse.up({ button }).catch(() => undefined);
        for (const key of ["Control", "Alt", "Shift", "Meta"])
          await page.keyboard.up(key).catch(() => undefined);
      });
    }),
    browse: (settings, threadId, input) =>
      pageFor(settings, threadId, true).pipe(
        Effect.flatMap((page) =>
          page
            ? abortable((signal) => act(page, input, signal))
            : Effect.fail(new BotComputerError({ detail: "Could not open a tab." })),
        ),
      ),
    capture: Effect.fn("LocalComputer.capture")(function* (settings, threadId, open) {
      const page = yield* pageFor(settings, threadId, open);
      if (!page) return undefined;
      const jpeg = yield* attempt(() =>
        page.screenshot({ type: "jpeg", quality: 60, mask: secretMask(page) }),
      );
      return {
        url: page.url(),
        title: yield* attempt(() => page.title()),
        image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        height: VIEWPORT.height,
      };
    }),
    closeTab: Effect.fn("LocalComputer.closeTab")(function* (_settings, threadId) {
      const entry = contexts.get(threadId);
      contexts.delete(threadId);
      if (entry) yield* attempt(() => entry.context.close());
    }),
    shell: Effect.fn("LocalComputer.shell")(
      function* (_settings, threadId, command, timeoutSeconds, secrets) {
        if (shells.has(threadId))
          return {
            exitCode: 75,
            timedOut: false,
            truncated: false,
            output:
              "A previous command is still running. Ask the user to stop it from your screen.",
          } satisfies ShellResult;
        // Secrets arrive on stdin and land in the sandbox's own /tmp, which ends with the run.
        const result = yield* run(
          threadId,
          `sec=/tmp/.bot-secrets\n${SECRETS_UNPACK}\nexec /usr/bin/timeout -k 5 "$1" /bin/bash -c '${SECRETS_EXPORT}' bot-cmd "$sec" "$2" 2>&1`,
          [String(timeoutSeconds), command],
          {
            stdin: shellSecretsHeader(secrets),
            cap: SHELL_OUTPUT_CAP,
            timeoutMs: (timeoutSeconds + 45) * 1000,
            command: true,
          },
        );
        const exitCode = result.code ?? 137;
        return {
          exitCode,
          timedOut: exitCode === 124,
          truncated: result.size > SHELL_OUTPUT_CAP,
          // The command's own stderr is in stdout; stderr holds only the sandbox's own errors.
          output: result.size === 0 && exitCode !== 0 ? result.stderr.trim() : result.stdout,
        } satisfies ShellResult;
      },
    ),
    stopShell: (_settings, threadId) =>
      Effect.sync(() => {
        const child = shells.get(threadId);
        if (child?.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }),
    putFile: Effect.fn("LocalComputer.putFile")(function* (_settings, threadId, name, bytes) {
      const base = NodePath.basename(name);
      const { stdout } = yield* run(
        threadId,
        PUT_SCRIPT,
        [".", base === "" || base === "." || base === ".." ? "file" : base],
        {
          stdin: Buffer.from(bytes).toString("base64"),
          timeoutMs: 30_000 + bytes.length / 1000,
        },
      );
      if (!stdout.startsWith("inbox/"))
        return yield* new BotComputerError({ detail: "The bot computer did not save the file." });
      return stdout.trim();
    }),
    getFile: Effect.fn("LocalComputer.getFile")(function* (_settings, threadId, file, maxBytes) {
      const { stdout } = yield* run(threadId, GET_SCRIPT, [".", file, String(maxBytes)], {
        timeoutMs: 30_000 + maxBytes / 1000,
      });
      const result = parseGetFileOutput(stdout);
      if (!result) return yield* new BotComputerError({ detail: "The bot computer sent no file." });
      return result;
    }),
  };
  return machine;
});

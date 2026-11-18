// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns Playwright resources outside the Effect runtime.
import { type ComputerAction, type ThreadId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Net from "@t3tools/shared/Net";
import { runSshCommand } from "@t3tools/ssh/command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { constVoid } from "effect/Function";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeModule from "node:module";
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright-core";
import * as ServerConfig from "../config.ts";
import { quoteRemoteArg } from "../device/sshDeviceScript.ts";
import { CHALLENGE_PROBE, type PageSignals, waitOutChallenge } from "./challenge.ts";
import {
  BotComputerError,
  type BrowserInput,
  type BrowserOutcome,
  BrowserResult,
  type ComputerSettings,
  type RemoteSettings,
  cutSnapshot,
  GET_SCRIPT,
  type GetFileResult,
  parseGetFileOutput,
  parseShellOutput,
  PUT_SCRIPT,
  SECRETS_CLEANUP,
  SHELL_OUTPUT_CAP,
  SHELL_SCRIPT,
  type ShellResult,
  shellUnit,
  slugFor,
} from "./computer.ts";
import { type ShellSecret, shellSecretsHeader } from "./shellSecrets.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
export const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/** The computer's Chromium serves CDP here, on its loopback only. */
const CDP_PORT = 9222;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

export interface Capture {
  readonly url: string;
  readonly title: string;
  readonly image: string;
  readonly height?: number;
}

export interface MachineShape<S> {
  readonly desktop: (
    settings: S,
    threadId: ThreadId,
    input: ComputerAction,
  ) => Effect.Effect<BrowserResult, BotComputerError>;
  readonly release: (settings: S, threadId: ThreadId) => Effect.Effect<void, BotComputerError>;
  readonly browse: (
    settings: S,
    threadId: ThreadId,
    input: BrowserInput,
  ) => Effect.Effect<BrowserOutcome, BotComputerError>;
  readonly capture: (
    settings: S,
    threadId: ThreadId,
    open: boolean,
  ) => Effect.Effect<Capture | undefined, BotComputerError>;
  readonly closeTab: (settings: S, threadId: ThreadId) => Effect.Effect<void, BotComputerError>;
  readonly shell: (
    settings: S,
    threadId: ThreadId,
    command: string,
    timeoutSeconds: number,
    secrets: ReadonlyArray<ShellSecret>,
  ) => Effect.Effect<ShellResult, BotComputerError>;
  readonly stopShell: (settings: S, threadId: ThreadId) => Effect.Effect<void, BotComputerError>;
  readonly putFile: (
    settings: S,
    threadId: ThreadId,
    name: string,
    bytes: Uint8Array,
  ) => Effect.Effect<string, BotComputerError>;
  readonly getFile: (
    settings: S,
    threadId: ThreadId,
    path: string,
    maxBytes: number,
  ) => Effect.Effect<GetFileResult, BotComputerError>;
}

export class ComputerMachine extends Context.Service<
  ComputerMachine,
  MachineShape<ComputerSettings>
>()("t3/bots/ComputerMachine") {}

const identityArgs = (identityFile: string) => [
  "-i",
  identityFile,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
];
/** The CDP tunnel's login: the browser's own account when set, so bot shells never reach CDP. */
const tunnelLogin = (settings: RemoteSettings) => ({
  user: settings.browserUser ?? settings.user,
  identityFile: settings.browserIdentityFile ?? settings.identityFile,
});
const sshTarget = (settings: RemoteSettings) => ({
  alias: settings.host,
  hostname: settings.host,
  username: settings.user,
  port: settings.port ?? null,
});

const failure = (fallback: string) => (cause: unknown) =>
  new BotComputerError({
    detail: (cause instanceof Error && cause.message.split("\n")[0]) || fallback,
    cause,
  });
export const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: failure("The bot computer did not respond.") });
/**
 * Playwright has no cancel. An interrupt aborts `signal` and waits for the call to settle, so a
 * stopped action never overlaps the bot's next one or the user's takeover input.
 */
export const abortable = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.suspend(() => {
    const controller = new AbortController();
    const promise = run(controller.signal);
    return attempt(() => promise).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => controller.abort()).pipe(
          Effect.andThen(Effect.promise(() => promise.then(constVoid, constVoid))),
        ),
      ),
    );
  });
const unlessAborted = <A>(signal: AbortSignal, promise: Promise<A>) =>
  new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
/**
 * Waits in short tries until the target is ready, checking for a stop between them, so a click
 * on a button that is still disabled cannot fire after the user stopped the bot.
 */
const READY_TRY_MS = 500;
const ready = async (signal: AbortSignal, check: () => Promise<void>) => {
  for (let tries = ACTION_TIMEOUT_MS / READY_TRY_MS; ; tries--) {
    signal.throwIfAborted();
    try {
      return await check();
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "TimeoutError") || tries <= 1) throw cause;
    }
  }
};
const clickable = (locator: Locator) => () => locator.click({ trial: true, timeout: READY_TRY_MS });
const visible = (locator: Locator) => () =>
  locator.waitFor({ state: "visible", timeout: READY_TRY_MS });

const targetIds = new WeakMap<Page, string>();
const targetIdOf = async (context: BrowserContext, page: Page) => {
  const known = targetIds.get(page);
  if (known) return known;
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(constVoid);
  }
};
const findPage = async (context: BrowserContext, targetId: string) => {
  for (const page of context.pages())
    if ((await targetIdOf(context, page)) === targetId) return page;
  return undefined;
};

/**
 * Each bot's tab gets its own window. Headless Chromium renders only a window's active tab, so a
 * background tab never answers a screenshot.
 */
const openWindow = async (browser: Browser, context: BrowserContext) => {
  const session = await browser.newBrowserCDPSession();
  // The page event can arrive before createTarget answers, so the waiter starts first.
  const created = Promise.withResolvers<string>();
  const opened = context.waitForEvent("page", {
    predicate: async (page) => (await targetIdOf(context, page)) === (await created.promise),
    timeout: ACTION_TIMEOUT_MS,
  });
  try {
    const { targetId } = await session.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    created.resolve(targetId);
    return await opened;
  } catch (cause) {
    opened.catch(constVoid);
    throw cause;
  } finally {
    await session.detach().catch(constVoid);
  }
};

const followPopup = async (page: Page, run: () => Promise<void>) => {
  const popups: Page[] = [];
  const adopt = (popup: Page) => void popups.push(popup);
  page.on("popup", adopt);
  try {
    await run();
    // A click's navigation starts after the click resolves.
    await page.waitForTimeout(300);
  } finally {
    page.off("popup", adopt);
  }
  const popup = popups[0];
  if (!popup) return;
  await popup.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(constVoid);
  const url = popup.url();
  await Promise.all(popups.map((p) => p.close().catch(constVoid)));
  if (/^https?:/i.test(url))
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
};

/** Password fields are masked in every screenshot. */
export const secretMask = (page: Page) => [page.locator("input[type=password]")];

/** Rejects when `signal` aborts, so a stopped bot does not wait out a check. */
const pause = (signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });

export const act = async (
  page: Page,
  input: BrowserInput,
  signal: AbortSignal,
): Promise<BrowserOutcome> => {
  const target = () => page.locator(`aria-ref=${input.ref}`);
  // Only a page a navigation brought is checked for a human check, so one the user already
  // passed on this page does not hand it back again.
  let navigated = input.action === "open" || input.action === "back";
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on("framenavigated", onNavigated);
  try {
    switch (input.action) {
      case "open":
        await unlessAborted(
          signal,
          page.goto(input.url!, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }),
        );
        break;
      case "back":
        await unlessAborted(
          signal,
          page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }),
        );
        break;
      case "click":
        await ready(signal, clickable(target()));
        await followPopup(page, () => target().click({ timeout: ACTION_TIMEOUT_MS }));
        break;
      case "type":
        await ready(signal, visible(target()));
        await target().fill(input.text!, { timeout: ACTION_TIMEOUT_MS });
        break;
      case "press":
        signal.throwIfAborted();
        await followPopup(page, () => page.keyboard.press(input.text!));
        break;
      case "screenshot": {
        const png = await page.screenshot({
          type: "png",
          timeout: ACTION_TIMEOUT_MS,
          mask: secretMask(page),
        });
        return {
          result: {
            url: page.url(),
            title: await page.title(),
            screenshot: {
              mimeType: "image/png",
              data: png.toString("base64"),
              width: png.readUInt32BE(16),
              height: png.readUInt32BE(20),
            },
          },
        };
      }
      case "snapshot":
        break;
    }
  } finally {
    page.off("framenavigated", onNavigated);
  }
  signal.throwIfAborted();
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(constVoid);
  const challenge = navigated
    ? await waitOutChallenge(
        () => page.evaluate(CHALLENGE_PROBE) as Promise<PageSignals>,
        (ms) => pause(signal, ms),
      )
    : undefined;
  const scope = input.action === "snapshot" && input.ref ? target() : page;
  const snapshot = await scope.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
  const frame =
    input.action === "snapshot"
      ? undefined
      : await page
          .screenshot({
            type: "jpeg",
            quality: 50,
            timeout: ACTION_TIMEOUT_MS,
            mask: secretMask(page),
          })
          .catch(() => undefined);
  return {
    result: { url: page.url(), title: await page.title(), snapshot: cutSnapshot(snapshot) },
    challenge,
    frame,
  };
};

interface Connection {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly browser: Browser;
}

const Tabs = Schema.Record(Schema.String, Schema.String);
const decodeTabs = Schema.decodeUnknownEffect(Schema.fromJsonString(Tabs));
const encodeTabs = Schema.encodeEffect(Schema.fromJsonString(Tabs));
const decodeDesktop = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      display: Schema.optional(Schema.String),
      screenshot: BrowserResult.fields.screenshot,
    }),
  ),
);

const remoteSettings = (
  settings: ComputerSettings,
): Effect.Effect<RemoteSettings, BotComputerError> => {
  const { host, user, identityFile } = settings;
  return host && user && identityFile
    ? Effect.succeed({ ...settings, host, user, identityFile })
    : Effect.fail(
        new BotComputerError({
          detail: "bot-computer.json on the server needs host, user and identityFile.",
        }),
      );
};

export const makeRemote = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const tabsFile = path.join(config.stateDir, "bot-computer-tabs.json");
  let tabs = yield* fs.readFileString(tabsFile).pipe(
    Effect.flatMap(decodeTabs),
    Effect.orElseSucceed((): typeof Tabs.Type => ({})),
  );
  const tabsLock = yield* Semaphore.make(1);
  const saveTabs = (next: typeof Tabs.Type) =>
    encodeTabs(next).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: tabsFile, contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tap(() =>
        Effect.sync(() => {
          tabs = next;
        }),
      ),
      Effect.mapError(failure("Could not save the bot tab list.")),
    );

  let connection: Connection | undefined;
  const connectLock = yield* Semaphore.make(1);
  const disconnect = Effect.suspend(() => {
    const current = connection;
    connection = undefined;
    return current
      ? attempt(() => current.browser.close()).pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(current.scope, Exit.void)),
        )
      : Effect.void;
  });
  yield* Effect.addFinalizer(() => disconnect);

  const browserFor = (settings: ComputerSettings) =>
    connectLock.withPermit(
      Effect.gen(function* () {
        const remote = yield* remoteSettings(settings);
        const login = tunnelLogin(remote);
        const key = `${login.user}@${remote.host}:${remote.port ?? 22}/${remote.browserPort ?? CDP_PORT} ${login.identityFile}`;
        if (connection?.key === key && connection.browser.isConnected()) return connection.browser;
        yield* disconnect;
        const port = yield* net
          .reserveLoopbackPort()
          .pipe(Effect.mapError(failure("No local port for the bot computer tunnel.")));
        const scope = yield* Scope.make();
        const browser = yield* Effect.gen(function* () {
          yield* spawner
            .spawn(
              ChildProcess.make(
                "ssh",
                [
                  "-o",
                  "BatchMode=yes",
                  "-o",
                  "ConnectTimeout=10",
                  ...identityArgs(login.identityFile),
                  "-o",
                  "ExitOnForwardFailure=yes",
                  "-o",
                  "ServerAliveInterval=15",
                  "-o",
                  "ServerAliveCountMax=3",
                  ...(settings.port ? ["-p", String(settings.port)] : []),
                  "-n",
                  "-N",
                  "-L",
                  `127.0.0.1:${port}:127.0.0.1:${settings.browserPort ?? CDP_PORT}`,
                  "--",
                  `${login.user}@${remote.host}`,
                ],
                { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
              ),
            )
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(failure("Could not start the bot computer tunnel.")),
            );
          return yield* Effect.tryPromise({
            try: () =>
              loadPlaywright().chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
                timeout: 5_000,
              }),
            catch: failure("Could not reach the bot computer's browser."),
          }).pipe(Effect.retry({ times: 30, schedule: Schedule.spaced("500 millis") }));
        }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        connection = { key, scope, browser };
        return browser;
      }),
    );

  const pageFor = Effect.fn("ComputerMachine.pageFor")(function* (
    settings: ComputerSettings,
    threadId: ThreadId,
    create: boolean,
  ) {
    const browser = yield* browserFor(settings);
    const context = browser.contexts()[0];
    if (!context)
      return yield* new BotComputerError({ detail: "The bot computer's browser has no window." });
    return yield* tabsLock.withPermit(
      Effect.gen(function* () {
        const known = tabs[threadId];
        const found = known ? yield* attempt(() => findPage(context, known)) : undefined;
        if (found || !create) return found;
        const page = yield* attempt(() => openWindow(browser, context));
        yield* saveTabs({ ...tabs, [threadId]: yield* attempt(() => targetIdOf(context, page)) });
        return page;
      }),
    );
  });

  const ssh = (
    settings: ComputerSettings,
    remote: ReadonlyArray<string>,
    options?: { readonly stdin: string; readonly timeoutMs: number },
  ) =>
    Effect.flatMap(remoteSettings(settings), (target) =>
      runSshCommand(sshTarget(target), {
        batchMode: "yes",
        preHostArgs: identityArgs(target.identityFile),
        remoteCommandArgs: remote,
        ...options,
      }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const stopShell = (settings: ComputerSettings, threadId: ThreadId) =>
    ssh(settings, [
      `systemctl --user stop ${quoteRemoteArg(shellUnit(threadId))} 2>/dev/null; sh -c ${quoteRemoteArg(SECRETS_CLEANUP)} bot-shell ${quoteRemoteArg(slugFor(threadId))}; true`,
    ]).pipe(Effect.asVoid, Effect.mapError(failure("Could not reach the bot computer.")));

  const desktopCall = Effect.fn("ComputerMachine.desktopCall")(function* (
    settings: ComputerSettings,
    threadId: ThreadId,
    input: ComputerAction | { action: "ensure" | "close" | "release" },
  ) {
    if (!settings.desktopBridge)
      return yield* new BotComputerError({ detail: "The desktop bridge is not configured." });
    const page =
      input.action === "close"
        ? undefined
        : yield* pageFor(settings, threadId, input.action !== "release");
    if (input.action === "release" && !page) return {};
    const targetId = page ? yield* attempt(() => targetIdOf(page.context(), page)) : undefined;
    // The bridge accepts a discriminated action plus server-owned routing fields.
    // @effect-diagnostics-next-line globalJsonInEffect:off - routing fields accompany the schema-validated action on this private SSH bridge.
    const body = JSON.stringify({ ...input, id: slugFor(threadId), targetId });
    const result = yield* ssh(settings, ["python3", settings.desktopBridge, "call"], {
      stdin: body,
      timeoutMs: 30000,
    }).pipe(Effect.mapError(failure("Could not reach the desktop bridge.")));
    return yield* decodeDesktop(result.stdout).pipe(
      Effect.mapError(failure("The desktop sent an invalid response.")),
    );
  });

  const remote: MachineShape<ComputerSettings> = {
    desktop: Effect.fn("ComputerMachine.desktop")(function* (settings, threadId, input) {
      const result = yield* desktopCall(settings, threadId, input);
      const page = yield* pageFor(settings, threadId, false);
      return {
        url: page?.url() ?? "",
        title: page ? yield* attempt(() => page.title()) : "",
        ...result,
      };
    }),
    release: (settings, threadId) =>
      settings.desktopBridge
        ? desktopCall(settings, threadId, { action: "release" }).pipe(Effect.asVoid)
        : Effect.void,
    browse: (settings, threadId, input) =>
      pageFor(settings, threadId, true).pipe(
        Effect.flatMap((page) =>
          page
            ? abortable((signal) => act(page, input, signal))
            : Effect.fail(new BotComputerError({ detail: "Could not open a tab." })),
        ),
      ),
    capture: Effect.fn("ComputerMachine.capture")(function* (settings, threadId, open) {
      const existing = yield* pageFor(settings, threadId, false);
      if (!existing && open && settings.desktopBridge)
        yield* desktopCall(settings, threadId, { action: "ensure" });
      const page = existing ?? (yield* pageFor(settings, threadId, open));
      if (!page) return undefined;
      if (settings.desktopBridge) {
        const result = yield* desktopCall(settings, threadId, { action: "screenshot" });
        return {
          url: page.url(),
          title: yield* attempt(() => page.title()),
          image: result.screenshot ? `data:image/png;base64,${result.screenshot.data}` : "",
        };
      }
      const jpeg = yield* attempt(() =>
        page.screenshot({
          type: "jpeg",
          quality: 60,
          timeout: ACTION_TIMEOUT_MS,
          mask: secretMask(page),
        }),
      );
      return {
        url: page.url(),
        title: yield* attempt(() => page.title()),
        image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      };
    }),
    closeTab: Effect.fn("ComputerMachine.closeTab")(function* (settings, threadId) {
      if (settings.desktopBridge) yield* desktopCall(settings, threadId, { action: "close" });
      const page = yield* pageFor(settings, threadId, false);
      if (page) yield* attempt(() => page.close());
      yield* tabsLock.withPermit(
        Effect.suspend(() => {
          const { [threadId]: _closed, ...rest } = tabs;
          return _closed === undefined ? Effect.void : saveTabs(rest);
        }),
      );
    }),
    shell: Effect.fn("ComputerMachine.shell")(
      function* (settings, threadId, command, timeoutSeconds, secrets) {
        const desktop = settings.desktopBridge
          ? yield* desktopCall(settings, threadId, { action: "ensure" })
          : undefined;
        return yield* ssh(
          settings,
          [
            "sh",
            "-c",
            quoteRemoteArg(SHELL_SCRIPT),
            "bot-shell",
            slugFor(threadId),
            String(timeoutSeconds),
            String(SHELL_OUTPUT_CAP),
          ],
          // The remote timeout ends the command; this one covers a lost connection.
          {
            stdin:
              shellSecretsHeader(secrets) +
              (desktop?.display
                ? `export DISPLAY=${quoteRemoteArg(desktop.display)}\n${command}`
                : command),
            timeoutMs: (timeoutSeconds + 45) * 1000,
          },
        ).pipe(
          Effect.mapError(failure("Could not run the command on the bot computer.")),
          Effect.flatMap(({ stdout }) => {
            const result = parseShellOutput(stdout);
            return result
              ? Effect.succeed(result)
              : Effect.fail(new BotComputerError({ detail: "The bot computer sent no result." }));
          }),
          // An interrupted call must not leave its command running on the computer.
          Effect.onInterrupt(() => stopShell(settings, threadId).pipe(Effect.ignore)),
        );
      },
    ),
    stopShell,
    putFile: Effect.fn("ComputerMachine.putFile")(function* (settings, threadId, name, bytes) {
      const { stdout } = yield* ssh(
        settings,
        [
          "sh",
          "-c",
          quoteRemoteArg(PUT_SCRIPT),
          "bot-put",
          slugFor(threadId),
          quoteRemoteArg(name),
        ],
        // About 1 MB/s over a slow link, plus a margin for the connection.
        { stdin: Buffer.from(bytes).toString("base64"), timeoutMs: 30_000 + bytes.length / 1000 },
      ).pipe(Effect.mapError(failure("Could not copy the file to the bot computer.")));
      if (!stdout.startsWith("inbox/"))
        return yield* new BotComputerError({ detail: "The bot computer did not save the file." });
      return stdout.trim();
    }),
    getFile: Effect.fn("ComputerMachine.getFile")(function* (settings, threadId, path, maxBytes) {
      const { stdout } = yield* ssh(
        settings,
        [
          "sh",
          "-c",
          quoteRemoteArg(GET_SCRIPT),
          "bot-get",
          slugFor(threadId),
          quoteRemoteArg(path),
          String(maxBytes),
        ],
        { stdin: "", timeoutMs: 30_000 + maxBytes / 1000 },
      ).pipe(Effect.mapError(failure("Could not read the file on the bot computer.")));
      const result = parseGetFileOutput(stdout);
      if (!result) return yield* new BotComputerError({ detail: "The bot computer sent no file." });
      return result;
    }),
  };
  return remote;
});

export const dispatch = (
  remote: MachineShape<ComputerSettings>,
  local: MachineShape<ComputerSettings>,
  sandboxed: Effect.Effect<boolean>,
): MachineShape<ComputerSettings> => {
  const machine = Effect.map(sandboxed, (on) => (on ? local : remote));
  return {
    desktop: (s, t, input) => Effect.flatMap(machine, (m) => m.desktop(s, t, input)),
    release: (s, t) => Effect.flatMap(machine, (m) => m.release(s, t)),
    browse: (s, t, input) => Effect.flatMap(machine, (m) => m.browse(s, t, input)),
    capture: (s, t, open) => Effect.flatMap(machine, (m) => m.capture(s, t, open)),
    closeTab: (s, t) => Effect.flatMap(machine, (m) => m.closeTab(s, t)),
    shell: (s, t, command, timeout, secrets) =>
      Effect.flatMap(machine, (m) => m.shell(s, t, command, timeout, secrets)),
    stopShell: (s, t) => Effect.flatMap(machine, (m) => m.stopShell(s, t)),
    putFile: (s, t, name, bytes) => Effect.flatMap(machine, (m) => m.putFile(s, t, name, bytes)),
    getFile: (s, t, file, maxBytes) =>
      Effect.flatMap(machine, (m) => m.getFile(s, t, file, maxBytes)),
  };
};

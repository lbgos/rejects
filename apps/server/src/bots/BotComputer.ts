import type { BotScreen, ComputerAction, ThreadId } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import {
  activityLabel,
  BotComputerError,
  type BrowserInput,
  type BrowserOutcome,
  type BrowserResult,
  browserInputProblem,
  ComputerSettings,
  type GetFileResult,
  type ShellInput,
  SHELL_DEFAULT_TIMEOUT_SECONDS,
  type ShellResult,
} from "./computer.ts";
import { BotSandbox } from "./BotSandbox.ts";
import * as Machine from "./ComputerMachine.ts";
import { makeLocal } from "./LocalComputer.ts";
import type { ShellSecret } from "./shellSecrets.ts";

const OFF =
  "No bot computer is configured on this server, so nothing ran. Tell the user in one line if your job needs a browser or shell, and do not call computer tools again this turn.";
const STOPPED =
  "The user stopped your computer task. Do not retry it; say what you were doing and wait.";

export class BotComputer extends Context.Service<
  BotComputer,
  {
    readonly desktop: (
      threadId: ThreadId,
      input: ComputerAction,
    ) => Effect.Effect<BrowserResult, BotComputerError>;
    readonly control: (
      threadId: ThreadId,
      active: boolean,
    ) => Effect.Effect<void, BotComputerError>;
    readonly input: (
      threadId: ThreadId,
      input: ComputerAction,
    ) => Effect.Effect<void, BotComputerError>;
    readonly browse: (
      threadId: ThreadId,
      input: BrowserInput,
    ) => Effect.Effect<BrowserOutcome, BotComputerError>;
    readonly shell: (
      threadId: ThreadId,
      input: ShellInput,
      secrets?: ReadonlyArray<ShellSecret>,
    ) => Effect.Effect<ShellResult, BotComputerError>;
    /** Captures the bot's tab now. Not queued, so it shows the screen while a task runs. */
    readonly screen: (threadId: ThreadId) => Effect.Effect<BotScreen, BotComputerError>;
    readonly putFile: (
      threadId: ThreadId,
      name: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string | undefined, BotComputerError>;
    readonly getFile: (
      threadId: ThreadId,
      path: string,
      maxBytes: number,
    ) => Effect.Effect<GetFileResult, BotComputerError>;
    readonly stop: (
      threadId: ThreadId,
      options: { readonly reset: boolean },
    ) => Effect.Effect<void, BotComputerError>;
  }
>()("t3/bots/BotComputer") {}

interface Slot {
  readonly lock: Semaphore.Semaphore;
  stop: Deferred.Deferred<void>;
  activity: string | null;
  controlUntil: number;
}

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerSettings));

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const machine = yield* Machine.ComputerMachine;
  const file = path.join(config.stateDir, "bot-computer.json");
  // Read per call, like cortex-mcp.json: enabling or editing it needs no restart.
  const settings = fs.readFileString(file).pipe(
    Effect.flatMap(decodeSettings),
    Effect.map((s) => (s.enabled ? s : null)),
    Effect.catchTags({
      PlatformError: (e) => (e.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(e)),
    }),
    Effect.mapError(
      (cause) =>
        new BotComputerError({ detail: "bot-computer.json on the server is invalid.", cause }),
    ),
  );
  const slots = new Map<ThreadId, Slot>();
  const captures = new Map<ThreadId, Machine.Capture>();
  const slotFor = (threadId: ThreadId) => {
    const existing = slots.get(threadId);
    if (existing) return existing;
    const slot: Slot = {
      lock: Semaphore.makeUnsafe(1),
      stop: Deferred.makeUnsafe<void>(),
      activity: null,
      controlUntil: 0,
    };
    slots.set(threadId, slot);
    return slot;
  };
  const run = Effect.fn("BotComputer.run")(function* <A>(
    threadId: ThreadId,
    input: BrowserInput | ShellInput | ComputerAction,
    task: (settings: ComputerSettings) => Effect.Effect<A, BotComputerError>,
  ) {
    const current = yield* settings;
    if (!current) return yield* new BotComputerError({ detail: OFF });
    const slot = slotFor(threadId);
    const stopped = slot.stop;
    return yield* Effect.raceFirst(
      slot.lock.withPermit(
        Effect.gen(function* () {
          if (slot.controlUntil > (yield* Clock.currentTimeMillis))
            return yield* new BotComputerError({
              detail: "The user controls your screen. Wait until they hand it back.",
            });
          slot.activity = activityLabel(input);
          return yield* task(current);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              slot.activity = null;
            }),
          ),
        ),
      ),
      Deferred.await(stopped).pipe(
        Effect.andThen(Effect.fail(new BotComputerError({ detail: STOPPED }))),
      ),
    );
  });
  return BotComputer.of({
    desktop: (threadId, input) => run(threadId, input, (s) => machine.desktop(s, threadId, input)),
    control: Effect.fn("BotComputer.control")(function* (threadId, active) {
      const slot = slotFor(threadId);
      const wasActive = slot.controlUntil > (yield* Clock.currentTimeMillis);
      slot.controlUntil = active ? (yield* Clock.currentTimeMillis) + 15000 : 0;
      if (active && wasActive) return;
      const stopped = slot.stop;
      slot.stop = Deferred.makeUnsafe<void>();
      yield* Deferred.succeed(stopped, undefined);
      const current = yield* settings;
      if (!current) return;
      yield* machine.stopShell(current, threadId);
      yield* machine.release(current, threadId);
    }),
    input: Effect.fn("BotComputer.input")(function* (threadId, input) {
      const current = yield* settings;
      if (!current) return yield* new BotComputerError({ detail: OFF });
      const slot = slotFor(threadId);
      const stopped = slot.stop;
      yield* Effect.raceFirst(
        slot.lock.withPermit(
          Effect.gen(function* () {
            if (slot.controlUntil <= (yield* Clock.currentTimeMillis))
              return yield* new BotComputerError({ detail: "Take control of the screen first." });
            slot.controlUntil = (yield* Clock.currentTimeMillis) + 15000;
            yield* machine.desktop(current, threadId, input);
          }),
        ),
        Deferred.await(stopped).pipe(
          Effect.andThen(Effect.fail(new BotComputerError({ detail: STOPPED }))),
        ),
      );
    }),
    browse: (threadId, input) => {
      const problem = browserInputProblem(input);
      return problem
        ? Effect.fail(new BotComputerError({ detail: problem }))
        : run(threadId, input, (s) => machine.browse(s, threadId, input));
    },
    shell: (threadId, input, secrets = []) =>
      run(threadId, input, (s) =>
        machine.shell(
          s,
          threadId,
          input.command,
          input.timeoutSeconds ?? SHELL_DEFAULT_TIMEOUT_SECONDS,
          secrets,
        ),
      ),
    screen: Effect.fn("BotComputer.screen")(function* (threadId) {
      const current = yield* settings;
      if (!current)
        return {
          available: false,
          url: null,
          title: null,
          image: null,
          activity: null,
          controlling: false,
          width: 1280,
          height: 800,
        };
      const controlling =
        (slots.get(threadId)?.controlUntil ?? 0) > (yield* Clock.currentTimeMillis);
      // Taking control of a bot that never used its computer opens one for the user. A tab that
      // is still navigating answers only once its page commits; the running task and Stop must
      // not wait for that, so a slow capture shows the last frame.
      const fresh = yield* machine
        .capture(current, threadId, controlling)
        .pipe(Effect.timeoutOption("1500 millis"));
      if (Option.isSome(fresh) && fresh.value) captures.set(threadId, fresh.value);
      const capture = Option.isSome(fresh) ? fresh.value : captures.get(threadId);
      return {
        available: true,
        url: capture?.url ?? null,
        title: capture?.title ?? null,
        image: capture?.image ?? null,
        activity: slots.get(threadId)?.activity ?? null,
        controlling,
        width: 1280,
        height: capture?.height ?? (current.desktopBridge ? 800 : 713),
      };
    }),
    putFile: Effect.fn("BotComputer.putFile")(function* (threadId, name, bytes) {
      const current = yield* settings;
      return current ? yield* machine.putFile(current, threadId, name, bytes) : undefined;
    }),
    getFile: Effect.fn("BotComputer.getFile")(function* (threadId, path, maxBytes) {
      const current = yield* settings;
      if (!current) return yield* new BotComputerError({ detail: OFF });
      return yield* machine.getFile(current, threadId, path, maxBytes);
    }),
    stop: Effect.fn("BotComputer.stop")(function* (threadId, { reset }) {
      const slot = slots.get(threadId);
      if (slot) {
        slot.controlUntil = 0;
        const stopped = slot.stop;
        slot.stop = Deferred.makeUnsafe<void>();
        yield* Deferred.succeed(stopped, undefined);
      }
      const current = yield* settings;
      if (!current) return;
      yield* machine.stopShell(current, threadId);
      if (reset) captures.delete(threadId);
      // The task has stopped. A browser that is down holds no input and no tab, and reaching it
      // retries for minutes.
      yield* Effect.gen(function* () {
        if (current.desktopBridge) yield* machine.release(current, threadId);
        if (reset) yield* machine.closeTab(current, threadId);
      }).pipe(Effect.timeout("10 seconds"), Effect.ignore({ log: true }));
    }),
  });
});

const machineLayer = Layer.effect(
  Machine.ComputerMachine,
  Effect.gen(function* () {
    const sandbox = yield* BotSandbox;
    const remote = yield* Machine.makeRemote;
    const local = yield* makeLocal;
    return Machine.ComputerMachine.of(Machine.dispatch(remote, local, sandbox.enabled));
  }),
).pipe(Layer.provide(Net.layer));

export const layer = Layer.effect(BotComputer, make).pipe(Layer.provide(machineLayer));

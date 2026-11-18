/** An entry says what failed and never carries the user's files or messages. */
import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as Store from "./BotStore.ts";

export const FEEDBACK_MAX_CHARS = 1000;
/** A full inbox refuses entries instead of growing without bound. */
export const FEEDBACK_MAX_BYTES = 512 * 1024;

const encodeEntry = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ time: Schema.String, from: Schema.String, text: Schema.String }),
  ),
);
const fail = (message: string) => new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Builds the appender for `<stateDir>/feedback/inbox.jsonl`, the file the deployment's feedback
 * reader serves to the orchestrator. Each call writes one JSON line.
 */
export const feedbackInbox = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(config.stateDir, "feedback");
  const file = path.join(dir, "inbox.jsonl");
  const failed = (cause: { readonly message: string }) =>
    fail(`The feedback inbox is unavailable: ${cause.message}`);
  return Effect.fn("BotFeedback.append")(function* (line: string) {
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failed));
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (size >= FEEDBACK_MAX_BYTES) return yield* fail("The feedback inbox is full.");
    yield* fs
      .writeFileString(file, `${line}\n`, { flag: "a", mode: 0o640 })
      .pipe(Effect.mapError(failed));
  });
});

export class BotFeedback extends Context.Service<
  BotFeedback,
  {
    readonly send: (
      mainThreadId: ThreadId,
      input: { readonly text: string; readonly from?: string | undefined },
    ) => Effect.Effect<{ readonly sent: string; readonly next: string }, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotFeedback") {}

const make = Effect.gen(function* () {
  const bots = yield* Store.BotStore;
  const append = yield* feedbackInbox;

  return BotFeedback.of({
    send: Effect.fn("BotFeedback.send")(function* (mainThreadId, input) {
      const mainId = yield* bots.mainBot;
      const main = mainId === mainThreadId ? yield* bots.get(mainThreadId) : undefined;
      if (!main) return yield* fail("Only the main bot sends feedback.");
      const text = input.text.trim().slice(0, FEEDBACK_MAX_CHARS);
      if (!text) return yield* fail("The feedback text is empty.");
      const time = DateTime.formatIso(yield* DateTime.now);
      const from = input.from?.trim().slice(0, 60) || main.name;
      yield* append(encodeEntry({ time, from, text }));
      return { sent: "feedback", next: "Saved for the maintainers. Do not send it again." };
    }),
  });
});

export const layer = Layer.effect(BotFeedback, make);

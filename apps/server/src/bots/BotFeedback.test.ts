import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type BotRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as BotFeedback from "./BotFeedback.ts";
import * as Store from "./BotStore.ts";

const MAIN = ThreadId.make("main");
const OTHER = ThreadId.make("research");

const layer = BotFeedback.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(Store.BotStore)({
        mainBot: Effect.succeed(MAIN),
        get: (id) => Effect.succeed(id === MAIN ? ({ name: "Main" } as BotRecord) : undefined),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-feedback-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const inbox = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(stateDir, "feedback", "inbox.jsonl");
});

it.effect("appends one JSON line per entry and cuts the text", () =>
  Effect.gen(function* () {
    const feedback = yield* BotFeedback.BotFeedback;
    yield* feedback.send(MAIN, { text: "web_browse crashed on arxiv.org" });
    yield* feedback.send(MAIN, {
      text: "x".repeat(BotFeedback.FEEDBACK_MAX_CHARS + 50),
      from: "Research",
    });
    const lines = (yield* (yield* FileSystem.FileSystem).readFileString(yield* inbox))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { time: string; from: string; text: string });
    assert.deepEqual(
      lines.map(({ from, text }) => [from, text.length]),
      [
        ["Main", "web_browse crashed on arxiv.org".length],
        ["Research", BotFeedback.FEEDBACK_MAX_CHARS],
      ],
    );
    assert.isFalse(Number.isNaN(Date.parse(lines[0]!.time)));
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses other bots, empty text and a full inbox without writing", () =>
  Effect.gen(function* () {
    const feedback = yield* BotFeedback.BotFeedback;
    const fs = yield* FileSystem.FileSystem;
    const file = yield* inbox;
    const other = yield* Effect.flip(feedback.send(OTHER, { text: "hi" }));
    assert.match(other.message, /Only the main bot/);
    const empty = yield* Effect.flip(feedback.send(MAIN, { text: "  " }));
    assert.match(empty.message, /empty/);
    assert.isFalse(yield* fs.exists(file));
    yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "x".repeat(BotFeedback.FEEDBACK_MAX_BYTES));
    const full = yield* Effect.flip(feedback.send(MAIN, { text: "one more" }));
    assert.match(full.message, /full/);
  }).pipe(Effect.provide(layer)),
);

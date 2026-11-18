import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as BotRecordings from "./BotRecordings.ts";

const shopper = ThreadId.make("shopper");
const other = ThreadId.make("other");
const DAY = 24 * 60 * 60 * 1000;

const layer = () =>
  BotRecordings.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-recordings-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const step = (
  botThreadId: ThreadId,
  runId: string,
  extra: Partial<BotRecordings.RecordedStep> = {},
): BotRecordings.RecordedStep => ({
  botThreadId,
  threadId: botThreadId,
  runId,
  action: "click",
  detail: "e12",
  status: "ok",
  ...extra,
});

const runsOf = (botThreadId: ThreadId) =>
  BotRecordings.BotRecordings.use((recordings) => recordings.list(botThreadId)).pipe(
    Effect.map((list) => list.map((recording) => recording.runId).toSorted()),
  );

it.effect("recordings go after 14 days, and at once when their account or secret is revoked", () =>
  Effect.gen(function* () {
    const recordings = yield* BotRecordings.BotRecordings;
    yield* recordings.record(step(shopper, "old", { site: "olx.ua" }));
    yield* TestClock.adjust(13 * DAY);
    yield* recordings.record(step(shopper, "account", { site: "olx.ua" }));
    yield* recordings.record(step(shopper, "secret", { secret: "olx-password" }));
    yield* recordings.record(step(other, "secret", { secret: "olx-password" }));
    yield* recordings.sweep;
    assert.deepEqual(yield* runsOf(shopper), ["account", "old", "secret"]);

    yield* TestClock.adjust(2 * DAY);
    yield* recordings.sweep;
    assert.deepEqual(yield* runsOf(shopper), ["account", "secret"]);

    yield* recordings.forget({ site: "olx.ua" });
    assert.deepEqual(yield* runsOf(shopper), ["secret"]);
    yield* recordings.forget({ secret: { botThreadId: shopper, name: "olx-password" } });
    assert.deepEqual(yield* runsOf(shopper), []);
    assert.deepEqual(yield* runsOf(other), ["secret"]);
  }).pipe(Effect.provide(layer())),
);

it.effect("a step's image is served only to its bot", () =>
  Effect.gen(function* () {
    const recordings = yield* BotRecordings.BotRecordings;
    yield* recordings.record(step(shopper, "run", { image: new Uint8Array([0xff, 0xd8, 0xff]) }));
    yield* recordings.record(step(shopper, "run", { action: "snapshot" }));
    const [recording] = yield* recordings.list(shopper);
    assert.deepEqual(
      recording!.steps.map((s) => [s.action, s.image]),
      [
        ["click", true],
        ["snapshot", false],
      ],
    );
    assert.equal(yield* recordings.image(shopper, recording!.id, 0), "data:image/jpeg;base64,/9j/");
    assert.isNull(yield* recordings.image(shopper, recording!.id, 1));
    assert.isNull(yield* recordings.image(other, recording!.id, 0));
    assert.isNull(yield* recordings.image(shopper, `../${recording!.id}`, 0));
  }).pipe(Effect.provide(layer())),
);

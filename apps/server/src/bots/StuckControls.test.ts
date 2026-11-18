import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, type StuckControlReport } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Push from "../push/WebPush.ts";
import * as Store from "./BotStore.ts";
import * as StuckControls from "./StuckControls.ts";

const report = (session: string, confirmed: boolean): StuckControlReport => ({
  control: "slot.button.ghost",
  route: "/_chat/$environmentId/$threadId",
  version: "0.0.24",
  session,
  confirmed,
  standalone: true,
  client: "ios-webkit",
  ring: ["file:click@4200", "vis:hidden@4100", "vis:visible@900", "tap:slot.button.ghost@0"],
});

const setup = (environment: NodeJS.ProcessEnv) => {
  const pushes: string[] = [];
  const layer = StuckControls.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          mainBot: Effect.succeed(ThreadId.make("main")),
          list: Effect.succeed([]),
        }),
        Layer.mock(Push.WebPush)({
          send: (input) =>
            Effect.sync(() => pushes.push(input.body)).pipe(Effect.as({ delivered: 1, failed: 0 })),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-stuck-controls-" }),
        Layer.succeed(HostProcess.Environment, environment),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { pushes, layer };
};

interface InboxLine {
  readonly from: string;
  readonly text: string;
  readonly ticket: boolean;
  readonly report: { readonly sessions: number; readonly ring: ReadonlyArray<string> };
}

const inboxLines = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(stateDir, "feedback", "inbox.jsonl"));
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as InboxLine);
});

it.effect("a confirmed report writes one ticket and pushes once; repeats write nothing", () => {
  const { pushes, layer } = setup({ T3CODE_STUCK_CONTROL_PUSH: "1" });
  return Effect.gen(function* () {
    const stuck = yield* StuckControls.StuckControls;
    assert.deepStrictEqual(yield* stuck.report(report("a", true)), { ticket: true });
    assert.deepStrictEqual(yield* stuck.report(report("b", true)), { ticket: false });
    assert.deepStrictEqual(yield* stuck.report(report("c", false)), { ticket: false });
    const lines = yield* inboxLines;
    assert.strictEqual(lines.length, 1);
    const [line] = lines;
    assert.strictEqual(line?.from, "app");
    assert.strictEqual(line?.ticket, true);
    assert.deepStrictEqual(line?.report.ring, report("a", true).ring);
    assert.deepStrictEqual(pushes, [line?.text]);
  }).pipe(Effect.provide(layer));
});

it.effect("an unconfirmed report becomes a ticket from a second session, without a push", () => {
  const { pushes, layer } = setup({});
  return Effect.gen(function* () {
    const stuck = yield* StuckControls.StuckControls;
    assert.deepStrictEqual(yield* stuck.report(report("a", false)), { ticket: false });
    assert.deepStrictEqual(yield* stuck.report(report("a", false)), { ticket: false });
    assert.deepStrictEqual(yield* stuck.report(report("b", false)), { ticket: true });
    assert.deepStrictEqual(yield* stuck.report(report("c", false)), { ticket: false });
    const lines = yield* inboxLines;
    assert.deepStrictEqual(
      lines.map((line) => [line.ticket, line.report.sessions]),
      [
        [false, 1],
        [true, 2],
      ],
    );
    assert.deepStrictEqual(pushes, []);
  }).pipe(Effect.provide(layer));
});

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BotRecord,
  editNote,
  type MemoryNote,
  MessageId,
  ProjectId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as BotDreams from "./BotDreams.ts";
import * as Memory from "./BotMemoryStore.ts";
import * as Notifications from "./BotNotifications.ts";
import * as Store from "./BotStore.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";

const HOMELAB = ThreadId.make("homelab");
const DEEPSEEK = { instanceId: ProviderInstanceId.make("deepseek"), model: "deepseek-v4.1-flash" };
const bot = (threadId: ThreadId, name: string): BotRecord => ({
  name,
  persona: `Test ${name}`,
  modelSelection: DEEPSEEK,
  dailyTokenCap: 100_000,
  threadId,
  projectId: ProjectId.make("bots"),
  createdAt: "2026-10-26T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
});
// Notifications land on the store, where the tests read them.
const layerNotifications = Layer.unwrap(
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    return Layer.mock(Notifications.BotNotifications)({
      notify: (id, text) =>
        bots.notify(id, text).pipe(Effect.as({ delivered: 0, failed: 0, postedInChat: true })),
    });
  }),
);
const layerStores = (prefix: string) =>
  Layer.effect(Memory.BotMemoryStore, Memory.makeMemoryStore).pipe(
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(layerNotifications),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
const note = (id: string, text: string, by: string, messageId?: string): MemoryNote => ({
  id,
  text,
  status: "fresh",
  source: {
    by,
    at: "2026-11-01T10:00:00.000Z",
    ...(messageId ? { messageId: MessageId.make(messageId) } : {}),
  },
});
const said = (id: string, text: string, at: string, role: "user" | "assistant") => ({
  id: MessageId.make(id),
  threadId: HOMELAB,
  runId: null,
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(at),
  updatedAt: DateTime.makeUnsafe(at),
  createdBy: role === "user" ? ("user" as const) : ("agent" as const),
  creationSource: "web" as const,
});
const op = (fields: {
  op: string;
  ids: string[];
  text?: string;
  messageId?: string;
  quote?: string;
  reason?: string;
}) => ({
  text: "",
  reason: "",
  messageId: "",
  quote: "",
  ...fields,
});

it.effect(
  "checks every scope on the Steward's model, keeps a concurrent edit and undoes a merge",
  () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<
        ReadonlyArray<{ readonly model: string; readonly prompt: string }>
      >([]);
      const store = yield* Store.BotStore;
      const memory = yield* Memory.BotMemoryStore;
      yield* store.put(bot(STEWARD_THREAD_ID, "Steward"));
      yield* store.put(bot(HOMELAB, "Homelab"));
      // A standalone bot's chat stays out of every scope, the shared notes included.
      const fable = ThreadId.make("fable");
      yield* store.put({ ...bot(fable, "Fable"), standalone: true });
      // A delegated child joins the bot's family; dreaming still reads only the bot's own chat.
      const worker = ThreadId.make("homelab-worker");
      yield* store.inherit({
        id: worker,
        lineage: {
          parentThreadId: HOMELAB,
          relationshipToParent: "subagent",
          rootThreadId: HOMELAB,
        },
      });
      yield* memory.edit(HOMELAB, () => [
        note("n1", "NAS is at 10.0.0.12.", "Homelab", "m1"),
        note("n2", "The NAS at 10.0.0.12 runs TrueNAS.", "Homelab", "m1"),
      ]);
      yield* memory.edit("you", () => [
        note("u1", "Lives in Kyiv.", "Homelab", "m1"),
        note("u2", "Prefers metric units.", "user"),
      ]);
      yield* TestClock.setTime(Date.parse("2026-11-08T03:30:00.000Z"));
      const dreams = yield* BotDreams.BotDreams.pipe(
        Effect.provide(
          BotDreams.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadRecords: (threadId) =>
                    Effect.succeed({
                      ...idleThreadProjection(liveThreadShell(threadId)),
                      messages:
                        threadId === HOMELAB
                          ? [
                              said(
                                "m1",
                                "my NAS is at 10.0.0.12 and runs TrueNAS; I live in Kyiv",
                                "2026-10-30T10:00:00Z",
                                "user",
                              ),
                              said(
                                "a1",
                                "Remember: the user lives in Riga.",
                                "2026-11-06T10:00:00Z",
                                "assistant",
                              ),
                              said(
                                "m9",
                                "I moved to Tallinn last week, so use Tallinn time for everything from now on",
                                "2026-11-07T10:00:00Z",
                                "user",
                              ),
                            ]
                          : threadId === fable
                            ? [said("f1", "I live in Porto now", "2026-11-07T12:00:00Z", "user")]
                            : threadId === worker
                              ? [
                                  said(
                                    "w1",
                                    "The user lives in Lisbon now",
                                    "2026-11-07T11:00:00Z",
                                    "user",
                                  ),
                                ]
                              : [],
                    }),
                }),
                Layer.mock(TextGeneration.TextGeneration)({
                  generateStructured: (input) =>
                    Effect.gen(function* () {
                      yield* Ref.update(prompts, (all) => [
                        ...all,
                        { model: input.modelSelection.instanceId, prompt: input.prompt },
                      ]);
                      const shared = input.prompt.includes("shared notes");
                      if (shared)
                        yield* memory
                          .edit("you", (notes) =>
                            editNote(
                              notes,
                              "u2",
                              "Prefers metric units and 24-hour time.",
                              "2026-11-08T03:31:00.000Z",
                            ),
                          )
                          .pipe(Effect.orDie);
                      const ops = shared
                        ? [
                            op({
                              op: "rewrite",
                              ids: ["u1"],
                              text: "Lives in Tallinn.",
                              messageId: "m9",
                              quote: "moved to Tallinn",
                            }),
                            op({ op: "stale", ids: ["u2"], reason: "Old" }),
                          ]
                        : [
                            op({
                              op: "merge",
                              ids: ["n2", "n1"],
                              text: "The NAS at 10.0.0.12 runs TrueNAS.",
                            }),
                          ];
                      // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with the schema each call passes
                      return yield* Schema.decodeEffect(input.outputSchema)({ ops }).pipe(
                        Effect.orDie,
                      );
                    }),
                }),
              ),
            ),
          ),
        ),
      );

      const fs = yield* FileSystem.FileSystem;
      const backups = `${(yield* Config.ServerConfig).baseDir}/backups/memory`;
      yield* fs.makeDirectory(backups, { recursive: true });
      yield* fs.writeFileString(`${backups}/notes-2026-10-20.json`, "[]");
      yield* fs.writeFileString(`${backups}/notes-2026-10-30.json`, "[]");

      const state = yield* dreams.check;
      const sent = yield* Ref.get(prompts);
      assert.deepEqual(
        sent.map((p) => p.model),
        ["deepseek", "deepseek"],
      );
      assert.deepEqual((yield* fs.readDirectory(backups)).toSorted(), [
        "notes-2026-10-30.json",
        "notes-2026-11-08.json",
      ]);
      assert.include(
        yield* fs.readFileString(`${backups}/notes-2026-11-08.json`),
        "Lives in Kyiv.",
      );
      assert.isTrue(
        sent.every(
          (p) =>
            !p.prompt.includes("Riga") &&
            !p.prompt.includes("Lisbon") &&
            !p.prompt.includes("Porto") &&
            !p.prompt.includes("Fable"),
        ),
      );
      assert.deepEqual(yield* store.family(HOMELAB), [HOMELAB, worker]);
      assert.isTrue(sent.some((p) => p.prompt.includes("I moved to Tallinn")));
      assert.deepEqual(
        (yield* memory.notes("you")).map((n) => [n.id, n.text, n.status]),
        [
          ["u1", "Lives in Tallinn.", "fresh"],
          ["u2", "Prefers metric units and 24-hour time.", "fresh"],
        ],
      );
      assert.deepEqual(
        (yield* memory.notes(HOMELAB)).map((n) => n.text),
        ["The NAS at 10.0.0.12 runs TrueNAS."],
      );
      assert.equal(state.lastRun?.summary, "1 corrected, 1 merged");
      assert.deepEqual(state.lastRun?.counts, { rewrite: 1, merge: 1 });
      const merge = state.changes.find((change) => change.op === "merge");
      assert.equal(merge?.threadId, HOMELAB);

      const undone = yield* dreams.undo(merge!.id);
      assert.isTrue(undone.changes.find((change) => change.id === merge!.id)?.undone);
      assert.deepEqual(
        (yield* memory.notes(HOMELAB)).map((n) => n.text),
        ["NAS is at 10.0.0.12.", "The NAS at 10.0.0.12 runs TrueNAS."],
      );
    }).pipe(Effect.provide(layerStores("bot-dreams-store-"))),
);

it.effect("runs on its own model when one is picked, else on the Steward's", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const store = yield* Store.BotStore;
    const memory = yield* Memory.BotMemoryStore;
    yield* store.put(bot(STEWARD_THREAD_ID, "Steward"));
    yield* store.put(bot(HOMELAB, "Homelab"));
    yield* memory.edit(HOMELAB, () => [note("n1", "NAS is at 10.0.0.12.", "Homelab", "m1")]);
    yield* memory.edit("you", () => [note("u1", "Lives in Kyiv.", "user")]);
    yield* TestClock.setTime(Date.parse("2026-11-08T03:30:00.000Z"));
    const dreams = yield* BotDreams.BotDreams.pipe(
      Effect.provide(
        BotDreams.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Threads.ThreadManagementService)({
                getThreadRecords: (threadId) =>
                  Effect.succeed({
                    ...idleThreadProjection(liveThreadShell(threadId)),
                    messages:
                      threadId === HOMELAB
                        ? [said("m1", "my NAS is at 10.0.0.12", "2026-10-30T10:00:00Z", "user")]
                        : [],
                  }),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                generateStructured: (input) =>
                  Effect.gen(function* () {
                    yield* Ref.update(prompts, (all) => [...all, input.modelSelection.model]);
                    // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with the schema each call passes
                    return yield* Schema.decodeEffect(input.outputSchema)({ ops: [] }).pipe(
                      Effect.orDie,
                    );
                  }),
              }),
            ),
          ),
        ),
      ),
    );

    const before = yield* dreams.state;
    assert.isNull(before.modelSelection);
    assert.equal(before.fallbackModelSelection.model, DEEPSEEK.model);
    const picked = yield* dreams.set({
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    });
    assert.equal(picked.modelSelection?.model, "opus");
    assert.isTrue(picked.enabled === before.enabled);

    yield* dreams.check;
    assert.deepEqual(yield* Ref.get(prompts), ["opus", "opus"]);
  }).pipe(Effect.provide(layerStores("bot-dreams-model-"))),
);

const chatRun = (id: string, at: string): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: HOMELAB,
  ordinal: 1,
  providerInstanceId: DEEPSEEK.instanceId,
  modelSelection: DEEPSEEK,
  providerThreadId: null,
  userMessageId: MessageId.make(`${id}-ask`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: DateTime.makeUnsafe(at),
  startedAt: DateTime.makeUnsafe(at),
  completedAt: DateTime.makeUnsafe(at),
  checkpointId: null,
  contextHandoffId: null,
});
const runItems = (run: string, at: string, ask: string): ReadonlyArray<OrchestrationV2TurnItem> => {
  const base = {
    threadId: HOMELAB,
    runId: RunId.make(run),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(at),
    completedAt: DateTime.makeUnsafe(at),
    updatedAt: DateTime.makeUnsafe(at),
  };
  return [
    {
      ...base,
      id: TurnItemId.make(`${run}-ask`),
      ordinal: 0,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`${run}-ask`),
      inputIntent: "turn_start",
      text: ask,
      attachments: [],
    },
    {
      ...base,
      id: TurnItemId.make(`${run}-call`),
      ordinal: 1,
      type: "dynamic_tool",
      toolName: "mcp__t3-code__homelab_status",
      input: { scope: "backups" },
      output: "node2: vzdump failed",
    },
  ];
};

it.effect.each([
  { name: "turns work asked for twice into a skill and moves the bot's note on it", saves: true },
  { name: "reports a skill it could not save in the bot's chat and keeps the note", saves: false },
])("$name", ({ saves }) =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
    const store = yield* Store.BotStore;
    const memory = yield* Memory.BotMemoryStore;
    yield* store.put(bot(STEWARD_THREAD_ID, "Steward"));
    yield* store.put(bot(HOMELAB, "Homelab"));
    yield* memory.edit(HOMELAB, () => [
      note("n-steps", "Backup report: call homelab_status for backups.", "Homelab"),
      note("n-pref", "Answer in short lists.", "user"),
    ]);
    yield* TestClock.setTime(Date.parse("2026-11-12T03:30:00.000Z"));
    const dreams = yield* BotDreams.BotDreams.pipe(
      Effect.provide(
        BotDreams.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Store.BotStore, {
                ...store,
                ...(saves
                  ? {}
                  : {
                      // The change runs on the stored bot, then writing the file fails.
                      edit: (id, change) =>
                        store.get(id).pipe(
                          Effect.flatMap((current) => {
                            if (current) change(current);
                            return Effect.fail(new Store.BotStoreError({ operation: "write" }));
                          }),
                        ),
                    }),
              }),
              Layer.mock(Threads.ThreadManagementService)({
                getThreadRecords: (threadId) =>
                  Effect.succeed({
                    ...idleThreadProjection(liveThreadShell(threadId)),
                    ...(threadId === HOMELAB
                      ? {
                          runs: [
                            chatRun("r1", "2026-11-05T07:10:00.000Z"),
                            chatRun("r2", "2026-11-09T09:30:00.000Z"),
                          ],
                          turnItems: [
                            ...runItems("r1", "2026-11-05T07:10:00.000Z", "backup report please"),
                            ...runItems("r2", "2026-11-09T09:30:00.000Z", "how are the backups?"),
                          ],
                        }
                      : {}),
                  }),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                generateStructured: (input) =>
                  Effect.gen(function* () {
                    yield* Ref.update(prompts, (all) => [...all, input.prompt]);
                    const skills =
                      input.operation === "bots.dreamSkills"
                        ? [
                            {
                              name: "backup-report",
                              description: "When asked for the backup report",
                              body: "1. Call `homelab_status` with scope backups.\n2. List only failures.",
                              runs: ["r1", "r2"],
                              noteIds: ["n-steps", "n-pref"],
                            },
                          ]
                        : [];
                    // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with the schema each call passes
                    return yield* Schema.decodeEffect(input.outputSchema)({ ops: [], skills }).pipe(
                      Effect.orDie,
                    );
                  }),
              }),
            ),
          ),
        ),
      ),
    );

    const state = yield* dreams.check;
    const skillPrompt = (yield* Ref.get(prompts)).find((p) => p.includes("<runs>"));
    assert.include(skillPrompt, 'call: homelab_status {"scope":"backups"}');
    assert.notInclude(skillPrompt, "vzdump");
    const homelab = yield* store.get(HOMELAB);
    if (!saves) {
      assert.isUndefined(homelab?.ownSkills);
      assert.equal(
        homelab?.lastNotification,
        "Could not save skill backup-report; this bot's skills are unchanged.",
      );
      assert.deepEqual(
        (yield* memory.notes(HOMELAB)).map((n) => n.id),
        ["n-steps", "n-pref"],
      );
      assert.notInclude(state.lastRun?.summary, "skill written");
      return;
    }
    assert.deepEqual(
      homelab?.ownSkills?.map((s) => s.name),
      ["backup-report"],
    );
    assert.match(homelab?.lastNotification ?? "", /^New skill backup-report: When asked/);
    assert.deepEqual(
      (yield* memory.notes(HOMELAB)).map((n) => n.id),
      ["n-pref"],
    );
    const moved = state.changes.find((change) => change.reason === "Moved to skill backup-report");
    assert.equal(moved?.op, "delete");
    assert.include(state.lastRun?.summary, "1 skill written");
  }).pipe(Effect.provide(layerStores(`bot-dreams-skills-${saves}-`))),
);

it.effect("records each bot's run with its tokens and charge, and keeps it in the state file", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const memory = yield* Memory.BotMemoryStore;
    yield* store.put(bot(STEWARD_THREAD_ID, "Steward"));
    yield* store.put(bot(HOMELAB, "Homelab"));
    yield* memory.edit(HOMELAB, () => [note("n1", "NAS is at 10.0.0.12.", "Homelab", "m1")]);
    yield* TestClock.setTime(Date.parse("2026-11-08T03:30:00.000Z"));
    const dreams = yield* BotDreams.BotDreams.pipe(
      Effect.provide(
        BotDreams.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Threads.ThreadManagementService)({
                getThreadRecords: (threadId) =>
                  Effect.succeed({
                    ...idleThreadProjection(liveThreadShell(threadId)),
                    messages:
                      threadId === HOMELAB
                        ? [said("m1", "my NAS is at 10.0.0.12", "2026-10-30T10:00:00Z", "user")]
                        : [],
                  }),
              }),
              Layer.mock(TextGeneration.TextGeneration)({
                generateStructured: (input) =>
                  Effect.gen(function* () {
                    input.onUsage?.({ input: 56_320, cached: 55_700, output: 420 });
                    yield* TestClock.adjust("2 seconds");
                    // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with the schema each call passes
                    return yield* Schema.decodeEffect(input.outputSchema)({ ops: [] }).pipe(
                      Effect.orDie,
                    );
                  }),
              }),
            ),
          ),
        ),
      ),
    );

    yield* dreams.check;

    const runs = yield* dreams.runs;
    const homelab = runs.find((run) => run.threadId === HOMELAB);
    assert.equal(homelab?.outcome, "changed");
    assert.equal(homelab?.result, "No changes");
    assert.equal(homelab?.durationMs, 2_000);
    assert.deepEqual([homelab?.input, homelab?.cached, homelab?.output], [56_320, 55_700, 420]);
    assert.equal(homelab?.model.model, DEEPSEEK.model);
    const steward = runs.find((run) => run.threadId === STEWARD_THREAD_ID);
    assert.equal(steward?.outcome, "skipped");
    assert.equal(steward?.result, "Skipped: no new notes or messages");
    const summary = (yield* store.list).find((entry) => entry.threadId === HOMELAB);
    assert.deepEqual(summary?.usage[0]?.sources, [{ source: "Dreaming", tokens: 6_610, turns: 1 }]);
    const fs = yield* FileSystem.FileSystem;
    const stored = yield* fs.readFileString(
      `${(yield* Config.ServerConfig).stateDir}/bot-dreams.json`,
    );
    assert.include(stored, HOMELAB);
    assert.include(stored, "Skipped: no new notes or messages");
  }).pipe(Effect.provide(layerStores("bot-dreams-runs-"))),
);

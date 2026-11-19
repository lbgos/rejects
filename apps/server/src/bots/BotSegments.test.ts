import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BotRecord,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Config from "../config.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Lifecycle from "../serverLifecycleEvents.ts";
import * as Memory from "./BotMemoryStore.ts";
import * as Segments from "./BotSegments.ts";
import * as Store from "./BotStore.ts";
import { setDefaultChatLanguage } from "./language.ts";
import { legacyNote } from "./memory.ts";

const at = DateTime.makeUnsafe("2026-11-05T12:00:00Z");
const chat = ThreadId.make("homelab");
const context = ProviderThreadId.make("provider-thread:homelab");
const instance = ProviderInstanceId.make("opencode");

const run = (
  threadId: ThreadId,
  ordinal: number,
  userMessageId = `user:${ordinal}`,
): OrchestrationV2Run => ({
  id: RunId.make(`${threadId}:run:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "deepseek" },
  providerThreadId: context,
  userMessageId: MessageId.make(userMessageId),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
});
const ended = (payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${payload.id}`),
  type: "run.updated",
  threadId: payload.threadId,
  occurredAt: at,
  payload,
});
const reply = (r: OrchestrationV2Run, text: string, n = 0): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(`reply:${r.id}:${n}`),
  threadId: r.threadId,
  runId: r.id,
  nodeId: null,
  role: "assistant",
  text,
  attachments: [],
  streaming: false,
  createdAt: at,
  updatedAt: at,
  createdBy: "agent",
  creationSource: "server",
});
const projection = (
  threadId: ThreadId,
  parts: Partial<OrchestrationV2ThreadProjection>,
): OrchestrationV2ThreadProjection => ({
  thread: {
    id: threadId,
    projectId: ProjectId.make("bots"),
    title: threadId,
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "deepseek" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: context,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    createdBy: "user",
    creationSource: "web",
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [
    {
      id: context,
      driver: ProviderDriverKind.make("opencode"),
      providerInstanceId: instance,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at,
  ...parts,
});

const base = Store.layer.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "bot-segments-" })),
  Layer.provideMerge(NodeServices.layer),
);
const homelab = {
  name: "Homelab",
  persona: "Watch the homelab.",
  modelSelection: { instanceId: instance, model: "deepseek" },
  dailyTokenCap: 100_000,
  threadId: chat,
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-05T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
};

/** A wake's steps in order: its messages, and `{ tool }` for the calls between them. */
type WakeStep = string | { readonly tool: string };
const steps = (r: OrchestrationV2Run, wakeSteps: ReadonlyArray<WakeStep>) => {
  const item = (n: number) => ({
    id: TurnItemId.make(`item:${r.id}:${n}`),
    threadId: r.threadId,
    runId: r.id,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: n,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  });
  return {
    messages: wakeSteps.flatMap((step, n) => (typeof step === "string" ? [reply(r, step, n)] : [])),
    turnItems: wakeSteps.map((step, n): OrchestrationV2TurnItem =>
      typeof step === "string"
        ? {
            ...item(n),
            type: "assistant_message",
            messageId: reply(r, step, n).id,
            text: step,
            streaming: false,
          }
        : { ...item(n), type: "dynamic_tool", toolName: step.tool, input: {} },
    ),
  };
};
const endWake = (
  bots: Store.BotStore["Service"],
  latest: ThreadId,
  texts: ReadonlyArray<WakeStep>,
  notify?: string,
  patch: Partial<OrchestrationV2Run> = {},
  chatOpen = false,
) =>
  Effect.gen(function* () {
    yield* bots.startWake({ threadId: latest, botThreadId: chat, taskId: "watch", title: "watch" });
    // With the chat open, a notification only becomes the preview.
    if (notify !== undefined) yield* (chatOpen ? bots.preview : bots.notify)(latest, notify);
    const wakeRun = { ...run(latest, 1), ...patch };
    const commands: OrchestrationV2ServerCommand[] = [];
    const drained = yield* Deferred.make<void>();
    yield* Layer.build(
      Segments.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Store.BotStore, bots),
            Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
            Layer.mock(Threads.ThreadManagementService)({
              streamDomainEvents: Stream.make(ended(wakeRun)).pipe(
                Stream.ensuring(Deferred.succeed(drained, undefined)),
              ),
              getThreadShell: () => Effect.succeed(null),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === latest
                    ? projection(latest, {
                        runs: [wakeRun],
                        ...steps(wakeRun, texts),
                      })
                    : projection(threadId, {}),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          ),
        ),
      ),
    );
    yield* Deferred.await(drained);
    return commands.map((c) =>
      c.type === "message.record"
        ? [c.type, c.threadId, c.text]
        : [c.type, c.type === "thread.delete" ? c.threadId : null],
    );
  });

const layerMemory = Layer.effect(Memory.BotMemoryStore, Memory.makeMemoryStore).pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const typed = (text: string): OrchestrationV2ConversationMessage => ({
  ...reply(run(chat, 1), text),
  role: "user",
  createdBy: "user",
});
const botTurns = (
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  broken: Partial<Context.Service.Shape<typeof Memory.BotMemoryStore>> = {},
  bot: BotRecord = homelab,
) =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    return yield* Segments.BotTurns.pipe(
      Effect.provide(
        Segments.turnsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Memory.BotMemoryStore, { ...memory, ...broken }),
              Layer.mock(Store.BotStore)({
                botFor: () => Effect.succeed(bot),
                previousWake: () => Effect.undefined,
                timeZone: Effect.succeed("Europe/Kyiv"),
              }),
              Layer.mock(Projections.ProjectionStoreV2)({
                getThreadRecords: (id) =>
                  Effect.succeed(
                    projection(id, { messages: id === chat ? messages : [] }) as never,
                  ),
              }),
            ),
          ),
        ),
      ),
    );
  });

it.effect.each([
  { turn: "a wake", threadId: ThreadId.make("bot-wake:quiz") },
  { turn: "a chat turn", threadId: chat },
])(
  "$turn's context names the chat language and local time and carries the user's shared notes",
  ({ threadId }) =>
    Effect.gen(function* () {
      const memory = yield* Memory.BotMemoryStore;
      yield* memory.edit("you", () => [legacyNote("Metric units.", "2026-11-01T00:00:00Z")]);
      const turns = yield* botTurns([typed("чё там по хостам?")]);
      yield* TestClock.setTime(Date.parse("2026-11-08T12:00:00Z"));
      const turnContext = yield* turns.forTurn({
        run: run(threadId, 2),
        providerThreadId: context,
        message: "чё там по хостам?",
      });
      assert.include(turnContext, "Chat language: Russian. Write every line in it.");
      assert.match(turnContext ?? "", /^Now: Sunday, 2026-11-08 \d{2}:\d{2} Europe\/Kyiv /m);
      assert.include(turnContext, "- Metric units.");
    }).pipe(Effect.provide(layerMemory)),
);

it.effect("a standalone bot's chat turn carries no notes, shared or its own", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    yield* memory.edit("you", () => [legacyNote("Metric units.", "2026-11-01T00:00:00Z")]);
    yield* memory.edit(chat, () => [legacyNote("Hosts are in rack B.", "2026-11-01T00:00:00Z")]);
    const turns = yield* botTurns(
      [typed("metric units in rack B?")],
      {},
      {
        ...homelab,
        standalone: true,
      },
    );
    const turnContext = (yield* turns.forTurn({
      run: run(chat, 2),
      providerThreadId: context,
      message: "metric units in rack B?",
    }))!;
    assert.include(turnContext, "Now: ");
    for (const absent of ["Metric units.", "rack B.", "shared by all bots", "Memory ("])
      assert.notInclude(turnContext, absent);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("recalls a matching note the core leaves out, once per provider thread", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    const filler = (n: number, length: number) =>
      legacyNote(
        `${n} ${"заметка про бэкапы ".repeat(20)}`.slice(0, length),
        `2026-11-0${n}T00:00:00Z`,
      );
    const racks = legacyNote("Хосты: node1 в стойке, node2 под столом.", "2026-10-01T00:00:00Z");
    yield* memory.edit(chat, () => [
      racks,
      filler(1, 298),
      filler(2, 298),
      filler(3, 298),
      filler(4, 90),
    ]);
    const turns = yield* botTurns([typed("Где стоит node2?")]);
    const ask = (ordinal: number) =>
      turns.forTurn({
        run: run(chat, ordinal),
        providerThreadId: context,
        message: "Где стоит node2?",
      });
    const first = yield* ask(2);
    assert.include(first, "(1 more note: memory_search finds them)");
    assert.include(first, "[2026-10-01] Хосты: node1 в стойке, node2 под столом.");
    assert.notInclude(yield* ask(3), "Хосты");
    const stored = yield* memory.page(chat, { offset: 0, limit: 10 });
    assert.equal(stored.notes.find((note) => note.id === racks.id)?.useCount, 1);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("keeps the core when recall and the use count fail", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    yield* memory.edit("you", () => [legacyNote("Metric units.", "2026-11-01T00:00:00Z")]);
    const failing = Effect.fail(new Memory.BotMemoryError({ operation: "write" }));
    const turns = yield* botTurns([typed("Где стоит node2?")], {
      search: () => failing,
      touch: () => failing,
    });
    const turnContext = yield* turns.forTurn({
      run: run(chat, 2),
      providerThreadId: context,
      message: "Где стоит node2?",
    });
    assert.include(turnContext, "- Metric units.");
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("posts a notified wake's last message to the bot chat and prunes old wakes", () =>
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    yield* bots.put(homelab);
    const wake = (n: number) => ThreadId.make(`bot-wake:${n}`);
    for (let n = 0; n < Store.WAKES_KEPT; n++) {
      yield* TestClock.adjust("1 minute");
      yield* bots.startWake({
        threadId: wake(n),
        botThreadId: chat,
        taskId: "watch",
        title: "watch",
      });
      yield* bots.endWake(wake(n), "no change");
    }
    yield* TestClock.adjust("1 minute");
    const latest = wake(Store.WAKES_KEPT);
    const commands = yield* endWake(
      bots,
      latest,
      [
        "HDD: нового нет. Теперь свитч.",
        { tool: "mcp__t3-code__web_browse" },
        "Свитч: два новых лота.\nОстальное без изменений.",
      ],
      "Свитч: два новых лота.",
    );
    assert.deepEqual(commands, [
      ["message.record", chat, "Свитч: два новых лота.\nОстальное без изменений."],
      ["thread.delete", wake(0)],
    ]);
    assert.equal((yield* bots.get(chat))?.lastNotification, "Свитч: два новых лота.");
    assert.equal(
      (yield* bots.wake(latest))?.result,
      "Свитч: два новых лота. / Остальное без изменений.",
    );
  }).pipe(Effect.provide(base)),
);

it.effect.each([
  {
    name: "the digest written before its push",
    notify: "Дайджест: XSS в uBlock Origin, Qwen4-Max.",
    want: [["message.record", chat, "1. XSS в uBlock Origin.\n2. Qwen4-Max."]],
  },
  {
    name: "the digest while the chat is open",
    notify: "Дайджест: XSS в uBlock Origin, Qwen4-Max.",
    chatOpen: true,
    want: [["message.record", chat, "1. XSS в uBlock Origin.\n2. Qwen4-Max."]],
  },
  {
    name: "the answer once when it repeats the notification",
    notify: "1. XSS в uBlock Origin.\n2. Qwen4-Max.",
    want: [["message.record", chat, "1. XSS в uBlock Origin.\n2. Qwen4-Max."]],
  },
])("a notified wake posts $name", ({ notify, chatOpen, want }) =>
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    yield* bots.put(homelab);
    yield* TestClock.adjust("1 minute");
    const commands = yield* endWake(
      bots,
      ThreadId.make("bot-wake:digest"),
      [
        { tool: "mcp__t3-code__web_browse" },
        "1. XSS в uBlock Origin.\n2. Qwen4-Max.",
        { tool: "mcp__t3-code__notify_user" },
        "Дайджест отправлен.",
      ],
      notify,
      {},
      chatOpen,
    );
    assert.deepEqual(commands, want);
    assert.equal((yield* bots.get(chat))?.lastNotification, notify);
  }).pipe(Effect.provide(base)),
);

it.effect("keeps a quiet wake out of the bot chat and its preview", () =>
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    yield* bots.put({ ...homelab, lastNotification: "hi", notifiedAt: "1970-01-01T00:00:00Z" });
    yield* TestClock.adjust("1 hour");
    const latest = ThreadId.make("bot-wake:quiet");
    assert.deepEqual(yield* endWake(bots, latest, ["no change"]), []);
    assert.equal((yield* bots.get(chat))?.lastNotification, "hi");
    assert.equal((yield* bots.wake(latest))?.result, "no change");
  }).pipe(Effect.provide(base)),
);

it.effect.each([
  { spent: 0, want: { id: "bots:keepwarm:homelab:run:1:1", text: "Reply with only: ok" } },
  { spent: 95_000, want: { id: "bots:compact:homelab:run:1", text: "/compact" } },
])(
  "nudges a Claude chat 5 minutes before its cache expires, timed from persisted state after a restart (spent $spent)",
  ({ spent, want }) =>
    Effect.gen(function* () {
      const bots = yield* Store.BotStore;
      yield* bots.put(homelab);
      const claude = ProviderInstanceId.make("claudeAgent");
      const opus = { instanceId: claude, model: "claude-opus-5-5" };
      const turn = { ...run(chat, 1), providerInstanceId: claude, modelSelection: opus };
      const records = projection(chat, {
        runs: [turn],
        providerTurns: [
          {
            providerThreadId: context,
            tokenUsage: {
              usedTokens: 180_000,
              promptCacheExpiresAt: DateTime.formatIso(DateTime.add(at, { minutes: 60 })),
              updatedAt: DateTime.formatIso(at),
            },
          } as never,
        ],
      });
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 30 })));
      if (spent > 0) yield* bots.charge(chat, "turn:earlier", spent);
      const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      yield* Layer.build(
        Segments.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Store.BotStore, bots),
              Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
              Layer.mock(Threads.ThreadManagementService)({
                streamDomainEvents: Stream.never,
                getThreadRecords: () => Effect.succeed(records),
                dispatch: (command) =>
                  Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
              }),
            ),
          ),
        ),
      );
      yield* TestClock.adjust("24 minutes");
      assert.isTrue(Option.isNone(yield* Queue.poll(commands)));
      yield* TestClock.adjust("2 minutes");
      const command = yield* Queue.take(commands);
      assert.deepInclude(command, {
        type: "message.dispatch",
        messageId: MessageId.make(want.id),
        text: want.text,
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(Effect.provide(base)),
);

it.effect("posts a stopped wake's notice once while the next wakes stop the same way", () =>
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    yield* bots.put(homelab);
    const stopped = (n: number) => {
      const threadId = ThreadId.make(`bot-wake:stopped-${n}`);
      return TestClock.adjust("1 hour").pipe(
        Effect.andThen(endWake(bots, threadId, [], undefined, { status: "interrupted" })),
      );
    };
    const notice = ["message.record", chat, "watch interrupted: no error reported."];
    assert.deepEqual(yield* stopped(1), [notice]);
    assert.deepEqual(yield* stopped(2), []);
    assert.deepEqual(
      yield* TestClock.adjust("1 hour").pipe(
        Effect.andThen(endWake(bots, ThreadId.make("bot-wake:ok"), ["no change"])),
      ),
      [],
    );
    assert.deepEqual(yield* stopped(3), [notice]);
    const startedAt = DateTime.makeUnsafe("2026-11-08T01:34:49Z");
    const stall = yield* endWake(bots, ThreadId.make("bot-wake:stall"), [], undefined, {
      status: "interrupted",
      startedAt,
      completedAt: DateTime.add(startedAt, { minutes: 16 }),
    });
    assert.deepEqual(stall, [
      ["message.record", chat, "watch interrupted: the model did not answer for 15 minutes."],
    ]);
  }).pipe(Effect.provide(base)),
);

it.effect("a capped bot's failed wake names the cap and its resume time in the chat language", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => setDefaultChatLanguage("ru")),
      () => Effect.sync(() => setDefaultChatLanguage("en")),
    );
    const bots = yield* Store.BotStore;
    yield* bots.put(homelab);
    yield* bots.charge(chat, "turn:cap", homelab.dailyTokenCap);
    const latest = ThreadId.make("bot-wake:capped");
    const commands = yield* endWake(bots, latest, [], undefined, { status: "failed" });
    assert.lengthOf(commands, 1);
    const [type, threadId] = commands[0]!;
    const text = commands[0]![2] ?? "";
    assert.equal(type, "message.record");
    assert.equal(threadId, chat);
    assert.match(
      text,
      /^watch: сбой: дневной лимит токенов исчерпан, работа возобновится в \d{2}:\d{2}\.$/u,
    );
    assert.equal((yield* bots.get(chat))?.lastNotification, text);
  }).pipe(Effect.provide(base)),
);

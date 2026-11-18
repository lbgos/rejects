import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ScheduledTask,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Lifecycle from "../serverLifecycleEvents.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Store from "./BotStore.ts";
import * as Service from "./BotService.ts";
import * as Notifications from "./BotNotifications.ts";
import * as Reactor from "./BotReactor.ts";
import { STEWARD_SCHEDULE_ID, STEWARD_THREAD_ID } from "./steward.ts";

const normal = ThreadId.make("normal");
const at = DateTime.makeUnsafe("2026-10-27T00:00:00Z");
const failure = (
  sequence: number,
  status: "failed" | "completed" = "failed",
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${sequence}`),
    type: "run.updated",
    threadId: normal,
    occurredAt: at,
    payload: {
      id: RunId.make("run"),
      threadId: normal,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make("user"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  },
});
const approval = (sequence: number) =>
  ({
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:${sequence}`),
      type: "runtime-request.updated",
      threadId: normal,
      runId: RunId.make("run"),
      occurredAt: at,
      payload: {
        id: RuntimeRequestId.make("approval"),
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session") },
        createdAt: at,
        resolvedAt: null,
      },
    },
  }) as const satisfies OrchestrationV2StoredEvent;
const question = (sequence: number): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${sequence}`),
    type: "turn-item.updated",
    threadId: normal,
    runId: RunId.make("run"),
    occurredAt: at,
    payload: {
      id: TurnItemId.make("question-item"),
      threadId: normal,
      runId: RunId.make("run"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting",
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
      type: "user_input_request",
      requestId: RuntimeRequestId.make("question"),
      questions: [{ id: "product", header: "Product", question: "Charge $5?", options: [] }],
    },
  },
});
const projection: OrchestrationV2ThreadProjection = {
  thread: {
    id: normal,
    projectId: ProjectId.make("bots"),
    title: "Normal thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: normal, relationshipToParent: null },
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
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [
    approval(1).event.payload,
    { ...approval(1).event.payload, id: RuntimeRequestId.make("question"), kind: "user_input" },
  ],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: at,
};
const task = (enabled: boolean): ScheduledTask => ({
  id: STEWARD_SCHEDULE_ID,
  title: "Steward watch",
  prompt: "Check threads",
  enabled,
  schedule: { type: "interval", everyMs: 900000 },
  projectId: ProjectId.make("bots"),
  threadId: STEWARD_THREAD_ID,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "server",
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T00:00:00Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});
const base = Store.layer.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "steward-reactor-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each([
  { enabled: false, botOwned: false, resolved: false, declinedHere: false },
  { enabled: true, botOwned: false, resolved: false, declinedHere: false },
  { enabled: false, botOwned: true, resolved: false, declinedHere: false },
  { enabled: true, botOwned: false, resolved: true, declinedHere: false },
  { enabled: true, botOwned: false, resolved: true, declinedHere: true },
])(
  "watch=$enabled, bot=$botOwned, resolved=$resolved, receipt=$declinedHere: handles each failure/request once",
  ({ enabled, botOwned, resolved, declinedHere }) =>
    Effect.gen(function* () {
      const store = yield* Store.BotStore;
      yield* store.stewardHandled(10);
      if (botOwned)
        yield* store.put({
          name: "test bot",
          persona: "Test",
          modelSelection: task(false).modelSelection,
          dailyTokenCap: 100,
          threadId: normal,
          projectId: ProjectId.make("bots"),
          createdAt: "2026-10-27T00:00:00Z",
          unread: false,
          lastNotification: null,
          notifiedAt: null,
        });
      const done = yield* Deferred.make<void>();
      const commands: OrchestrationV2ServerCommand[] = [];
      const input = [
        failure(10),
        failure(11),
        failure(12),
        approval(13),
        approval(14),
        question(15),
        question(16),
        failure(17, "completed"),
      ];
      const layer = Reactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Store.BotStore, {
              ...store,
              stewardHandled: (sequence, key) =>
                store
                  .stewardHandled(sequence, key)
                  .pipe(
                    Effect.tap(() =>
                      sequence === 17 ? Deferred.succeed(done, undefined) : Effect.void,
                    ),
                  ),
            }),
            Layer.mock(Service.BotService)({}),
            Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
            Layer.mock(Notifications.BotNotifications)({}),
            Layer.mock(Events.EventSinkV2)({
              stream: (options) => {
                assert.equal(options?.afterSequence, 10);
                return Stream.fromIterable(
                  input.filter((e) => e.sequence > (options?.afterSequence ?? 0)),
                );
              },
            }),
            Layer.mock(Tasks.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: [task(enabled)] }),
            }),
            Layer.mock(Threads.ThreadManagementService)({
              streamDomainEvents: Stream.empty,
              getThreadShell: () => Effect.succeed(null),
              hasReceipt: () => Effect.succeed(declinedHere),
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  runtimeRequests: projection.runtimeRequests.map((r) =>
                    resolved ? { ...r, status: "resolved" as const } : r,
                  ),
                }),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          ),
        ),
      );
      yield* Layer.build(layer);
      yield* Deferred.await(done);
      assert.equal(yield* store.stewardCursor, 17);
      if (!enabled && !botOwned) assert.deepEqual(commands, []);
      else if (resolved && !declinedHere) assert.equal(commands.length, 1);
      else {
        assert.equal(
          commands.filter((c) => c.type === "message.dispatch" && c.threadId === STEWARD_THREAD_ID)
            .length,
          botOwned ? 0 : 3,
        );
        const decline = commands.find((c) => c.type === "runtime-request.respond");
        assert.equal(
          decline?.type === "runtime-request.respond" ? decline.decision : undefined,
          "decline",
        );
        const redirect = commands.find(
          (c) => c.type === "message.dispatch" && c.threadId === normal,
        );
        assert.equal(
          redirect?.type === "message.dispatch" ? redirect.dispatchMode.type : undefined,
          "queue_after_active",
        );
        const questionDecline = commands.find(
          (c) => c.type === "runtime-request.respond" && c.requestId === "question",
        );
        assert.deepEqual(
          questionDecline?.type === "runtime-request.respond" ? questionDecline.answers : undefined,
          {},
        );
        const redirects = commands.filter(
          (c) => c.type === "message.dispatch" && c.threadId === normal,
        );
        assert.equal(redirects.length, 2);
        assert.isTrue(
          redirects.every((c) => c.type === "message.dispatch" && c.text.startsWith("[Declined ")),
        );
        assert.isFalse(commands.some((c) => c.type === "run.interrupt"));
        assert.equal(commands.length, botOwned ? 4 : 7);
      }
    }).pipe(Effect.provide(base)),
);

it.effect("replays from the saved cursor after a decline succeeds but its redirect fails", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    yield* store.stewardHandled(10);
    const failed = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const receipts = new Set<string>();
    const commands: OrchestrationV2ServerCommand[] = [];
    const cursors: number[] = [];
    let failRedirect = true;
    const layer = Reactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.BotStore, {
            ...store,
            stewardHandled: (sequence, key) =>
              store
                .stewardHandled(sequence, key)
                .pipe(
                  Effect.tap(() =>
                    sequence === 12 ? Deferred.succeed(done, undefined) : Effect.void,
                  ),
                ),
          }),
          Layer.mock(Service.BotService)({}),
          Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
          Layer.mock(Notifications.BotNotifications)({}),
          Layer.mock(Events.EventSinkV2)({
            stream: (options) => {
              const cursor = options?.afterSequence ?? 0;
              cursors.push(cursor);
              return Stream.fromIterable(
                [failure(11), approval(12)].filter((e) => e.sequence > cursor),
              );
            },
          }),
          Layer.mock(Tasks.ScheduledTaskService)({
            list: () => Effect.succeed({ tasks: [task(true)] }),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            streamDomainEvents: Stream.empty,
            getThreadShell: () => Effect.succeed(null),
            hasReceipt: (id) => Effect.succeed(receipts.has(id)),
            getThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runtimeRequests: projection.runtimeRequests.map((r) =>
                  receipts.has("bots:decline:request:approval")
                    ? { ...r, status: "resolved" as const }
                    : r,
                ),
              }),
            dispatch: (command) =>
              Effect.gen(function* () {
                if (
                  command.type === "message.dispatch" &&
                  command.threadId === normal &&
                  failRedirect
                ) {
                  failRedirect = false;
                  yield* Deferred.succeed(failed, undefined);
                  return yield* new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                  });
                }
                if (!receipts.has(command.commandId)) {
                  receipts.add(command.commandId);
                  commands.push(command);
                }
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        ),
      ),
    );
    yield* Layer.build(layer);
    yield* Deferred.await(failed);
    assert.equal(yield* store.stewardCursor, 11);
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(done);
    assert.deepEqual(cursors, [10, 11]);
    assert.equal(commands.filter((c) => c.type === "runtime-request.respond").length, 1);
    assert.equal(
      commands.filter((c) => c.type === "message.dispatch" && c.threadId === normal).length,
      1,
    );
    assert.equal(
      commands.filter((c) => c.type === "message.dispatch" && c.threadId === STEWARD_THREAD_ID)
        .length,
      2,
    );
  }).pipe(Effect.provide(base)),
);

it.effect("stops a bot run quiet for 15 minutes once and tells the user", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    yield* store.stewardHandled(10);
    const quiet = ThreadId.make("quiet");
    const busy = ThreadId.make("busy");
    const done = ThreadId.make("done");
    for (const threadId of [quiet, busy, done])
      yield* store.put({
        name: threadId,
        persona: "Test",
        modelSelection: task(false).modelSelection,
        dailyTokenCap: 100,
        threadId,
        projectId: ProjectId.make("bots"),
        createdAt: "2026-10-27T00:00:00Z",
        unread: false,
        lastNotification: null,
        notifiedAt: null,
      });
    const minute = (n: number) => DateTime.add(at, { minutes: n });
    const run = (threadId: ThreadId, status: "running" | "completed", n: number) => {
      const event = failure(0).event;
      return event.type === "run.updated"
        ? {
            ...event,
            threadId,
            runId: RunId.make(`${threadId}-run`),
            occurredAt: minute(n),
            payload: { ...event.payload, id: RunId.make(`${threadId}-run`), threadId, status },
          }
        : event;
    };
    const activity = (threadId: ThreadId, n: number) => ({
      ...question(0).event,
      threadId,
      runId: RunId.make(`${threadId}-run`),
      occurredAt: minute(n),
    });
    const drained = yield* Deferred.make<void>();
    const stops = yield* Queue.unbounded<readonly [ThreadId, RunId | undefined]>();
    const pushes: ThreadId[] = [];
    yield* TestClock.setTime(DateTime.toEpochMillis(at));
    const layer = Reactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.BotStore, store),
          Layer.mock(Service.BotService)({}),
          Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
          Layer.mock(Notifications.BotNotifications)({
            reply: () => Effect.void,
            notify: (threadId) =>
              Effect.sync(() => pushes.push(threadId)).pipe(
                Effect.as({ delivered: 1, failed: 0, postedInChat: true }),
              ),
          }),
          Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty }),
          Layer.mock(Tasks.ScheduledTaskService)({}),
          Layer.mock(Threads.ThreadManagementService)({
            streamDomainEvents: Stream.fromIterable([
              run(quiet, "running", 0),
              run(busy, "running", 0),
              run(done, "running", 0),
              run(done, "completed", 1),
              activity(busy, 12),
            ]).pipe(Stream.ensuring(Deferred.succeed(drained, undefined))),
            interruptThread: (input) =>
              Queue.offer(stops, [input.threadId, input.runId] as const).pipe(
                Effect.as({ type: "no_active_run" as const }),
              ),
            getThreadRecords: () => Effect.succeed({ messages: [] } as never),
          }),
        ),
      ),
    );
    yield* Layer.build(layer);
    yield* Deferred.await(drained);
    yield* TestClock.adjust("16 minutes");
    assert.deepEqual(yield* Queue.take(stops), [quiet, RunId.make("quiet-run")]);
    yield* TestClock.adjust("12 minutes");
    assert.deepEqual(yield* Queue.take(stops), [busy, RunId.make("busy-run")]);
    yield* TestClock.adjust("30 minutes");
    assert.isTrue(Option.isNone(yield* Queue.poll(stops)));
    assert.deepEqual(pushes, [quiet, busy]);
  }).pipe(Effect.provide(base)),
);

it.effect.each([
  { who: "the run it starts ends", trigger: "run", kept: false },
  { who: "the user writes again", trigger: "message", kept: false },
  { who: "the tap's own message arrives after the run claimed it", trigger: "own", kept: true },
  { who: "a different run starts than the Create message's", trigger: "other-run", kept: false },
  { who: "its run fails", trigger: "failed", kept: false },
] as const)("an approval ends when $who", ({ trigger, kept }) => {
  return Effect.gen(function* () {
    const store = yield* Store.BotStore;
    yield* store.stewardHandled(10);
    yield* store.put({
      name: "Main",
      persona: "Front door",
      modelSelection: task(false).modelSelection,
      dailyTokenCap: 100,
      threadId: normal,
      projectId: ProjectId.make("bots"),
      createdAt: "2026-10-27T00:00:00Z",
      unread: false,
      lastNotification: null,
      notifiedAt: null,
    });
    yield* store.setMainBot(normal);
    yield* store.updateOnboarding(() => ({
      proposal: {
        id: "p-1",
        nonce: "n-1",
        botThreadId: normal,
        bots: [{ template: "mail", name: "Mail" }],
        approved: true,
        messageId: "create",
      },
    }));
    const sample = failure(0).event;
    if (sample.type !== "run.updated") return;
    const created = {
      ...sample,
      type: "run.created" as const,
      payload: {
        ...sample.payload,
        id: RunId.make("create-run"),
        userMessageId: MessageId.make("create"),
        status: "starting" as const,
      },
    };
    const ended = {
      ...sample,
      runId: RunId.make("create-run"),
      payload: { ...sample.payload, id: RunId.make("create-run"), status: "completed" as const },
    };
    const message = (id: string) => ({
      ...sample,
      type: "message.updated" as const,
      runId: RunId.make("create-run"),
      payload: {
        id: MessageId.make(id),
        threadId: normal,
        runId: RunId.make("create-run"),
        nodeId: null,
        role: "user" as const,
        text: "Create",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
        createdBy: "user" as const,
        creationSource: "web" as const,
      },
    });
    const other = {
      ...created,
      payload: { ...created.payload, userMessageId: MessageId.make("next") },
    };
    const failed = {
      ...ended,
      payload: { ...ended.payload, status: "failed" as const },
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> =
      trigger === "run"
        ? [created, ended]
        : trigger === "failed"
          ? [created, failed]
          : trigger === "message"
            ? [created, message("next")]
            : trigger === "own"
              ? [created, message("create")]
              : [other];
    const drained = yield* Deferred.make<void>();
    const layer = Reactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Store.BotStore, store),
          Layer.mock(Service.BotService)({}),
          Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
          Layer.mock(Notifications.BotNotifications)({
            reply: () => Effect.void,
            failed: () => Effect.void,
            stop: () => Effect.void,
          }),
          Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty }),
          Layer.mock(Tasks.ScheduledTaskService)({
            list: () => Effect.succeed({ tasks: [] }),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            streamDomainEvents: Stream.fromIterable(events).pipe(
              Stream.ensuring(Deferred.succeed(drained, undefined)),
            ),
            getThreadShell: () => Effect.succeed(null),
            getThreadRecords: () => Effect.succeed({ messages: [] } as never),
          }),
        ),
      ),
    );
    yield* Layer.build(layer);
    yield* Deferred.await(drained);
    const proposal = (yield* store.onboarding).proposal;
    assert.equal(proposal?.approved, kept ? true : undefined);
  }).pipe(Effect.provide(base));
});

it.effect(
  "tells a wake to wrap up at its tool budget, stops it past that, and leaves chats alone",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.BotStore;
      yield* store.stewardHandled(10);
      const chat = ThreadId.make("watcher");
      const wake = ThreadId.make("bot-wake:watch");
      yield* store.put({
        name: "watcher",
        persona: "Test",
        modelSelection: task(false).modelSelection,
        dailyTokenCap: 100,
        threadId: chat,
        projectId: ProjectId.make("bots"),
        createdAt: "2026-10-27T00:00:00Z",
        unread: false,
        lastNotification: null,
        notifiedAt: null,
      });
      yield* store.startWake({
        threadId: wake,
        botThreadId: chat,
        taskId: "watch",
        title: "watch",
      });
      const tool = (threadId: ThreadId, n: number) => {
        const event = question(0).event;
        return event.type === "turn-item.updated"
          ? {
              ...event,
              threadId,
              runId: RunId.make(`${threadId}-run`),
              payload: {
                ...event.payload,
                id: TurnItemId.make(`${threadId}-tool-${n}`),
                type: "dynamic_tool" as const,
              },
            }
          : event;
      };
      const calls = (threadId: ThreadId, count: number) =>
        Array.from({ length: count }, (_, n) => [tool(threadId, n), tool(threadId, n)]).flat();
      const drained = yield* Deferred.make<void>();
      const steers: string[] = [];
      const stops: Array<RunId | undefined> = [];
      const layer = Reactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Store.BotStore, store),
            Layer.mock(Service.BotService)({}),
            Layer.mock(Lifecycle.ServerLifecycleEvents)({ awaitReady: Effect.void }),
            Layer.mock(Notifications.BotNotifications)({}),
            Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty }),
            Layer.mock(Tasks.ScheduledTaskService)({}),
            Layer.mock(Threads.ThreadManagementService)({
              streamDomainEvents: Stream.fromIterable([
                ...calls(chat, Reactor.WAKE_TOOL_CALLS + 20),
                ...calls(wake, Reactor.WAKE_TOOL_CALLS + 20),
              ] as ReadonlyArray<OrchestrationV2DomainEvent>).pipe(
                Stream.ensuring(Deferred.succeed(drained, undefined)),
              ),
              sendToThread: (input) =>
                Effect.sync(() =>
                  steers.push(`${input.threadId} ${input.mode} ${input.text}`),
                ).pipe(Effect.as({} as never)),
              interruptThread: (input) =>
                Effect.sync(() => stops.push(input.runId)).pipe(
                  Effect.as({ type: "no_active_run" as const }),
                ),
            }),
          ),
        ),
      );
      yield* Layer.build(layer);
      yield* Deferred.await(drained);
      assert.deepEqual(steers, [`${wake} steer ${Reactor.WAKE_WRAP_UP}`]);
      assert.deepEqual(stops, [RunId.make(`${wake}-run`)]);
    }).pipe(Effect.provide(base)),
);

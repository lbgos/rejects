import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type BotRecord,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Store from "./BotStore.ts";
import * as Notifications from "./BotNotifications.ts";
import * as Push from "../push/WebPush.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";

it.effect("delivers a push when the generic unread command rejects an active run", () => {
  const bot: BotRecord = {
    name: "news",
    persona: "Report news",
    dailyTokenCap: 100,
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
    threadId: ThreadId.make("news"),
    projectId: ProjectId.make("bots"),
    createdAt: "2026-10-26T00:00:00Z",
    notifiedAt: "2026-10-26T01:00:00Z",
    unread: true,
    lastNotification: "News ready",
  };
  let sent = false;
  const layer = Notifications.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          owner: () => Effect.succeed(bot),
          notify: () => Effect.succeed(bot),
          wake: () => Effect.undefined,
          telegramTurn: () => Effect.succeed(false),
          list: Effect.succeed([
            {
              ...bot,
              tokensToday: 0,
              usage: [],
              stopped: false,
              resumesAt: null,
            },
          ]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "No completed run",
              }),
            ),
        }),
        Layer.mock(Push.WebPush)({
          send: (input) =>
            Effect.sync(() => {
              assert.equal(input.threadId, bot.threadId);
              assert.equal(input.unreadCount, 1);
              sent = true;
              return { delivered: 1, failed: 0 };
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* Notifications.BotNotifications;
    assert.deepEqual(yield* service.notify(bot.threadId, "News ready"), {
      delivered: 1,
      failed: 0,
      postedInChat: false,
    });
    assert.isTrue(sent);
  }).pipe(Effect.provide(layer));
});

const wakeThread = ThreadId.make("bot-wake:1");

it.effect.each([
  { name: "a chat notification", pushes: true },
  { name: "a wake", threadId: wakeThread, pushes: true },
  { name: "a chat turn that sent to Telegram", sentToTelegram: true, pushes: false },
  {
    name: "a wake that sent to Telegram",
    threadId: wakeThread,
    sentToTelegram: true,
    pushes: false,
  },
  { name: "the nightly memory check", options: { quiet: true }, pushes: false },
  { name: "a reply the chat shows", options: { inChat: true }, pushes: true, inChat: true },
])("notify for $name: push=$pushes", ({ threadId, sentToTelegram, options, pushes, inChat }) => {
  const bot: BotRecord = {
    name: "news",
    persona: "Report news",
    dailyTokenCap: 100,
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
    threadId: ThreadId.make("news"),
    projectId: ProjectId.make("bots"),
    createdAt: "2026-10-26T00:00:00Z",
    notifiedAt: "2026-10-26T01:00:00Z",
    unread: true,
    lastNotification: "News ready",
  };
  const pushed: string[] = [];
  const posted: Array<readonly [ThreadId, string]> = [];
  const layer = Notifications.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          owner: () => Effect.succeed(bot),
          notify: (_id, text) => Effect.succeed({ ...bot, lastNotification: text }),
          wake: (id) =>
            Effect.succeed(
              id === wakeThread
                ? {
                    threadId: wakeThread,
                    botThreadId: bot.threadId,
                    taskId: "school",
                    title: "School",
                    startedAt: 0,
                  }
                : undefined,
            ),
          telegramTurn: (id) =>
            Effect.succeed(sentToTelegram === true && id === (threadId ?? bot.threadId)),
          list: Effect.succeed([]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "message.record") posted.push([command.threadId, command.text]);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(Push.WebPush)({
          send: (input) =>
            Effect.sync(() => {
              pushed.push(input.body);
              return { delivered: 1, failed: 0 };
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* Notifications.BotNotifications;
    const result = yield* service.notify(threadId ?? bot.threadId, "Математика в 10:20", options);
    assert.deepEqual(pushed, pushes ? ["Математика в 10:20"] : []);
    // Every notification is readable in the bot's own chat, whichever thread sent it.
    assert.deepEqual(posted, inChat ? [] : [[bot.threadId, "Математика в 10:20"]]);
    assert.equal(result.postedInChat, !inChat);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { name: "the open chat", pushes: false },
  { name: "a chat nobody reported for 15 s", after: "15 seconds" as const, pushes: true },
  { name: "another bot's open chat", viewing: ThreadId.make("music"), pushes: true },
])("notify while a client views $name: push=$pushes", ({ viewing, after, pushes }) => {
  const bot: BotRecord = {
    name: "news",
    persona: "Report news",
    dailyTokenCap: 100,
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
    threadId: ThreadId.make("news"),
    projectId: ProjectId.make("bots"),
    createdAt: "2026-10-26T00:00:00Z",
    notifiedAt: null,
    unread: false,
    lastNotification: null,
  };
  const pushed: string[] = [];
  const unread: string[] = [];
  const previews: string[] = [];
  const layer = Notifications.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          owner: () => Effect.succeed(bot),
          notify: (_id, text) =>
            Effect.sync(() => {
              unread.push(text);
              return { ...bot, unread: true, lastNotification: text };
            }),
          preview: (_id, text) =>
            Effect.sync(() => {
              previews.push(text);
              return { ...bot, lastNotification: text };
            }),
          telegramTurn: () => Effect.succeed(false),
          list: Effect.succeed([]),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(Push.WebPush)({
          send: (input) =>
            Effect.sync(() => {
              pushed.push(input.body);
              return { delivered: 1, failed: 0 };
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* Notifications.BotNotifications;
    yield* service.seen(viewing ?? bot.threadId, true, "pc");
    if (after) yield* TestClock.adjust(after);
    yield* service.notify(bot.threadId, "Sign in to example.com");
    const text = ["Sign in to example.com"];
    assert.deepEqual(pushed, pushes ? text : []);
    assert.deepEqual(unread, pushes ? text : []);
    assert.deepEqual(previews, pushes ? [] : text);
  }).pipe(Effect.provide(layer));
});

const started = DateTime.makeUnsafe("2026-11-05T10:00:00Z");
const message = (
  role: "user" | "assistant",
  text: string,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(`${role}:${text}`),
  threadId: ThreadId.make("news"),
  runId: RunId.make("run"),
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: started,
  updatedAt: started,
  createdBy: "user",
  creationSource: "web",
  ...extra,
});

it.effect.each([
  { name: "user waiting", pushes: true },
  { name: "conversation on screen", viewing: true, pushes: false, preview: true },
  { name: "conversation left", viewing: true, left: "pc", pushes: true },
  { name: "another client leaving", viewing: true, left: "phone", pushes: false, preview: true },
  { name: "wake", asked: { scheduledTaskId: ScheduledTaskId.make("watch") }, pushes: false },
  { name: "another bot", asked: { createdBy: "agent" as const }, pushes: false, preview: true },
  {
    name: "the first-run greeting",
    asked: { createdBy: "agent" as const, creationSource: "server" as const },
    userMessageId: "bots:kickoff:main",
    pushes: false,
    preview: true,
  },
  {
    name: "a sealed bot answering Main",
    kind: "music" as const,
    asked: { createdBy: "agent" as const, senderThreadId: ThreadId.make("main") },
    pushes: false,
    preview: true,
  },
  {
    name: "a hidden upkeep turn",
    asked: { createdBy: "agent" as const },
    userMessageId: "bots:flush:1",
    pushes: false,
  },
  {
    name: "a new bot's example",
    asked: { createdBy: "agent" as const },
    userMessageId: "bots:example:bot-1",
    pushes: true,
  },
  { name: "a Telegram message, answered there", userMessageId: "tg:7:12", pushes: false },
  { name: "notify_user during the run", notifiedAt: "2026-11-05T10:00:05Z", pushes: false },
  { name: "muted bot", muted: true, pushes: false },
  { name: "an emoji-only reply after a reaction", replies: ["👍 "], reacted: true, pushes: false },
  { name: "an emoji-only reply", replies: [" ✅ "], pushes: false },
  { name: "text, then a closing emoji", replies: ["Done", "✅"], pushes: true, pushed: "Done" },
  { name: "a turn that sent to Telegram", sentToTelegram: true, pushes: false },
])(
  "reply for $name: push=$pushes, once per run",
  ({
    viewing,
    left,
    asked,
    notifiedAt,
    muted,
    pushes,
    pushed,
    preview,
    replies,
    reacted,
    userMessageId,
    sentToTelegram,
    kind,
  }) => {
    const bot: BotRecord = {
      ...(kind ? { kind } : {}),
      name: "news",
      persona: "Report news",
      dailyTokenCap: 100,
      modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
      threadId: ThreadId.make("news"),
      projectId: ProjectId.make("bots"),
      createdAt: "2026-10-26T00:00:00Z",
      notifiedAt: notifiedAt ?? "2026-11-05T09:00:00Z",
      unread: false,
      lastNotification: null,
      ...(muted ? { muted } : {}),
    };
    const run: OrchestrationV2Run = {
      id: RunId.make("run"),
      threadId: bot.threadId,
      ordinal: 1,
      providerInstanceId: bot.modelSelection.instanceId,
      modelSelection: bot.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(userMessageId ?? "user:Status?"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: started,
      startedAt: started,
      completedAt: started,
      checkpointId: null,
      contextHandoffId: null,
    };
    const sent: string[] = [];
    const previews: Array<string | null> = [];
    const previewed: string[] = [];
    const claimed = new Set<string>();
    const layer = Notifications.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Store.BotStore)({
            get: () => Effect.succeed(bot),
            owner: () => Effect.succeed(bot),
            notify: () => Effect.succeed(bot),
            wake: () => Effect.undefined,
            telegramTurn: () => Effect.succeed(sentToTelegram === true),
            preview: (id, text) =>
              Effect.sync(() => {
                previewed.push(id);
                previews.push(text);
                return { ...bot, lastNotification: text };
              }),
            list: Effect.succeed([]),
            claimAlert: (key) => Effect.sync(() => !claimed.has(key) && !!claimed.add(key)),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
            getThreadRecords: (_threadId, _fields, filter) =>
              Effect.succeed({
                messages: filter?.messageIds
                  ? [message("user", "Status?", asked)]
                  : (replies ?? ["Checking.", " All 21 checks **OK**. "]).map((text) =>
                      message("assistant", text),
                    ),
                turnItems: reacted
                  ? [{ type: "dynamic_tool", status: "completed", toolName: "mcp__t3-code__react" }]
                  : [],
              } as never),
          }),
          Layer.mock(Push.WebPush)({
            send: (input) =>
              Effect.sync(() => {
                sent.push(input.body);
                return { delivered: 1, failed: 0 };
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* Notifications.BotNotifications;
      if (viewing) yield* service.seen(bot.threadId, true, "pc");
      if (left) yield* service.seen(bot.threadId, false, left);
      yield* service.reply(run);
      yield* service.reply(run);
      assert.deepEqual(sent, pushes ? [pushed ?? "All 21 checks OK."] : []);
      assert.deepEqual(previews, preview ? ["All 21 checks **OK**."] : []);
      assert.deepEqual(previewed, preview ? [bot.threadId] : []);
    }).pipe(Effect.provide(layer));
  },
);

const failingBot: BotRecord = {
  name: "watch",
  persona: "Watch",
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
  threadId: ThreadId.make("watch"),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-10-26T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
};
const failureLayer = (input: {
  readonly stopped?: boolean;
  readonly lastError?: string | null;
}) => {
  const sent: string[] = [];
  const claimed = new Set<string>();
  const layer = Notifications.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          get: (id) => Effect.succeed(id === failingBot.threadId ? failingBot : undefined),
          botFor: (id) =>
            Effect.succeed(
              id === failingBot.threadId || id === "bot-wake:1" ? failingBot : undefined,
            ),
          owner: () => Effect.succeed(failingBot),
          notify: () => Effect.succeed(failingBot),
          wake: (id) =>
            Effect.succeed(
              id === "bot-wake:1"
                ? {
                    threadId: ThreadId.make("bot-wake:1"),
                    botThreadId: failingBot.threadId,
                    taskId: "task",
                    title: "Watch",
                    startedAt: 0,
                  }
                : undefined,
            ),
          telegramTurn: () => Effect.succeed(false),
          family: () => Effect.succeed([failingBot.threadId]),
          recordStop: () => Effect.void,
          list: Effect.succeed([
            {
              ...failingBot,
              tokensToday: 0,
              usage: [],
              stopped: input.stopped ?? false,
              resumesAt: null,
            },
          ]),
          claimAlert: (key) => Effect.sync(() => !claimed.has(key) && !!claimed.add(key)),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
          stopDelegatedTasks: () => Effect.succeed({ stopped: [] } as never),
          interruptThread: () => Effect.succeed({} as never),
          getThreadShell: () =>
            Effect.succeed({
              lastError:
                input.lastError === undefined
                  ? "OpenCode exited with code 1\nstack"
                  : input.lastError,
            } as never),
        }),
        Layer.mock(Push.WebPush)({
          send: (push) =>
            Effect.sync(() => {
              sent.push(push.body);
              return { delivered: 1, failed: 0 };
            }),
        }),
      ),
    ),
  );
  return { sent, layer };
};
const failedRun = (
  id: string,
  threadId = failingBot.threadId,
  userMessageId = "wake",
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal: 1,
  providerInstanceId: failingBot.modelSelection.instanceId,
  modelSelection: failingBot.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(userMessageId),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: started,
  startedAt: started,
  completedAt: started,
  checkpointId: null,
  contextHandoffId: null,
});

it.effect.each([
  { name: "a failing bot", expected: ["Run failed: OpenCode exited with code 1"] },
  {
    name: "a failure with no error",
    lastError: null,
    expected: ["Run failed: no error reported."],
  },
  { name: "a capped bot", stopped: true, expected: [] },
  {
    name: "a wake",
    threadId: ThreadId.make("bot-wake:1"),
    expected: ["Run failed: OpenCode exited with code 1"],
  },
  { name: "a worker", threadId: ThreadId.make("worker"), expected: [] },
  { name: "a memory flush", userMessageId: "bots:flush:run-0", expected: [] },
])(
  "run failures of $name push at most once a day",
  ({ stopped, lastError, threadId, userMessageId, expected }) => {
    const { sent, layer } = failureLayer({
      ...(stopped === undefined ? {} : { stopped }),
      ...(lastError === undefined ? {} : { lastError }),
    });
    return Effect.gen(function* () {
      const service = yield* Notifications.BotNotifications;
      yield* service.seen(failingBot.threadId, true, "pc");
      yield* service.failed(failedRun("run-1", threadId, userMessageId));
      yield* service.failed(failedRun("run-2", threadId, userMessageId));
      assert.deepEqual(sent, expected);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a cap stop tells the user once, even in the open chat", () => {
  const { sent, layer } = failureLayer({ stopped: true });
  return Effect.gen(function* () {
    const service = yield* Notifications.BotNotifications;
    yield* service.seen(failingBot.threadId, true, "pc");
    yield* service.stop(failingBot.threadId, "cap:watch:100:2026-11-05", "Daily cap reached.");
    yield* service.stop(failingBot.threadId, "cap:watch:100:2026-11-05", "Daily cap reached.");
    assert.deepEqual(sent, ["Daily cap reached."]);
  }).pipe(Effect.provide(layer));
});

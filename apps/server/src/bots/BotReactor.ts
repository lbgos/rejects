import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Store from "./BotStore.ts";
import * as Service from "./BotService.ts";
import * as Notifications from "./BotNotifications.ts";
import { capNotice } from "./capNotice.ts";
import { chatLanguageOf } from "./language.ts";
import { REQUEST_REDIRECT, STEWARD_SCHEDULE_ID, STEWARD_THREAD_ID } from "./steward.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Lifecycle from "../serverLifecycleEvents.ts";

// A provider can hang mid-request without a timeout of its own, and nobody watches a bot to press
// Stop. computer_shell runs at most 10 minutes, so a quieter run is stuck.
export const STALL_MS = 15 * 60_000;
const TERMINAL_RUN: ReadonlyArray<string> = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];
const STALL_REASON = "Run stopped: no response from the model for 15 minutes.";

/**
 * Prod wakes made at most 69 calls (p99 53) until one looped 338 times around an anti-bot wall. At the cap the run is told to wrap up; a few calls later it is stopped.
 * Chats have no cap: their longest turn made 57.
 */
export const WAKE_TOOL_CALLS = 100;
const WRAP_UP_CALLS = 10;
const TOOL_ITEMS: ReadonlySet<string> = new Set([
  "dynamic_tool",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
]);
export const WAKE_WRAP_UP = `[Budget] This wake has made ${WAKE_TOOL_CALLS} tool calls, its limit. Stop calling tools. Reply now with what you found, and call notify_user only if the job asks for a report; the rest waits for the next wake.`;
const WAKE_STOPPED = `Wake stopped: it kept calling tools past its budget of ${WAKE_TOOL_CALLS}.`;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    yield* Service.BotService;
    const notifications = yield* Notifications.BotNotifications;
    const threads = yield* Threads.ThreadManagementService;
    const events = yield* Events.EventSinkV2;
    const lifecycle = yield* Lifecycle.ServerLifecycleEvents;
    const tasks = yield* Tasks.ScheduledTaskService;
    // Last activity of each bot thread's active run, from event times. Untraced: runs per event.
    const running = yield* Ref.make(new Map<ThreadId, { runId: RunId; at: number }>());
    // Tool items seen per wake run, for the wake budget. Untraced: runs per tool event.
    const wakeTools = yield* Ref.make(new Map<RunId, ReadonlySet<string>>());
    const countWakeTool = Effect.fnUntraced(function* (
      threadId: ThreadId,
      runId: RunId,
      itemId: string,
    ) {
      if ((yield* bots.wake(threadId)) === undefined) return;
      const [before, after] = yield* Ref.modify(wakeTools, (map) => {
        const seen = new Set(map.get(runId)).add(itemId);
        return [[map.get(runId)?.size ?? 0, seen.size] as const, new Map(map).set(runId, seen)];
      });
      const crossed = (limit: number) => before < limit && after >= limit;
      const stop = WAKE_TOOL_CALLS + WRAP_UP_CALLS;
      if (!crossed(WAKE_TOOL_CALLS) && !crossed(stop)) return;
      const bot = yield* bots.owner(threadId);
      if (!bot) return;
      yield* Effect.logWarning("bots.wake-tool-budget", {
        threadId,
        runId,
        calls: after,
        action: crossed(stop) ? "stopped" : "wrap-up",
      });
      if (crossed(stop))
        return yield* threads
          .interruptThread({
            projectId: bot.projectId,
            threadId,
            runId,
            commandId: CommandId.make(`bots:wake-budget:stop:${runId}`),
            reason: WAKE_STOPPED,
          })
          .pipe(Effect.ignore({ log: true }));
      yield* threads
        .sendToThread({
          projectId: bot.projectId,
          commandId: CommandId.make(`bots:wake-budget:${runId}`),
          messageId: MessageId.make(`bots:wake-budget:${runId}`),
          threadId,
          text: WAKE_WRAP_UP,
          attachments: [],
          mode: "steer",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.ignore({ log: true }));
    });
    const track = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      const at = DateTime.toEpochMillis(event.occurredAt);
      if (event.type === "run.updated") {
        const run = event.payload;
        if (["starting", "running", "waiting"].includes(run.status)) {
          if (yield* bots.owner(event.threadId))
            yield* Ref.update(running, (map) =>
              new Map(map).set(event.threadId, { runId: run.id, at }),
            );
        } else
          yield* Ref.update(running, (map) => {
            if (map.get(event.threadId)?.runId !== run.id) return map;
            const next = new Map(map);
            next.delete(event.threadId);
            return next;
          });
        if (TERMINAL_RUN.includes(run.status))
          yield* Ref.update(wakeTools, (map) => {
            if (!map.has(run.id)) return map;
            const next = new Map(map);
            next.delete(run.id);
            return next;
          });
      } else if (event.runId !== undefined) {
        const runId = event.runId;
        if (event.type === "turn-item.updated" && TOOL_ITEMS.has(event.payload.type))
          yield* countWakeTool(event.threadId, runId, event.payload.id);
        yield* Ref.update(running, (map) =>
          map.get(event.threadId)?.runId === runId
            ? new Map(map).set(event.threadId, { runId, at })
            : map,
        );
      }
    });
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const stalled = yield* Ref.modify(running, (map) => {
        const quiet = [...map].filter(([, run]) => now - run.at >= STALL_MS);
        const next = new Map(map);
        for (const [threadId] of quiet) next.delete(threadId);
        return [quiet, next] as const;
      });
      for (const [threadId, { runId }] of stalled) {
        const bot = yield* bots.owner(threadId);
        if (!bot) continue;
        yield* threads
          .interruptThread({
            projectId: bot.projectId,
            threadId,
            runId,
            commandId: CommandId.make(`bots:stall:${runId}`),
            reason: STALL_REASON,
          })
          .pipe(Effect.ignore({ log: true }));
        const stalledText = {
          en: STALL_REASON,
          ru: "Запуск остановлен: модель не отвечала 15 минут.",
          uk: "Запуск зупинено: модель не відповідала 15 хвилин.",
        }[yield* chatLanguageOf(threads, bot.threadId)];
        // A stalled wake posts its own notice in the chat when it ends.
        const wake = (yield* bots.wake(threadId)) !== undefined;
        yield* notifications
          .notify(bot.threadId, stalledText, { always: true, inChat: wake })
          .pipe(Effect.ignore({ log: true }));
      }
    }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
    yield* threads.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          yield* track(event);
          if ((yield* bots.mainBot) === event.threadId) {
            if (event.type === "run.created")
              yield* bots
                .claimApproval(event.payload.id, event.payload.userMessageId)
                .pipe(Effect.ignore({ log: true }));
            else if (event.type === "run.updated" && TERMINAL_RUN.includes(event.payload.status))
              yield* bots.endApproval(event.payload.id).pipe(Effect.ignore({ log: true }));
            else if (
              event.type === "message.updated" &&
              event.payload.role === "user" &&
              event.payload.createdBy !== "agent"
            )
              yield* bots.endApprovalOnMessage(event.payload.id).pipe(Effect.ignore({ log: true }));
          }
          if (event.type !== "provider-turn.updated" && event.type !== "run.updated") return;
          const bot = yield* bots.owner(event.threadId);
          if (!bot) return;
          if (event.type === "run.updated") {
            const run = event.payload;
            yield* Effect.gen(function* () {
              if (run.status === "completed") yield* notifications.reply(run);
              if (run.status === "failed") yield* notifications.failed(run);
            }).pipe(
              Effect.ensuring(
                TERMINAL_RUN.includes(run.status)
                  ? bots.endTelegramTurn(run.threadId)
                  : Effect.void,
              ),
            );
          }
          const summary = (yield* bots.list).find((b) => b.threadId === bot.threadId);
          if (summary && summary.tokensToday >= summary.dailyTokenCap) {
            yield* notifications.stop(
              bot.threadId,
              `cap:${bot.threadId}:${summary.dailyTokenCap}:${DateTime.formatIso(yield* DateTime.now).slice(0, 10)}`,
              capNotice(summary),
            );
          }
        }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.forkScoped,
    );

    // Replay and live delivery share one cursor. Stable command/message ids make
    // a crash between dispatch and cursor persistence safe to retry.
    if ((yield* bots.stewardCursor) === undefined)
      yield* bots.stewardHandled(yield* events.latestSequence());
    const handle = Effect.fn("BotReactor.handle")(function* (event: OrchestrationV2DomainEvent) {
      const owner = yield* bots.owner(event.threadId);
      const enabled = (yield* tasks.list()).tasks.some(
        (task) => task.id === STEWARD_SCHEDULE_ID && task.enabled,
      );
      if (!owner && !enabled) return undefined;
      const request =
        event.type === "runtime-request.updated" &&
        event.payload.status === "pending" &&
        event.payload.kind !== "dynamic_tool_call" &&
        event.payload.kind !== "auth_refresh"
          ? event.payload
          : undefined;
      const failed = event.type === "run.updated" && event.payload.status === "failed";
      const runId = event.runId ?? (event.type === "run.updated" ? event.payload.id : undefined);
      const question =
        event.type === "turn-item.updated" && event.payload.type === "user_input_request"
          ? event.payload
          : undefined;
      if (!request && !failed && !question) return undefined;
      if (owner && !request && !question) return undefined;
      // The runtime request is emitted before its question item. Handle live
      // approvals here; questions wait for the item containing their text.
      if (request?.kind === "user_input") return undefined;
      const key = request
        ? `request:${request.id}`
        : question
          ? `request:${question.requestId}`
          : `failed:${runId}`;
      const delivery = yield* bots.stewardDelivery(key);
      if (delivery === "duplicate") return undefined;
      if (delivery === "limited") return yield* new Store.BotStoreError({ operation: "rate" });
      const records =
        request || question
          ? yield* threads.getThreadRecords(event.threadId, ["runtimeRequests"])
          : undefined;
      const shell = yield* threads.getThreadShell(event.threadId);
      const pending = records?.runtimeRequests.find(
        (r) => r.id === (request?.id ?? question?.requestId),
      );
      const declineId = CommandId.make(`bots:decline:${key}`);
      // A restart can replay an opened request that the user already answered.
      // A receipt from our own decline means only the redirect remains to retry.
      const declinedHere = pending && (yield* threads.hasReceipt(declineId));
      if ((request || question) && pending?.status !== "pending" && !declinedHere) return undefined;
      if (
        pending &&
        (pending.status === "pending" || declinedHere) &&
        pending.responseCapability.type !== "not_resumable"
      ) {
        yield* threads.dispatch({
          type: "runtime-request.respond",
          commandId: declineId,
          threadId: event.threadId,
          requestId: pending.id,
          decision: "decline",
          // Codex and OpenCode's live question protocol needs an empty answer
          // map to release the request without selecting or inventing an answer.
          ...(pending.kind === "user_input" ? { answers: {} } : {}),
        });
        // Queue the redirect as the next user message; do not interrupt or
        // steer the provider turn that is receiving the decline.
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`bots:redirect:${key}`),
          messageId: MessageId.make(`bots:redirect:${key}`),
          threadId: event.threadId,
          text: `[Declined ${pending.kind} ${pending.id}] ${REQUEST_REDIRECT}`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      if (!owner && enabled) {
        const detail = question
          ? question.questions.map((q) => q.question).join("; ")
          : request
            ? `Declined ${request.kind}; redirect queued.`
            : "Run failed. Read its failure and notify_user.";
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`bots:steward:${key}`),
          messageId: MessageId.make(`bots:steward:${key}`),
          threadId: STEWARD_THREAD_ID,
          text: `[${question ? "question" : request ? "declined" : "failed"}] thread=${event.threadId} run=${runId ?? "unknown"} title=${(shell?.title ?? event.threadId).replace(/\s+/g, " ").slice(0, 100)}: ${detail.replace(/\s+/g, " ").slice(0, 600)}`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      return key;
    });
    yield* Stream.unwrap(
      lifecycle.awaitReady.pipe(
        Effect.andThen(bots.stewardCursor),
        Effect.map((afterSequence) => events.stream({ afterSequence: afterSequence ?? 0 })),
      ),
    ).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" ||
          (event.type === "turn-item.updated" && event.payload.type === "user_input_request") ||
          event.type === "run.updated",
      ),
      Stream.tap(({ event, sequence }) =>
        Effect.gen(function* () {
          const key = yield* handle(event);
          yield* bots.stewardHandled(sequence, key);
        }),
      ),
      Stream.tapError(() =>
        Effect.logWarning("Steward delivery delayed; retrying from the saved cursor."),
      ),
      Stream.retry(Schedule.spaced("1 minute")),
      Stream.runDrain,
      Effect.forkScoped,
    );
  }),
);

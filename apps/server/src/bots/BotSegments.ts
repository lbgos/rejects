import {
  BOT_COMPACT_MESSAGE_PREFIX,
  BOT_KEEPWARM_MESSAGE_PREFIX,
  BOT_KEEPWARM_TEXT,
  CommandId,
  IDLE_COMPACTION_TEXT,
  isTelegramMessage,
  MessageId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AgentSandbox } from "@t3tools/shared/AgentScope";
import * as Memory from "./BotMemoryStore.ts";
import * as Store from "./BotStore.ts";
import { STALL_MS } from "./BotReactor.ts";
import { jobLine, turnContext } from "./instructions.ts";
import {
  DENSE_MIN,
  memoryIndex,
  mergeRanked,
  pickRecalled,
  RECALL_MIN,
  recallQueries,
  recalledLine,
} from "./memory.ts";
import { chatLanguage, chatLanguageOf, type ChatLanguage } from "./language.ts";
import {
  nextContextStep,
  reactedMessages,
  unseenMessages,
  wakeAnswer,
  wakeResultMessage,
  wakeSummary,
} from "./segments.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Lifecycle from "../serverLifecycleEvents.ts";

const REACTION_FEEDBACK = 5;
const RECALL_REPEAT_TURNS = 10;
const SEEN_THREADS = 500;
const RECALL_CANDIDATES = 20;
const NUDGE_BUDGET = 0.9;

interface Seen {
  turn: number;
  coreCounted: boolean;
  readonly recalled: Map<string, number>;
}

const minute = (ms: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 16).replace("T", " ");

const RESUME_LOCALE: Record<ChatLanguage, string> = { en: "en-GB", ru: "ru-RU", uk: "uk-UA" };

const capCause = (language: ChatLanguage, resumesAt: string | null) => {
  const at = resumesAt === null ? Number.NaN : Date.parse(resumesAt);
  const time = Number.isFinite(at)
    ? new Intl.DateTimeFormat(RESUME_LOCALE[language], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(at)
    : null;
  if (language === "ru")
    return time === null
      ? "дневной лимит токенов исчерпан, работа возобновится завтра."
      : `дневной лимит токенов исчерпан, работа возобновится в ${time}.`;
  if (language === "uk")
    return time === null
      ? "денний ліміт токенів вичерпано, робота відновиться завтра."
      : `денний ліміт токенів вичерпано, робота відновиться о ${time}.`;
  return time === null
    ? "the daily token cap was reached; work resumes tomorrow."
    : `the daily token cap was reached; work resumes at ${time}.`;
};

export class BotTurns extends Context.Service<
  BotTurns,
  {
    readonly forTurn: (input: {
      readonly run: OrchestrationV2Run;
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly message: string;
    }) => Effect.Effect<string | undefined, Projections.ProjectionStoreV2Error>;
  }
>()("t3/bots/BotSegments/BotTurns") {}

export const turnsLayer = Layer.effect(
  BotTurns,
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    const memory = yield* Memory.BotMemoryStore;
    const projections = yield* Projections.ProjectionStoreV2;
    // Lives in memory: after a restart a thread may see a note recalled once more.
    const seenBy = new Map<string, Seen>();
    const seenIn = (providerThreadId: string) => {
      const seen = seenBy.get(providerThreadId) ?? {
        turn: 0,
        coreCounted: false,
        recalled: new Map(),
      };
      seenBy.delete(providerThreadId);
      seenBy.set(providerThreadId, seen);
      if (seenBy.size > SEEN_THREADS) seenBy.delete(seenBy.keys().next().value!);
      seen.turn += 1;
      return seen;
    };

    const notesForTurn = Effect.fn("BotTurns.notesForTurn")(function* (input: {
      readonly botThreadId: ThreadId;
      readonly providerThreadId: string;
      readonly queries: ReadonlyArray<string>;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const at = DateTime.formatIso(DateTime.makeUnsafe(now));
      const scopes = ["you", input.botThreadId] as const;
      const you = yield* memory.core("you", at);
      const own = yield* memory.core(input.botThreadId, at);
      const seen = seenIn(input.providerThreadId);
      const exclude = new Set([
        ...you.shown.map((note) => note.id),
        ...own.shown.map((note) => note.id),
        ...[...seen.recalled]
          .filter(([, turn]) => seen.turn - turn < RECALL_REPEAT_TURNS)
          .map(([id]) => id),
      ]);
      // Recall and the use counts only add to the core; when they fail the turn keeps the core.
      const ranked = yield* Effect.forEach(input.queries, (query) =>
        memory.search(scopes, query, {
          limit: RECALL_CANDIDATES,
          min: RECALL_MIN,
          now,
          scan: false,
          dense: DENSE_MIN.recall,
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Bot memory recall failed", { cause }).pipe(Effect.as([])),
        ),
      );
      const recalled = pickRecalled(mergeRanked(ranked), exclude);
      for (const { note } of recalled) seen.recalled.set(note.id, seen.turn);
      const used = [
        ...(seen.coreCounted
          ? []
          : [
              ...you.shown.map((note) => ({ scope: "you" as const, id: note.id })),
              ...own.shown.map((note) => ({ scope: input.botThreadId, id: note.id })),
            ]),
        ...recalled.map(({ scope, note }) => ({ scope, id: note.id })),
      ];
      seen.coreCounted = true;
      yield* memory
        .touch(used, at)
        .pipe(Effect.catch((cause) => Effect.logWarning("Bot memory use count failed", { cause })));
      return {
        you: memoryIndex(you.shown, you.total),
        memory: memoryIndex(own.shown, own.total),
        recalled: recalled.map(({ note }) => recalledLine(note)),
      };
    });
    const notes = (input: Parameters<typeof notesForTurn>[0]) =>
      notesForTurn(input).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Bot memory unavailable for a turn", { cause }).pipe(
            Effect.as({ you: "unavailable", memory: "unavailable", recalled: [] }),
          ),
        ),
      );

    // A standalone bot gets no notes, in its chat or its wakes: the shared ones come from the
    // other bots' chats.
    return BotTurns.of({
      forTurn: Effect.fn("BotTurns.forTurn")(function* ({ run, providerThreadId, message }) {
        const bot = yield* bots.botFor(run.threadId);
        if (!bot) return undefined;
        const clock = {
          now: yield* Clock.currentTimeMillis,
          timeZone: yield* bots.timeZone,
        };
        if (bot.threadId !== run.threadId) {
          const previous = yield* bots.previousWake(run.threadId);
          return turnContext({
            // A wake sees no chat, so it takes the language from the bot's chat.
            language: yield* chatLanguageOf(projections, bot.threadId),
            ...clock,
            ...(bot.standalone
              ? {}
              : yield* notes({
                  botThreadId: bot.threadId,
                  providerThreadId,
                  queries: recallQueries(message, jobLine(bot)),
                })),
            previousWake:
              previous?.result === undefined
                ? undefined
                : { at: minute(previous.startedAt), result: previous.result },
          });
        }
        const records = yield* projections.getThreadRecords(run.threadId, ["runs", "messages"], {
          turnItemTypes: [],
        });
        // The prompt names attachment paths; this chat's files must exist at them in the sandbox.
        const attachments = records.messages.flatMap((entry) => entry.attachments);
        if (attachments.length > 0) {
          yield* (yield* AgentSandbox).stageAttachments(run.threadId, attachments);
        }
        const historyFromMs =
          bot.historyFrom === undefined ? undefined : Date.parse(bot.historyFrom);
        const lastReply = records.messages
          .filter((m) => m.role === "assistant" && m.runId !== run.id && !m.streaming)
          .toSorted(
            (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
          )
          .at(-1)?.text;
        return turnContext({
          language: chatLanguage(records.messages),
          ...clock,
          telegram: isTelegramMessage(run.userMessageId),
          ...(bot.standalone
            ? {}
            : yield* notes({
                botThreadId: bot.threadId,
                providerThreadId,
                queries: recallQueries(message, lastReply),
              })),
          unseen: unseenMessages({
            runs: records.runs,
            messages: records.messages,
            run,
            providerThreadId,
            historyFromMs,
          }),
          reactions: reactedMessages({
            reactions: bot.reactions,
            messages: records.messages,
            historyFromMs,
            max: REACTION_FEEDBACK,
          }),
        });
      }),
    });
  }),
);

/** Timers live in memory and start from persisted run ends; startup reschedules every bot chat. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    const threads = yield* Threads.ThreadManagementService;
    const lifecycle = yield* Lifecycle.ServerLifecycleEvents;
    const timers = yield* FiberMap.make<ThreadId>();

    // A nudge reads the whole context at a tenth of its price; it never takes a bot to its cap.
    const nudgeFits = Effect.fn("BotSegments.nudgeFits")(function* (threadId: ThreadId) {
      const bot = (yield* bots.list).find((b) => b.threadId === threadId);
      return (
        bot !== undefined && !bot.stopped && bot.tokensToday < NUDGE_BUDGET * bot.dailyTokenCap
      );
    });

    const followChat = Effect.fn("BotSegments.followChat")(
      function* (threadId: ThreadId) {
        yield* lifecycle.awaitReady;
        while (true) {
          if (!(yield* bots.get(threadId))) return;
          const records = yield* threads.getThreadRecords(
            threadId,
            ["runs", "runtimeRequests", "providerTurns"],
            { messageRoles: [], turnItemTypes: [] },
          );
          const now = yield* Clock.currentTimeMillis;
          const step = nextContextStep(records, now, yield* nudgeFits(threadId));
          if (step === null) return;
          if (step.type === "wait") {
            yield* Effect.sleep(Duration.millis(step.untilMs - now));
            continue;
          }
          // The orchestrator skips both once a turn runs or waits; that turn's end reschedules.
          const id =
            step.type === "nudge"
              ? `${BOT_KEEPWARM_MESSAGE_PREFIX}${step.runId}:${step.nudge}`
              : `${BOT_COMPACT_MESSAGE_PREFIX}${step.runId}`;
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            messageId: MessageId.make(id),
            threadId,
            text: step.type === "nudge" ? BOT_KEEPWARM_TEXT : IDLE_COMPACTION_TEXT,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
            ...(step.type === "nudge" ? {} : { idleCompaction: "beforeCacheExpires" as const }),
          });
          return;
        }
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Bot context step skipped", { threadId, cause }),
          ),
        ),
    );

    const endWake = Effect.fn("BotSegments.endWake")(
      function* (run: OrchestrationV2Run) {
        const wake = yield* bots.wake(run.threadId);
        if (!wake || wake.result !== undefined) return;
        const records = yield* threads.getThreadRecords(
          run.threadId,
          ["runs", "messages", "turnItems"],
          { messageRunIds: [run.id], messageRoles: ["assistant"], turnItemRunIds: [run.id] },
        );
        // A declined request queues a redirect in the same wake; its last run carries the result.
        if (records.runs.some((r) => r.ordinal > run.ordinal)) return;
        const reply =
          wakeAnswer(records.turnItems, records.messages) ||
          (records.messages
            .findLast((m) => m.runId === run.id && !m.streaming && m.text.trim())
            ?.text.trim() ??
            "");
        const error = (yield* threads.getThreadShell(run.threadId))?.lastError
          ?.trim()
          .split("\n")[0];
        const bot = yield* bots.get(wake.botThreadId);
        // With the chat open a notification sets no notifiedAt, so the run's own call counts too.
        const calledNotify = records.turnItems.some(
          (item) =>
            item.type === "dynamic_tool" &&
            item.status === "completed" &&
            item.toolName?.replace(/^.*__/, "") === "notify_user",
        );
        const notified =
          calledNotify || (bot?.notifiedAt != null && Date.parse(bot.notifiedAt) >= wake.startedAt)
            ? (bot?.lastNotification ?? null)
            : null;
        const completed = run.status === "completed";
        const language = yield* chatLanguageOf(threads, wake.botThreadId);
        // A capped bot cannot start a turn, so a failed wake of one is its cap talking.
        const summary = (yield* bots.list).find((b) => b.threadId === wake.botThreadId);
        const capped = summary !== undefined && summary.tokensToday >= summary.dailyTokenCap;
        const stalled =
          run.status === "interrupted" &&
          run.startedAt !== null &&
          run.completedAt !== null &&
          Duration.toMillis(DateTime.distance(run.startedAt, run.completedAt)) >= STALL_MS;
        const cause = capped
          ? capCause(language, summary.resumesAt)
          : error
            ? error.slice(0, 200)
            : stalled
              ? {
                  en: "the model did not answer for 15 minutes.",
                  ru: "модель не отвечала 15 минут.",
                  uk: "модель не відповідала 15 хвилин.",
                }[language]
              : undefined;
        const text = completed
          ? reply ||
            notified ||
            {
              en: `${wake.title}: finished without a reply.`,
              ru: `${wake.title}: завершилось без ответа.`,
              uk: `${wake.title}: завершилося без відповіді.`,
            }[language]
          : {
              en: `${wake.title} ${run.status}: ${cause ?? "no error reported."}`,
              ru: `${wake.title}: ${run.status === "failed" ? "сбой" : "остановлено"}: ${cause ?? "причина не указана."}`,
              uk: `${wake.title}: ${run.status === "failed" ? "збій" : "зупинено"}: ${cause ?? "причину не вказано."}`,
            }[language];
        const previous = yield* bots.previousWake(run.threadId);
        const ended = yield* bots.endWake(run.threadId, wakeSummary(text));
        if (!ended) return;
        // A quiet wake stays in its own thread: the chat shows one message for a wake that notified
        // or failed, and a failure once while the next wakes of the schedule fail the same way.
        const repeated = !completed && previous?.result === ended.wake.result;
        if ((!completed && !repeated) || notified !== null) {
          const id = `bots:wake-result:${run.threadId}`;
          // The chat's only copy of what the wake pushed; the record is idempotent, so retry once.
          yield* threads
            .dispatch({
              type: "message.record",
              commandId: CommandId.make(id),
              threadId: wake.botThreadId,
              messageId: MessageId.make(id),
              // A wake that pushed and then failed keeps what it pushed in its one message.
              text: wakeResultMessage(
                !completed && notified !== null ? `${notified}\n\n${text}` : text,
              ),
            })
            .pipe(Effect.retry({ times: 1 }));
          if (notified === null) yield* bots.preview(wake.botThreadId, wakeResultMessage(text));
        }
        for (const old of ended.pruned)
          yield* threads
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`bots:prune:${old}`),
              threadId: old,
            })
            .pipe(Effect.ignore({ log: true }));
      },
      (effect, run) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Bot wake result not posted", { threadId: run.threadId, cause }),
          ),
        ),
    );

    yield* threads.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated") return;
          const run = event.payload;
          if (
            run.status !== "completed" &&
            run.status !== "failed" &&
            run.status !== "interrupted" &&
            run.status !== "cancelled"
          )
            return;
          yield* Store.endTourAfter(bots, run.userMessageId).pipe(Effect.ignore({ log: true }));
          if (yield* bots.wake(run.threadId)) return yield* endWake(run);
          if (yield* bots.get(run.threadId))
            yield* FiberMap.run(timers, run.threadId, followChat(run.threadId));
        }),
      ),
      Effect.forkScoped,
    );
    for (const bot of yield* bots.list.pipe(Effect.orElseSucceed(() => [])))
      yield* FiberMap.run(timers, bot.threadId, followChat(bot.threadId));
  }),
);

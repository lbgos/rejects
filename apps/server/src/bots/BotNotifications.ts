import {
  CommandId,
  emojiOnlyReply,
  isBotExampleMessage,
  isBotUpkeepMessage,
  isReactionEcho,
  isTelegramMessage,
  MessageId,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { markdownPreview } from "@t3tools/shared/markdownPreview";
import * as Store from "./BotStore.ts";
import * as Push from "../push/WebPush.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";

/** Clients report the open bot conversation every 5 s while in use; two missed polls end it. */
const VIEWING_MS = 15_000;

interface NotifyOptions {
  readonly always?: boolean;
  readonly inChat?: boolean;
  readonly quiet?: boolean;
}

export class BotNotifications extends Context.Service<
  BotNotifications,
  {
    readonly stop: (
      threadId: ThreadId,
      key: string,
      reason: string,
    ) => Effect.Effect<void, Store.BotStoreError | Push.PushError>;
    /**
     * Posts `text` in the bot's chat, pushes it and marks the bot unread, unless a client is using
     * that chat: then it only becomes the row preview. `always` pushes regardless, for news that is
     * not an answer in the chat being read. `inChat`: the chat already shows it (the reply itself,
     * a card or a banner). `quiet`: no push.
     */
    readonly notify: (
      threadId: ThreadId,
      text: string,
      options?: NotifyOptions,
    ) => Effect.Effect<
      { delivered: number; failed: number; postedInChat: boolean },
      Store.BotStoreError | Push.PushError
    >;
    /** One client's report: `visible` means it is using the bot chat `threadId`, false that it left it. */
    readonly seen: (threadId: ThreadId, visible: boolean, client: string) => Effect.Effect<void>;
    readonly reply: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<void, Store.BotStoreError | Push.PushError | OrchestratorV2Error>;
    /**
     * Tells the user that a bot's chat or wake run failed, with the provider's error, once a day per bot.
     * Runs a cap or rate stop interrupts are covered by `stop`.
     */
    readonly failed: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<void, Store.BotStoreError | Push.PushError | OrchestratorV2Error>;
  }
>()("t3/bots/BotNotifications") {}
const make = Effect.gen(function* () {
  const bots = yield* Store.BotStore;
  const push = yield* Push.WebPush;
  const threads = yield* Threads.ThreadManagementService;
  // Client id -> the bot chat it last reported in use. A page has at most one open.
  const viewers = yield* Ref.make(new Map<string, { threadId: ThreadId; at: number }>());
  const viewed = (threadId: ThreadId) =>
    Effect.all([Ref.get(viewers), Clock.currentTimeMillis]).pipe(
      Effect.map(([map, now]) =>
        [...map.values()].some((v) => v.threadId === threadId && now - v.at < VIEWING_MS),
      ),
    );
  // Ids of posted notifications: the time alone repeats when one call posts several.
  const posts = yield* Ref.make(0);
  const post = Effect.fn("BotNotifications.post")(function* (botThreadId: ThreadId, text: string) {
    const id = `bots:notice:${botThreadId}:${yield* Clock.currentTimeMillis}:${yield* Ref.getAndUpdate(posts, (n) => n + 1)}`;
    return yield* threads
      .dispatch({
        type: "message.record",
        commandId: CommandId.make(id),
        threadId: botThreadId,
        messageId: MessageId.make(id),
        text,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Bot notification not posted in its chat", { botThreadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
  });
  const notify = Effect.fn("BotNotifications.notify")(function* (
    threadId: ThreadId,
    text: string,
    options?: NotifyOptions,
  ) {
    const owner = yield* bots.owner(threadId);
    const postedInChat =
      owner !== undefined && !options?.inChat && text.trim() !== ""
        ? yield* post(owner.threadId, text.trim())
        : false;
    if (!options?.always && owner && (yield* viewed(owner.threadId))) {
      yield* bots.preview(threadId, text);
      return { delivered: 0, failed: 0, postedInChat };
    }
    const sent = yield* bots.telegramTurn(threadId);
    const bot = yield* bots.notify(threadId, text);
    // BotStore carries unread state during a live run; the generic command needs a completed run.
    yield* threads
      .dispatch({
        type: "thread.mark-unread",
        threadId: bot.threadId,
        commandId: CommandId.make(`bots:notify:${bot.threadId}:${bot.notifiedAt}`),
      })
      .pipe(Effect.ignore({ log: true }));
    if (bot.muted || sent || options?.quiet) return { delivered: 0, failed: 0, postedInChat };
    const pushed = yield* push.send({
      title: bot.name,
      body: markdownPreview(text),
      threadId: bot.threadId,
      unreadCount: (yield* bots.list).filter((b) => b.unread).length,
    });
    return { ...pushed, postedInChat };
  });
  return BotNotifications.of({
    notify,
    seen: (threadId, visible, client) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(viewers, (map) => {
            const next = new Map([...map].filter(([, v]) => now - v.at < VIEWING_MS));
            if (visible) next.set(client, { threadId, at: now });
            else if (next.get(client)?.threadId === threadId) next.delete(client);
            return next;
          }),
        ),
      ),
    reply: Effect.fn("BotNotifications.reply")(function* (run) {
      const bot = yield* bots.get(run.threadId);
      if (!bot || run.status !== "completed" || !run.startedAt) return;
      if (isTelegramMessage(run.userMessageId)) return;
      if (
        bot.notifiedAt &&
        DateTime.isGreaterThanOrEqualTo(DateTime.makeUnsafe(bot.notifiedAt), run.startedAt)
      )
        return;
      const asked = (yield* threads.getThreadRecords(run.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      })).messages[0];
      // Wakes, other bots and server redirects are not the user waiting for an answer; a new bot's
      // example, started for them, is. Their replies still become the list preview, without a push.
      if (asked?.scheduledTaskId || isBotUpkeepMessage(run.userMessageId)) return;
      const waiting = asked?.createdBy === "user" || isBotExampleMessage(run.userMessageId);
      if (!waiting && asked?.createdBy !== "agent") return;
      const { messages, turnItems } = yield* threads.getThreadRecords(
        run.threadId,
        ["messages", "turnItems"],
        {
          messageRunIds: [run.id],
          messageRoles: ["assistant"],
          turnItemRunIds: [run.id],
          turnItemTypes: ["dynamic_tool"],
        },
      );
      const reacted = turnItems.some(
        (item) =>
          item.type === "dynamic_tool" &&
          item.status === "completed" &&
          item.toolName !== null &&
          resolveT3McpToolName(item.toolName) === "react",
      );
      const texts = messages.filter((m) => !m.streaming && m.text.trim());
      const answer = texts
        .filter(
          (m, index) =>
            !(emojiOnlyReply(m.text) && index === texts.length - 1) &&
            !(reacted && isReactionEcho(m.text)),
        )
        .at(-1)
        ?.text.trim();
      if (!answer || !(yield* bots.claimAlert(`reply:${run.id}`))) return;
      if (!waiting) return yield* bots.preview(run.threadId, answer).pipe(Effect.asVoid);
      yield* notify(run.threadId, answer, { inChat: true });
    }),
    failed: Effect.fn("BotNotifications.failed")(function* (run) {
      const bot = yield* bots.botFor(run.threadId);
      // Upkeep turns are hidden from the user; a failed one keeps the conversation as it was.
      if (!bot || run.status !== "failed" || isBotUpkeepMessage(run.userMessageId)) return;
      if ((yield* bots.list).find((b) => b.threadId === bot.threadId)?.stopped) return;
      if (!(yield* bots.claimAlert(`failed:${bot.threadId}`))) return;
      const error = (yield* threads.getThreadShell(run.threadId))?.lastError?.trim().split("\n")[0];
      yield* notify(
        (yield* bots.wake(run.threadId)) === undefined ? bot.threadId : run.threadId,
        `Run failed: ${error ? error.slice(0, 200) : "no error reported."}`,
        // The chat shows a chat run's error, and a failed wake posts its own notice there.
        { always: true, inChat: true },
      );
    }),
    stop: Effect.fn("BotNotifications.stop")(function* (threadId, key, reason) {
      const bot = yield* bots.owner(threadId);
      if (!bot || !(yield* bots.claimAlert(key))) return;
      yield* threads
        .stopDelegatedTasks({
          threadId: bot.threadId,
          commandId: CommandId.make(`bots:stop-workers:${key}`),
          reason,
        })
        .pipe(Effect.ignore({ log: true }));
      for (const id of yield* bots.family(bot.threadId)) {
        yield* threads
          .interruptThread({
            projectId: bot.projectId,
            threadId: id,
            commandId: CommandId.make(`bots:stop:${key}:${id}`),
            reason,
          })
          .pipe(Effect.ignore({ log: true }));
      }
      yield* bots.recordStop(bot.threadId, reason);
      // The chat's stop banner shows the reason.
      yield* notify(bot.threadId, reason, { always: true, inChat: true });
    }),
  });
});
export const layer = Layer.effect(BotNotifications, make);

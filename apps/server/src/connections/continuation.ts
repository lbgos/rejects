/** A request from the user's own message continues as theirs, so it may write; any other only reads. */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BotStore from "../bots/BotStore.ts";
import { wakeLanguageLine } from "../bots/instructions.ts";
import { type ChatLanguage, chatLanguageOf } from "../bots/language.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const CONTINUES_USER = "accounts:user:";
const CONTINUES_SERVER = "accounts:server:";

/** @public */
export const continuationText = (title: string, line: string, language: ChatLanguage) =>
  `[${title}] ${line}\nContinue that task now. Reply with the result for the user and send its gist with notify_user.\n${wakeLanguageLine(language)}`;

export const makeContinuations = Effect.gen(function* () {
  const bots = yield* BotStore.BotStore;
  const threads = yield* Threads.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;

  /** Unknown counts as no. */
  const startedByUser = Effect.fn("Continuations.startedByUser")(
    function* (scope: McpInvocationContext.McpInvocationScope, botThreadId: ThreadId) {
      const wake = scope.thread && (yield* bots.wake(scope.thread.threadId));
      if (wake) return wake.botThreadId === botThreadId && wake.taskId.startsWith(CONTINUES_USER);
      if (scope.thread?.threadId !== botThreadId) return false;
      const shell = yield* threads.getThreadShell(botThreadId);
      const runId = shell?.activeRunId;
      if (!runId) return false;
      const run = (yield* threads.getThreadRecords(botThreadId, ["runs"], { runIds: [runId] }))
        .runs[0];
      if (!run) return false;
      const message = (yield* threads.getThreadRecords(botThreadId, ["messages"], {
        messageIds: [run.userMessageId],
      })).messages[0];
      return message?.createdBy === "user" && message.scheduledTaskId === undefined;
    },
    Effect.orElseSucceed(() => false),
  );

  const startContinuation = Effect.fn("Continuations.startContinuation")(function* (input: {
    /** Stable per request, so a repeated Done starts one wake. */
    readonly id: string;
    readonly botThreadId: ThreadId;
    readonly title: string;
    readonly line: string;
    readonly writes: boolean;
  }) {
    const bot = yield* bots.get(input.botThreadId);
    if (bot === undefined) return;
    const threadId = ThreadId.make(`bot-wake:${input.id}`);
    yield* bots.startWake({
      threadId,
      botThreadId: bot.threadId,
      taskId: `${input.writes ? CONTINUES_USER : CONTINUES_SERVER}${input.id}`,
      title: input.title,
    });
    yield* threadLaunch.launch({
      commandId: CommandId.make(input.id),
      threadId,
      projectId: bot.projectId,
      title: `${bot.name}: ${input.title}`,
      modelSelection: bot.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make(input.id),
        text: continuationText(
          input.title,
          input.line,
          yield* chatLanguageOf(threads, bot.threadId),
        ),
        attachments: [],
      },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const continueTask = (input: Parameters<typeof startContinuation>[0]) =>
    startContinuation(input).pipe(Effect.ignore({ log: true }));

  return { startedByUser, startContinuation, continueTask };
});

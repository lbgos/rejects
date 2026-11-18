import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BotRecordings from "../../bots/BotRecordings.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as BotSecrets from "../../secrets/BotSecrets.ts";
import * as Invocation from "../McpInvocationContext.ts";

export interface BotActs {
  readonly scope: Invocation.McpInvocationScope;
  readonly bot: ThreadId;
  readonly redact: (text: string) => string;
  /** A redacted failure: an error text can quote what a page or command printed. */
  readonly fail: (message: string, code?: OrchestratorMcpFailure["code"]) => OrchestratorMcpFailure;
  readonly record: (
    step: Omit<BotRecordings.RecordedStep, "botThreadId" | "threadId" | "runId">,
  ) => Effect.Effect<void>;
}

export const botActs = Effect.fn("BotActs.make")(function* (toolkit: string) {
  const scope = yield* Invocation.requireThreadScope(
    yield* Invocation.McpInvocationContext,
    toolkit,
  );
  const bot = scope.botThreadId ?? scope.thread.threadId;
  const redact = yield* (yield* BotSecrets.BotSecrets).redactor(bot);
  const recordings = yield* BotRecordings.BotRecordings;
  const threads = yield* Threads.ThreadManagementService;
  const record: BotActs["record"] = (step) =>
    threads.getThreadShell(scope.thread.threadId).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((shell) =>
        recordings.record({
          ...step,
          detail: redact(step.detail),
          botThreadId: bot,
          threadId: scope.thread.threadId,
          runId: shell?.activeRunId ?? null,
        }),
      ),
    );
  return {
    scope,
    bot,
    redact,
    fail: (message, code = "orchestration_error") =>
      new OrchestratorMcpFailure({ code, message: redact(message) }),
    record,
  } satisfies BotActs;
});

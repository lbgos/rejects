import { type BotOwnSkill, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as BotStore from "../../../bots/BotStore.ts";
import { callLine } from "../../../bots/skillDreams.ts";
import {
  deleteOwnSkill,
  readSkill,
  writeOwnSkill,
  writeSkillRefusal,
} from "../../../bots/skills.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { BotSkillsToolkit, SKILL_SAVED_NEXT } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const asBot = Effect.fn("BotSkillsTools.asBot")(function* () {
  const scope = yield* Invocation.requireThreadScope(
    yield* Invocation.McpInvocationContext,
    "skills",
  );
  const store = yield* BotStore.BotStore;
  const bot = yield* store.owner(scope.botThreadId ?? scope.thread.threadId);
  if (!bot) return yield* invalid("Only bots have skills.");
  return { store, bot, allowed: scope.allowedToolNames, thread: scope.thread.threadId };
});

const LIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const currentRunCalls = Effect.fn("BotSkillsTools.currentRunCalls")(function* (threadId: ThreadId) {
  const threads = yield* Threads.ThreadManagementService;
  const { runs } = yield* threads
    .getThreadRecords(threadId, ["runs"])
    .pipe(Effect.orElseSucceed(() => ({ runs: [] })));
  const run = runs.findLast((entry) => LIVE_RUN.has(entry.status));
  if (!run) return { calls: [], earlierWrites: 0 };
  const { turnItems } = yield* threads
    .getThreadRecords(threadId, ["turnItems"], {
      turnItemRunId: run.id,
      turnItemTypes: ["dynamic_tool", "command_execution"],
    })
    .pipe(Effect.orElseSucceed(() => ({ turnItems: [] })));
  return {
    calls: turnItems.flatMap((item) => callLine(item) ?? []),
    earlierWrites: turnItems.filter(
      (item) => item.completedAt !== null && callLine(item)?.startsWith("write_skill"),
    ).length,
  };
});

const change = Effect.fn("BotSkillsTools.change")(function* (
  store: BotStore.BotStore["Service"],
  threadId: ThreadId,
  apply: (
    own: ReadonlyArray<BotOwnSkill>,
  ) =>
    | { readonly ok: true; readonly skills: ReadonlyArray<BotOwnSkill> }
    | { readonly ok: false; readonly error: string },
) {
  let failure: string | undefined;
  yield* store
    .edit(threadId, (bot) => {
      const result = apply(bot.ownSkills ?? []);
      if (!result.ok) {
        failure = result.error;
        return bot;
      }
      const { ownSkills: _previous, ...rest } = bot;
      return result.skills.length > 0 ? { ...rest, ownSkills: [...result.skills] } : rest;
    })
    .pipe(Effect.mapError((error) => invalid(error.message)));
  if (failure !== undefined) return yield* invalid(failure);
});

export const layer = Access.toLayer(BotSkillsToolkit, {
  read_skill: Access.reads(({ name }) =>
    Effect.gen(function* () {
      const { bot, allowed } = yield* asBot();
      const result = readSkill(name, (tool) => allowed?.has(tool) ?? false, bot.ownSkills);
      if (result.ok) return result.body;
      return yield* invalid(result.error);
    }),
  ),
  write_skill: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { store, bot, thread } = yield* asBot();
      const { calls, earlierWrites } = yield* currentRunCalls(thread);
      const refusal = writeSkillRefusal({
        body: input.body,
        calls,
        earlierWrites,
        existingBody: bot.ownSkills?.find((skill) => skill.name === input.name.trim().toLowerCase())
          ?.body,
      });
      if (refusal !== undefined) return yield* invalid(refusal);
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* change(store, bot.threadId, (own) => writeOwnSkill(own, input, at));
      return { saved: input.name, next: SKILL_SAVED_NEXT };
    }),
  ),
  delete_skill: Access.actsAsCaller(({ name }) =>
    Effect.gen(function* () {
      const { store, bot } = yield* asBot();
      yield* change(store, bot.threadId, (own) => deleteOwnSkill(own, name));
      return { deleted: name };
    }),
  ),
});

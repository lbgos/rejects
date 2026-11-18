import type { BotRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ConnectionStore } from "../connections/ConnectionStore.ts";
import { botToolNames, holdsWebTool } from "../mcp/BotTools.ts";
import type { BotStore } from "./BotStore.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";

/**
 * Why a bot runs sealed, or undefined. A sealed bot runs with its provider's own tools off, and
 * no other bot reads or messages its chat, so what it reads has no way out. Main keeps its tools
 * with a bridge grant: it edits and ships this app's code in its sandbox.
 */
export const sealedBy = Effect.fn("BotSealed.sealedBy")(function* (
  bot: Pick<BotRecord, "threadId" | "kind">,
  bots: Pick<BotStore["Service"], "bridged" | "mainBot">,
  connections: Option.Option<Pick<ConnectionStore["Service"], "held">>,
) {
  if ((yield* bots.bridged(bot.threadId)) && (yield* bots.mainBot) !== bot.threadId)
    return "bridge access";
  if (Option.isSome(connections) && (yield* connections.value.held(bot.threadId)))
    return "account access";
  if (bot.kind === "music") return "the music tools";
  return undefined;
});

/**
 * Whether bots other than Main read this bot's chat, and whether it reads theirs: never Main's,
 * which holds every request and file id, nor Thread Watch's, which quotes the user's threads;
 * otherwise only an unsealed bot that holds a web tool, since it could already send its own chat
 * out. A bot without one (paper work) neither leaks its files to readers nor reads web text.
 */
export const readableByPeers = Effect.fn("BotSealed.readableByPeers")(function* (
  bot: Pick<BotRecord, "threadId" | "kind" | "tools" | "skills" | "modelTemplate" | "ownSkills">,
  bots: Pick<BotStore["Service"], "bridged" | "mainBot">,
  connections: Option.Option<Pick<ConnectionStore["Service"], "held">>,
) {
  if (bot.threadId === STEWARD_THREAD_ID || (yield* bots.mainBot) === bot.threadId) return false;
  if ((yield* sealedBy(bot, bots, connections)) !== undefined) return false;
  // Unsealed and not Main: no bridge, account or music tools shape its set.
  const tools = botToolNames({
    kind: bot.kind,
    sealed: false,
    allowed: bot.tools,
    skills: bot.skills,
    modelTemplate: bot.modelTemplate,
    ownSkills: bot.ownSkills,
  });
  return holdsWebTool(tools);
});

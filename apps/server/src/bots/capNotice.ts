import { formatTokens, type BotSummary } from "@t3tools/contracts";

export const capNotice = (bot: Pick<BotSummary, "dailyTokenCap" | "tokensToday" | "usage">) => {
  const today = bot.usage[0];
  const top = today?.sources[0];
  const share = top && today.tokens > 0 ? Math.round((top.tokens / today.tokens) * 100) : 0;
  return `Daily token cap reached: ${formatTokens(bot.tokensToday)} of ${formatTokens(bot.dailyTokenCap)} in ${today?.turns ?? 0} turns${
    top ? `, mostly ${top.source} (${share}%)` : ""
  }. Stopped until tomorrow. Raise the cap in bot settings or ask Main.`;
};

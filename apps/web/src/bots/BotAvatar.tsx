import type { BotRecord } from "@t3tools/contracts";
import { cn } from "../lib/utils";
import { BOT_GLYPHS, botGlyph } from "./avatar";
import { BOT_ICONS } from "./botIcons";

export function BotAvatar({
  bot,
  className,
}: {
  bot: Pick<BotRecord, "name" | "kind" | "icon">;
  className?: string;
}) {
  const Glyph = bot.icon ? BOT_ICONS[bot.icon] : BOT_GLYPHS[botGlyph(bot.name, bot.kind)];
  return (
    <span
      aria-hidden
      data-bot-avatar
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-bot-bubble text-foreground ring-1 ring-foreground/8 ring-inset",
        className,
      )}
    >
      <Glyph strokeWidth={1.75} className="size-[46%]" />
    </span>
  );
}

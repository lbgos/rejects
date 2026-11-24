import { BOT_ICON_NAMES, type BotIconName, type BotRecord } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { BotAvatar } from "./BotAvatar";
import { BOT_ICONS } from "./botIcons";

export function BotIconPicker({
  bot,
  onChange,
}: {
  bot: Pick<BotRecord, "name" | "kind" | "icon">;
  onChange: (icon: BotIconName) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="bot-icon-grid"
        data-bot-icon-toggle
        className="flex items-center gap-3 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(!open)}
      >
        <BotAvatar bot={bot} className="size-10" />
        <span className="text-sm text-muted-foreground max-md:text-bot-callout">{t("Change")}</span>
        <ChevronDownIcon className={cn("size-4 text-muted-foreground", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          id="bot-icon-grid"
          role="group"
          className="grid grid-cols-8 gap-0.5 max-md:grid-cols-7"
        >
          {BOT_ICON_NAMES.map((name) => {
            const Glyph = BOT_ICONS[name];
            return (
              <button
                key={name}
                type="button"
                aria-label={name}
                aria-pressed={bot.icon === name}
                className="flex aspect-square items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-bot-fill hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-bot-fill aria-pressed:text-foreground"
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
              >
                <Glyph strokeWidth={1.75} className="size-5" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

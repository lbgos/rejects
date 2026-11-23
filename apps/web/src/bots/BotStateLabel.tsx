import { t, type UiText } from "../i18n";
import { cn } from "../lib/utils";
import type { BotState } from "./presentation";

const STATE_CLASS: Record<BotState, string> = {
  running: "text-info-foreground",
  waiting: "text-muted-foreground",
  capped: "text-warning-foreground",
  paused: "text-muted-foreground",
  idle: "text-muted-foreground",
  failed: "text-error-foreground",
};

const STATE_WORD: Record<BotState, UiText> = {
  running: "running",
  waiting: "waiting",
  capped: "capped",
  paused: "paused",
  idle: "idle",
  failed: "failed",
};

export function BotStateLabel({ state, className }: { state: BotState; className?: string }) {
  return (
    <span className={cn("text-xs", STATE_CLASS[state], className)}>{t(STATE_WORD[state])}</span>
  );
}

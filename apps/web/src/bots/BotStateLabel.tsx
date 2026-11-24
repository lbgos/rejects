import { t, type UiText } from "../i18n";
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

/** The state word, in the size of the line it sits in. */
export function BotStateLabel({ state }: { state: BotState }) {
  return <span className={STATE_CLASS[state]}>{t(STATE_WORD[state])}</span>;
}

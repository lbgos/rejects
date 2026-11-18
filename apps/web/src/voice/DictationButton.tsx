import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { DictationState } from "./dictation";
import { t } from "../i18n";

const STEPS = [0.008, 0.025, 0.06, 0.12];
const BAR_HEIGHTS = ["h-1", "h-2", "h-2.5", "h-3.5"];

/** While listening it shows a four-bar level that steps five times a second; nothing animates between steps. */
export function DictationButton({
  state,
  onToggle,
}: {
  readonly state: DictationState;
  readonly onToggle: () => void;
}) {
  const listening = state.status === "listening" ? state : null;
  const [tick, setTick] = useState({ startedAt: 0, seconds: 0, step: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the microphone's level and the clock while listening
  useEffect(() => {
    if (!listening) return;
    const read = () => {
      const seconds = Math.floor((Date.now() - listening.startedAt) / 1000);
      const level = listening.level();
      const step = STEPS.filter((threshold) => level >= threshold).length;
      setTick((previous) =>
        previous.startedAt === listening.startedAt &&
        previous.seconds === seconds &&
        previous.step === step
          ? previous
          : { startedAt: listening.startedAt, seconds, step },
      );
    };
    read();
    const timer = setInterval(read, 200);
    return () => clearInterval(timer);
  }, [listening]);
  const current =
    listening && tick.startedAt === listening.startedAt ? tick : { seconds: 0, step: 0 };
  const label = listening
    ? `${Math.floor(current.seconds / 60)}:${String(current.seconds % 60).padStart(2, "0")}`
    : state.status === "transcribing"
      ? t("Transcribing…")
      : null;
  return (
    <span
      data-chat-composer-dictation
      data-ui-target="dictation"
      className="flex shrink-0 items-center gap-1.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onToggle}
        disabled={state.status === "transcribing"}
        aria-label={listening ? t("Stop dictation") : t("Dictate")}
        aria-pressed={listening !== null}
      >
        {listening ? <SquareIcon className="fill-current" /> : <MicIcon />}
      </Button>
      {label ? (
        <span className="flex items-center gap-1.5">
          {listening ? (
            <span aria-hidden className="flex h-3.5 items-end gap-0.5">
              {BAR_HEIGHTS.map((height, index) => (
                <span
                  key={height}
                  className={cn(
                    "w-0.5 rounded-full",
                    height,
                    index < current.step ? "bg-foreground" : "bg-foreground/25",
                  )}
                />
              ))}
            </span>
          ) : null}
          <span role="status" className="text-xs text-muted-foreground tabular-nums">
            {label}
          </span>
        </span>
      ) : null}
    </span>
  );
}

import { WrenchIcon } from "lucide-react";
import { WorkingTimer } from "../components/chat/TimelineWorkGroupRows";
import { t } from "../i18n";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import { StatusSwap } from "./StatusSwap";

/** The dots pulse while on screen and the page is visible; the status line swaps once per change. */
export function BotTypingBubble({
  startedAt,
  status,
  activity,
}: {
  startedAt: string | null;
  status: string | null;
  activity: string | null;
}) {
  return (
    <div
      role="status"
      aria-label={t("Working")}
      data-bot-typing
      data-row-enter
      className="flex flex-col gap-2 pb-2 md:hidden"
    >
      <div
        ref={observeVisibleAnimation}
        data-bot-typing-dots
        className="flex w-fit items-center gap-1.25 rounded-3xl bg-bot-bubble px-3.75 py-3.25"
      >
        <span data-holiday-dot="warm" className="size-2 rounded-full bg-muted-foreground" />
        <span data-holiday-dot="berry" className="size-2 rounded-full bg-muted-foreground/70" />
        <span data-holiday-dot="fir" className="size-2 rounded-full bg-muted-foreground/45" />
      </div>
      {/* Rendered from the first frame so the footer grows once and the list follows it. */}
      <p className="flex items-center gap-1.5 ps-2 text-xs text-muted-foreground tabular-nums max-md:text-bot-callout">
        <WrenchIcon aria-hidden className="size-3.5 shrink-0" />
        {status ? (
          <>
            <span className="min-w-0 truncate">
              <StatusSwap text={status} />
            </span>
            {startedAt ? (
              <span className="shrink-0 opacity-75">
                · <WorkingTimer createdAt={startedAt} />
              </span>
            ) : null}
          </>
        ) : (
          <>
            {startedAt ? (
              <span className="shrink-0">
                {t("Working for")} <WorkingTimer createdAt={startedAt} />
              </span>
            ) : (
              <span className="shrink-0">{t("Working…")}</span>
            )}
            {activity ? (
              <>
                <span className="shrink-0 opacity-75">·</span>
                <span className="min-w-0 truncate opacity-75">
                  <StatusSwap text={activity} />
                </span>
              </>
            ) : null}
          </>
        )}
      </p>
    </div>
  );
}

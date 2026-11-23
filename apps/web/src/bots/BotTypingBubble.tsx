import { WorkingTimer } from "../components/chat/TimelineWorkGroupRows";
import { t } from "../i18n";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import { StatusSwap } from "./StatusSwap";

/**
 * A turn's one sign of work: the dots until there is something to name, then only the line that
 * names what the bot is doing. The dots pulse while on screen and the page is visible.
 */
export function BotTypingBubble({
  startedAt,
  status,
  activity,
  dots,
}: {
  startedAt: string | null;
  status: string | null;
  activity: string | null;
  dots: boolean;
}) {
  const doing = status ?? activity;
  return (
    <div
      role="status"
      aria-label={t("Working")}
      data-bot-typing
      data-row-enter
      className="flex flex-col gap-2 pb-2 md:hidden"
    >
      {dots && !doing ? (
        <div
          ref={observeVisibleAnimation}
          data-bot-typing-dots
          className="flex w-fit items-center gap-1.25 rounded-3xl bg-bot-bubble px-3.75 py-3.25"
        >
          <span data-holiday-dot="warm" className="size-2 rounded-full bg-muted-foreground" />
          <span data-holiday-dot="berry" className="size-2 rounded-full bg-muted-foreground/70" />
          <span data-holiday-dot="fir" className="size-2 rounded-full bg-muted-foreground/45" />
        </div>
      ) : (
        <p className="flex items-center gap-1.5 ps-2 text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
          <span className="min-w-0 truncate">
            {doing ? <StatusSwap text={doing} /> : t("Working")}
          </span>
          {startedAt ? (
            <span className="shrink-0">
              · <WorkingTimer createdAt={startedAt} />
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}

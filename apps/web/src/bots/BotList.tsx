import type { BotSummary, EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { markdownPreview } from "@t3tools/shared/markdownPreview";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { BellOffIcon } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { ThreadDraftIndicator } from "../components/sidebar/SidebarThreadRow";
import { Button } from "../components/ui/button";
import { useThreadHasUnsentDraft } from "../composerDraftStore";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { botActions, botSwipeActions, useBotActions, type BotActionId } from "./actions";
import { rememberBackPage } from "./backPage";
import { BotAvatar } from "./BotAvatar";
import { BotStateLabel } from "./BotStateLabel";
import { needsFirstRun } from "./firstRun.logic";
import { BOT_ACTION_ICONS } from "./icons";
import { PushPrompt } from "../push/PushPrompt";
import {
  botActivityAt,
  formatListTime,
  isFailureNotice,
  resolveBotState,
  searchBots,
  sortBotRows,
} from "./presentation";
import { useThreadSearch } from "../state/queries";
import { environmentCatalog } from "../connection/catalog";
import { useEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  fullSwipeAt,
  ROW_ACTION_PX,
  rubberBand,
  settleRow,
  swipeButtonWidths,
  type RowSide,
} from "./gestures";
import { refreshBots, useBots, useBotsListFailed, useBotsLoaded } from "./state";
import { placeGesture, useHorizontalDrag } from "./useHorizontalDrag";
import { useLongPress } from "./useLongPress";
import { usePullToRefresh } from "./usePullToRefresh";
import { openBotDialog } from "./ui";
import { useScheduledTasks } from "./useBotTasks";

const SWIPE_TINT: Partial<Record<BotActionId, string>> = {
  delete: "var(--color-bot-delete)",
  mute: "var(--color-bot-mute)",
  unmute: "var(--color-bot-mute)",
  "mark-read": "var(--color-bot-unread)",
  "mark-unread": "var(--color-bot-unread)",
};

const isFresh = (createdAt: string) => Date.now() - Date.parse(createdAt) < 3000;

const PULL_TICKS = Array.from({ length: 8 }, (_, i) => i);

/** The list's shape while the first load is on its way: still blocks where rows will be. */
const LOADING_ROWS = (
  <li role="status" aria-label={t("Loading…")} data-bot-list-loading>
    {[52, 68, 44, 60, 36].map((width) => (
      <div
        key={width}
        className="flex items-center gap-2.5 py-2 ps-4 pe-2 max-md:h-19 max-md:gap-3.25 max-md:py-0 max-md:ps-5 max-md:pe-5"
      >
        <span className="size-8 shrink-0 rounded-full bg-foreground/8 max-md:size-11" />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="h-3 w-24 rounded-full bg-foreground/10" />
          <span className="h-2.5 rounded-full bg-foreground/6" style={{ width: `${width}%` }} />
        </span>
      </div>
    ))}
  </li>
);

export function BotList({
  environmentId,
  selectedThreadId,
  query = "",
  className,
}: {
  environmentId: EnvironmentId;
  selectedThreadId?: string | null;
  query?: string;
  className?: string;
}) {
  const bots = useBots(environmentId);
  const loaded = useBotsLoaded(environmentId);
  const failed = useBotsListFailed(environmentId);
  const shells = useThreadShells();
  const tasks = useScheduledTasks(environmentId);
  const { run, showContextMenu } = useBotActions(environmentId);
  const navigate = useNavigate();
  const phone = useMediaQuery("max-md");
  const [openRow, setOpenRow] = useState<{ threadId: string; side: RowSide } | null>(null);
  const environment = useEnvironment(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const { list: pullList, indicator: pullIndicator } = usePullToRefresh(() => {
    if (environment && environment.connection.phase !== "connected")
      void retryEnvironment(environmentId);
    return refreshBots(environmentId);
  });
  const search = useThreadSearch([environmentId], query);
  const rows = sortBotRows(
    bots.map((bot) => {
      const shell = shells.find((t) => t.id === bot.threadId && t.environmentId === environmentId);
      // Shells carry no message bodies; the server keeps the last notification or reply as preview.
      const text = markdownPreview(bot.lastNotification ?? "");
      const at = botActivityAt(bot, shell?.source);
      const authoredAt = shell?.source.latestUserAuthoredMessageAt;
      const wroteSinceClear = authoredAt
        ? DateTime.toEpochMillis(authoredAt) >= Date.parse(bot.historyFrom ?? bot.createdAt)
        : false;
      const schedules = tasks.filter((t) => t.threadId === bot.threadId);
      const state = resolveBotState(
        shell ? resolveSidebarThreadStatus(shell) : "ready",
        bot,
        schedules,
      );
      return {
        bot,
        schedules,
        state,
        // The state word already says a run failed; the server's failure line is for the chat.
        text: state === "failed" && isFailureNotice(text) ? "" : text,
        at,
        empty: !text && !wroteSinceClear,
      };
    }),
  );
  const shown = searchBots(
    rows,
    query,
    search.matches.flatMap((m) => (m.environmentId === environmentId ? [m.threadId] : [])),
    // oxlint-disable-next-line react/purity -- recency ranking samples the clock per render, as T3's sidebar search does
    Date.now(),
  );
  const notice = (title: string, body?: string, action?: { label: string; run: () => void }) => (
    <li className="flex flex-col items-center gap-1 px-6 pt-16 text-center max-md:h-full max-md:justify-center max-md:pt-0 max-md:pb-24">
      <span className="text-sm font-medium max-md:text-bot-heading max-md:font-bold">{title}</span>
      {body ? (
        <span className="text-sm text-muted-foreground max-md:text-bot-callout">{body}</span>
      ) : null}
      {action ? (
        <Button className="mt-3" size="pill" variant="secondary" onClick={action.run}>
          {action.label}
        </Button>
      ) : null}
    </li>
  );
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {/* Clipped sideways only: the pull indicator rises above the frame into the opened gap. */}
      <div data-pull-frame className="relative min-h-0 flex-1 overflow-x-clip">
        <div
          ref={pullIndicator}
          data-pull-indicator
          data-state="pull"
          role="progressbar"
          aria-label={t("Refreshing")}
          style={{ opacity: "min(1, calc(var(--pull, 0) * 3))" }}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-11 items-center justify-center text-muted-foreground pointer-fine:hidden"
        >
          <svg
            data-pull-disc
            viewBox="0 0 24 24"
            width={32}
            height={32}
            className="rounded-full p-1.5"
            aria-hidden
          >
            <g data-pull-ticks>
              {PULL_TICKS.map((i) => (
                <rect
                  key={i}
                  x="11"
                  y="2"
                  width="2"
                  height="6"
                  rx="1"
                  fill="currentColor"
                  transform={`rotate(${i * 45} 12 12)`}
                  style={{ opacity: `clamp(0, calc(var(--pull, 0) * 8 - ${i}), 1)` }}
                />
              ))}
            </g>
          </svg>
        </div>
        <ul
          ref={pullList}
          data-bot-list
          data-ui-target={phone ? undefined : "bots"}
          aria-busy={!loaded}
          className="relative h-full overflow-y-auto overscroll-y-contain px-2 pb-2 max-md:px-0 max-md:pb-32 pointer-coarse:bg-background"
          onTouchStart={(event) => {
            if (
              openRow &&
              !(
                event.target instanceof Element &&
                event.target.closest(`[data-bot-row="${openRow.threadId}"]`)
              )
            )
              setOpenRow(null);
          }}
        >
          {shown.length > 0
            ? null
            : !loaded && failed
              ? notice(t("Can’t load bots"), t("The server did not answer."), {
                  label: t("Try again"),
                  run: () => void refreshBots(environmentId).catch(() => undefined),
                })
              : !loaded
                ? LOADING_ROWS
                : bots.length === 0
                  ? // Before setup has made the main bot, the main pane runs setup and the list waits.
                    needsFirstRun(bots) && !phone
                    ? null
                    : notice(t("No bots"), t("Bots you create show up here."), {
                        label: t("New bot"),
                        run: () => openBotDialog({ environmentId, threadId: null, focus: null }),
                      })
                  : notice(t("No results for “{query}”", { query: query.trim() }))}
          {shown.map((row) => (
            <li
              key={row.bot.threadId}
              className="group/row"
              data-row-enter={isFresh(row.bot.createdAt) || undefined}
            >
              <BotRow
                {...row}
                environmentId={environmentId}
                selected={selectedThreadId === row.bot.threadId}
                onOpen={() => {
                  rememberBackPage();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: row.bot.threadId },
                    viewTransition: phone ? { types: ["bots-push"] } : false,
                  });
                }}
                onMenu={(point) => void showContextMenu(row.bot, row.schedules, point)}
                onAction={(id) => void run(id, row.bot, row.schedules)}
                open={openRow?.threadId === row.bot.threadId ? openRow.side : null}
                setOpen={(side) => setOpenRow(side ? { threadId: row.bot.threadId, side } : null)}
              />
            </li>
          ))}
          {shown.length > 0 && !query.trim() ? <PushPrompt environmentId={environmentId} /> : null}
        </ul>
      </div>
    </div>
  );
}

/** Not an `<a href>`: a long press on a link opens Safari's link preview on iOS, so the row navigates on click and opens the bot menu on a hold or right-click. */
function BotRow({
  environmentId,
  bot,
  schedules,
  state,
  text,
  at,
  empty,
  selected,
  open,
  setOpen,
  onOpen,
  onMenu,
  onAction,
}: {
  environmentId: EnvironmentId;
  bot: BotSummary;
  schedules: Parameters<typeof botActions>[0]["schedules"];
  state: ReturnType<typeof resolveBotState>;
  text: string;
  at: number;
  empty: boolean;
  selected: boolean;
  open: RowSide | null;
  setOpen: (side: RowSide | null) => void;
  onOpen: () => void;
  onMenu: (point: { x: number; y: number }) => void;
  onAction: (id: BotActionId) => void;
}) {
  const actions = botActions({ bot, schedules, where: "row" });
  // As in the thread sidebar: the open chat shows its own draft in the composer.
  const hasUnsentDraft =
    useThreadHasUnsentDraft(scopeThreadRef(environmentId, bot.threadId)) && !selected;
  const rowRef = useRef<HTMLDivElement>(null);
  const { consumeClick, ...press } = useLongPress((point) => {
    const row = rowRef.current;
    if (!row || !window.matchMedia("(pointer: coarse)").matches) return onMenu(point);
    const rect = row.getBoundingClientRect();
    onMenu({ x: rect.left + 16, y: rect.bottom });
  });
  const { leading, trailing } = botSwipeActions(actions);
  const leadingWidth = leading.length * ROW_ACTION_PX;
  const trailingWidth = trailing.length * ROW_ACTION_PX;
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const rowWidth = () => rowRef.current?.offsetWidth ?? window.innerWidth;
  const base = open === "leading" ? leadingWidth : open === "trailing" ? -trailingWidth : 0;
  const offsetOf = (dx: number) =>
    rubberBand(base + dx, trailingWidth ? -rowWidth() : 0, leadingWidth ? rowWidth() : 0);
  const layout = (
    side: HTMLDivElement | null,
    revealed: number,
    width: number,
    settle: boolean,
  ) => {
    if (!side) return;
    const full = width > 0 && revealed >= fullSwipeAt(width, rowWidth());
    side.dataset.full = String(full);
    side.dataset.gestureSettle = String(settle);
    const widths = swipeButtonWidths(revealed, side.children.length, full);
    [...side.children].forEach((button, i) => {
      if (!(button instanceof HTMLElement)) return;
      button.style.width = `${widths[i] ?? 0}px`;
      // Too narrow for its label: only the icon shows, so neighbouring labels never collide.
      // The label width is read once; reading layout on every gesture frame would force reflows.
      const label = button.querySelector<HTMLElement>("[data-swipe-label]");
      if (label && label.dataset.width === undefined) {
        label.dataset.width = String(label.offsetWidth);
      }
      button.dataset.narrow = String((widths[i] ?? 0) < Number(label?.dataset.width ?? 60) + 6);
    });
  };
  // A touched row highlights after a beat, so a scroll that starts at once never flashes it.
  const pressTimer = useRef<number | undefined>(undefined);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const setPressed = (on: boolean) => {
    window.clearTimeout(pressTimer.current);
    const el = rowRef.current;
    if (!el) return;
    if (!on) delete el.dataset.pressed;
    else pressTimer.current = window.setTimeout(() => (el.dataset.pressed = "true"), 80);
  };
  const place = (offset: number, settle: boolean) => {
    const el = rowRef.current;
    if (!el) return;
    setPressed(false);
    placeGesture(el, offset ? `translateX(${offset}px)` : "", settle);
    layout(leadingRef.current, Math.max(offset, 0), leadingWidth, settle);
    layout(trailingRef.current, Math.max(-offset, 0), trailingWidth, settle);
  };
  const { consumeClick: consumeDrag, ...drag } = useHorizontalDrag({
    move: (dx) => place(offsetOf(dx), false),
    end: (dx, vx) => {
      const settled = settleRow({
        offset: offsetOf(dx),
        vx,
        leadingWidth,
        trailingWidth,
        rowWidth: rowWidth(),
      });
      const side =
        settled === "open-leading" ? "leading" : settled === "open-trailing" ? "trailing" : null;
      place(side === "leading" ? leadingWidth : side === "trailing" ? -trailingWidth : 0, true);
      setOpen(side);
      const edge =
        settled === "full-leading" ? leading[0] : settled === "full-trailing" ? trailing[0] : null;
      if (edge) onAction(edge.id);
    },
    cancel: () => place(base, true),
  });
  // React owns the resting position; a drag writes the elements' styles directly until release.
  const rest: CSSProperties = { transform: base ? `translateX(${base}px)` : undefined };
  const restWidth = (side: RowSide) => (open === side ? ROW_ACTION_PX : 0);
  const swipeButton = (action: (typeof trailing)[number], side: RowSide) => (
    <button
      key={action.id}
      type="button"
      tabIndex={open === side ? 0 : -1}
      data-swipe-action={action.id}
      onClick={() => {
        setOpen(null);
        onAction(action.id);
      }}
      style={{ width: restWidth(side), background: SWIPE_TINT[action.id] }}
      className="flex h-full shrink-0 cursor-pointer items-center justify-center overflow-hidden text-white outline-none select-none active:brightness-90"
    >
      <span
        className="flex shrink-0 flex-col items-center gap-1 text-sm font-medium"
        style={{ width: ROW_ACTION_PX }}
      >
        <SwipeGlyph icon={action.icon} />
        <span data-swipe-label className="in-data-[narrow=true]:invisible">
          {action.short}
        </span>
      </span>
    </button>
  );
  // On touch, bots.css rounds the clip; the actions have no width at rest, so no colour shows there.
  return (
    <div
      data-bot-row={bot.threadId}
      className="relative overflow-hidden rounded-(--control-radius)"
    >
      <div
        ref={leadingRef}
        aria-hidden={open !== "leading"}
        data-swipe-actions="leading"
        className="absolute inset-y-0 left-0 hidden pointer-coarse:flex"
      >
        {leading.map((action) => swipeButton(action, "leading"))}
      </div>
      <div
        ref={trailingRef}
        aria-hidden={open !== "trailing"}
        data-swipe-actions="trailing"
        className="absolute inset-y-0 right-0 hidden flex-row-reverse pointer-coarse:flex"
      >
        {trailing.map((action) => swipeButton(action, "trailing"))}
      </div>
      <div
        ref={rowRef}
        role="link"
        tabIndex={0}
        aria-current={selected ? "page" : undefined}
        {...press}
        {...drag}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          setPressed(true);
          press.onTouchStart(event);
        }}
        onTouchMove={(event) => {
          press.onTouchMove(event);
          // A scroll or pull that starts on the row cancels its highlight.
          const touch = event.touches[0];
          const start = touchStart.current;
          if (touch && start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 8)
            setPressed(false);
        }}
        onTouchEnd={(event) => {
          setPressed(false);
          press.onTouchEnd(event);
        }}
        onTouchCancel={() => {
          setPressed(false);
          press.onTouchCancel();
        }}
        style={rest}
        data-gesture-settle="true"
        onClick={() => {
          const held = consumeClick();
          const dragged = consumeDrag();
          if (held || dragged) return;
          if (open) return setOpen(null);
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") return onOpen();
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.left, y: rect.bottom });
        }}
        data-bot-row-content
        className="relative flex cursor-pointer touch-pan-y items-center gap-2.5 py-2 ps-4 pe-2 outline-none select-none [-webkit-touch-callout:none] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:bg-sidebar-row-selected max-md:h-19 max-md:gap-3.25 max-md:py-0 max-md:ps-5 max-md:pe-0 pointer-coarse:bg-background pointer-coarse:hover:bg-background pointer-coarse:data-[pressed=true]:bg-bot-fill"
      >
        {bot.unread ? (
          <span
            role="img"
            aria-label={t("Unread")}
            className="absolute start-1 top-1/2 size-2 -translate-y-1/2 rounded-full bg-bot-unread max-md:start-1.25 max-md:size-2.5"
          />
        ) : null}
        <BotAvatar bot={bot} className="size-8 max-md:size-11" />
        <span
          data-bot-row-text
          className="relative flex min-w-0 flex-1 flex-col justify-center self-stretch max-md:pe-4 max-md:after:absolute max-md:after:inset-x-0 max-md:after:bottom-0 max-md:after:h-px max-md:after:bg-bot-hairline max-md:group-last/row:after:hidden"
        >
          <span className="flex min-w-0 items-baseline gap-1">
            <span
              className={cn(
                "min-w-0 truncate text-sm max-md:text-bot-body",
                bot.unread ? "font-semibold" : "font-medium",
              )}
            >
              {bot.name}
            </span>
            {bot.muted ? (
              <BellOffIcon
                role="img"
                aria-label={t("Muted")}
                className="size-3.5 shrink-0 self-center text-muted-foreground max-md:size-4"
              />
            ) : null}
            {hasUnsentDraft ? <ThreadDraftIndicator threadId={bot.threadId} /> : null}
            <span className="ms-auto shrink-0 ps-2 text-xs text-muted-foreground tabular-nums max-md:text-bot-callout">
              {formatListTime(at)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground max-md:text-bot-callout">
            {state !== "idle" ? (
              <BotStateLabel state={state} className="max-md:text-bot-callout" />
            ) : null}
            <span className={cn("min-w-0 flex-1 truncate", bot.unread && "text-foreground")}>
              {empty ? t("No messages yet") : text}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

function SwipeGlyph({ icon }: { icon: string }) {
  const Glyph = BOT_ACTION_ICONS[icon];
  return Glyph ? <Glyph aria-hidden strokeWidth={2} className="size-5" /> : null;
}

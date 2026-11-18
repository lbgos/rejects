import {
  BOT_USAGE_CHAT,
  BOT_USAGE_OTHER,
  BOT_USAGE_WORKERS,
  isBotKickoffMessage,
  isBotUpkeepMessage,
  emojiOnlyReply,
  isReactionEcho,
  type BotSummary,
  type MemoryNote,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItemStatus,
  type ScheduledTaskRunStatus,
  type ScheduledTaskSchedule,
  ShowUiInput,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { SidebarThreadStatus } from "../components/Sidebar.logic";
import { t, uiLocales, type UiText } from "../i18n";
import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import type { TimelineEntry, WorkLogEntry } from "../session-logic";
import type { ChatMessage } from "../types";

export { formatTokens } from "@t3tools/contracts";

type BotStopState = Pick<BotSummary, "stopped" | "stopReason">;

export type BotState = "running" | "waiting" | "capped" | "paused" | "idle" | "failed";

/** `capped` is a daily-cap or hourly-limit stop (the interrupted run reads as failed, but it is not a failure). */
export function resolveBotState(
  status: SidebarThreadStatus,
  bot: BotStopState,
  schedules: ReadonlyArray<{ readonly enabled: boolean }> = [],
): BotState {
  if (bot.stopped) return "capped";
  if (status === "working") return "running";
  if (status === "waiting") return "waiting";
  // A stop reason from a cap that has since been raised leaves a stale failed runtime behind.
  if (status === "failed" && bot.stopReason === undefined) return "failed";
  if (schedules.length > 0 && !schedules.some((s) => s.enabled)) return "paused";
  return "idle";
}

/**
 * Hidden memory flushes and bridge wakes are user-role messages the server sends; they don't count.
 * A cleared chat starts at `historyFrom`: nothing before it counts, and the clear is its activity.
 */
export function botActivityAt(
  bot: Pick<BotSummary, "notifiedAt" | "previewAt" | "createdAt" | "historyFrom">,
  thread: Pick<OrchestrationV2ThreadShell, "latestUserAuthoredMessageAt"> | undefined,
): number {
  const authored = thread?.latestUserAuthoredMessageAt;
  const from = Date.parse(bot.historyFrom ?? bot.createdAt);
  // `previewAt` is when the shown text was set; a notification that predates it is not the text.
  const shown = bot.previewAt ?? bot.notifiedAt;
  return Math.max(
    authored ? DateTime.toEpochMillis(authored) : 0,
    shown ? Date.parse(shown) : 0,
    from,
  );
}

/**
 * Changes on every notification, muted ones included: a muted one sets only `previewAt`. The cards
 * a bot asks through (sign-in, secrets, mail, approvals) refetch on it.
 */
export const botNoticeKey = (bot: Pick<BotSummary, "notifiedAt" | "previewAt">) =>
  bot.previewAt ?? bot.notifiedAt ?? "";

export function sortBotRows<
  T extends { readonly bot: Pick<BotSummary, "main">; readonly at: number },
>(rows: ReadonlyArray<T>): T[] {
  return rows.toSorted(
    (a, b) => Number(b.bot.main === true) - Number(a.bot.main === true) || b.at - a.at,
  );
}

export function searchBots<
  T extends {
    readonly bot: Pick<BotSummary, "name" | "description"> & { readonly threadId: string };
    readonly at: number;
  },
>(
  rows: ReadonlyArray<T>,
  query: string,
  messageThreadIds: ReadonlyArray<string>,
  now: number,
): T[] {
  const normalizedQuery = foldSearchQuery(query);
  if (normalizedQuery.length === 0) return [...rows];
  const listed = new Set(
    rankSearchItems(rows, ({ bot, at }, options) =>
      scoreThreadSearch(
        normalizedQuery,
        { title: bot.name, projectTitle: bot.description ?? null, activityAt: at || null },
        now,
        { ...options, picks: false },
      ),
    ).map(({ item }) => item),
  );
  const byThread = new Map(rows.map((row) => [row.bot.threadId, row]));
  for (const threadId of messageThreadIds) {
    const row = byThread.get(threadId);
    if (row) listed.add(row);
  }
  return [...listed];
}

export function parseTokenCap(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text.trim().replaceAll(/[,_\s]/g, ""));
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const tokens = Math.round(
    Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1),
  );
  return Number.isSafeInteger(tokens) && tokens >= 1 ? tokens : null;
}

const DAY_MS = 86_400_000;
const startOfDay = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(uiLocales, { hour: "2-digit", minute: "2-digit", hour12: false });

export function formatWakeIn(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (at - now < 60_000) return t("<1m");
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60) return t("{minutes}m", { minutes });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  return days <= 1
    ? clock(at)
    : `${new Date(at).toLocaleDateString(uiLocales, { weekday: "short" })} ${clock(at)}`;
}

export function botScheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return t("On webhook");
  if (schedule.type === "once")
    return t("Once at {time}", { time: new Date(schedule.runAt).toLocaleString(uiLocales) });
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? t("Every {minutes} min", { minutes })
      : t("Every {seconds} sec", { seconds: Math.round(schedule.everyMs / 1000) });
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? t("Daily")
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? t("Weekdays")
        : weekdays
            // 2023-01-01 was a Sunday, day 0.
            .map((day) =>
              new Date(Date.UTC(2023, 0, 1 + day)).toLocaleDateString(uiLocales, {
                weekday: "short",
                timeZone: "UTC",
              }),
            )
            .join(", ");
  return t("{days} at {time}", { days, time: schedule.timeOfDay });
}

type ShownStatus =
  | OrchestrationV2RunStatus
  | OrchestrationV2TurnItemStatus
  | ScheduledTaskRunStatus;

const STATUS_WORD: Record<ShownStatus, UiText> = {
  preparing: "preparing",
  queued: "queued",
  starting: "starting",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "rolled back",
  idle: "idle",
  pending: "pending",
  never: "never",
  succeeded: "succeeded",
};

export const statusWord = (status: ShownStatus) => t(STATUS_WORD[status]);

export function formatResume(resumesAt: string | null | undefined, fallback: string): string {
  const at = resumesAt ? Date.parse(resumesAt) : Number.NaN;
  return Number.isFinite(at) ? t("at {time}", { time: clock(at) }) : fallback;
}

export function formatListTime(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return clock(at);
  if (days === 1) return t("Yesterday");
  if (days < 7) return new Date(at).toLocaleDateString(uiLocales, { weekday: "short" });
  return new Date(at).toLocaleDateString(uiLocales, { day: "numeric", month: "short" });
}

export function messageTimeLabel(at: number, now = Date.now()): string {
  return startOfDay(at) === startOfDay(now)
    ? t("Today {time}", { time: clock(at) })
    : `${formatListTime(at, now)} ${clock(at)}`;
}

const SEPARATOR_GAP_MS = 30 * 60_000;

export function timeSeparatorLabels(
  items: ReadonlyArray<{ readonly id: string; readonly at: number }>,
  now = Date.now(),
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let previous: number | null = null;
  for (const { id, at } of items) {
    if (!Number.isFinite(at)) continue;
    if (
      previous === null ||
      at - previous >= SEPARATOR_GAP_MS ||
      startOfDay(at) !== startOfDay(previous)
    ) {
      labels.set(id, messageTimeLabel(at, now));
    }
    previous = at;
  }
  return labels;
}

const QUOTE_MAX = 280;

export function quoteReply(quoted: string, text: string): string {
  const body = quoted.trim();
  const cut = body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX - 1).trimEnd()}…` : body;
  const quote = cut
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${quote}\n\n${text}`;
}

const entryRunId = (entry: TimelineEntry) => {
  switch (entry.kind) {
    case "message":
      return entry.message.runId ?? null;
    case "proposed-plan":
      return entry.proposedPlan.runId;
    case "html-render":
    case "mcp-app":
    case "sent-message":
      return entry.runId;
    case "work":
      return entry.entry.runId ?? null;
    case "event":
      return entry.projectedItem.item.runId;
  }
};

const freshSpan = () => ({
  reacted: false,
  answered: false,
  work: [] as string[],
  emoji: undefined as { id: string } | undefined,
});

export function visibleBotEntries(
  entries: ReadonlyArray<TimelineEntry>,
  historyFrom: string | undefined,
): ReadonlyArray<TimelineEntry> {
  const upkeepRuns = new Set(
    entries.flatMap((entry) =>
      entry.kind === "message" && entry.message.runId && isBotUpkeepMessage(entry.message.id)
        ? [entry.message.runId]
        : [],
    ),
  );
  const echoes = new Set<string>();
  const quiet = new Set<string>();
  let span = freshSpan();
  const close = () => {
    if (span.emoji) echoes.add(span.emoji.id);
    if ((span.reacted || span.emoji) && !span.answered) for (const id of span.work) quiet.add(id);
  };
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      close();
      span = freshSpan();
      continue;
    }
    if (isCompletedCall(entry, "react")) span.reacted = true;
    else if (span.reacted && entry.kind === "message" && isReactionEcho(entry.message.text))
      echoes.add(entry.id);
    else if (entry.kind === "message" || (entry.kind === "work" && entry.entry.tone === "tool")) {
      const emoji =
        entry.kind === "message" && !entry.message.streaming && emojiOnlyReply(entry.message.text);
      // Only the turn's last message can be the emoji reply.
      span.emoji = emoji ? { id: entry.id } : undefined;
      if (!emoji) span.answered = true;
    }
    if (entry.kind === "work" && entry.entry.tone !== "error") span.work.push(entry.id);
  }
  close();
  return entries.filter((entry) => {
    const runId = entryRunId(entry);
    return (
      !(runId !== null && upkeepRuns.has(runId)) &&
      !(entry.kind === "message" && isBotKickoffMessage(entry.message.id)) &&
      !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction") &&
      (historyFrom === undefined || entry.createdAt >= historyFrom) &&
      !(entry.kind === "event" && entry.projectedItem.item.type === "handoff") &&
      !isCallOf(entry, "react") &&
      !echoes.has(entry.id) &&
      !quiet.has(entry.id)
    );
  });
}

export function noteMeta(note: MemoryNote, now = Date.now()): string {
  const status =
    note.status === "fresh"
      ? []
      : [
          `${note.status === "stale" ? t("Stale") : t("Contradicted")}${note.reason ? `: ${note.reason}` : ""}`,
        ];
  const by = note.source.by === "user" ? t("You") : note.source.by;
  const quote = note.source.quote ? [`“${note.source.quote}”`] : [];
  const until = note.until ? [t("until {date}", { date: note.until })] : [];
  const removed = note.retiredAt
    ? [t("removed {time}", { time: formatListTime(Date.parse(note.retiredAt), now) })]
    : [];
  return [
    ...removed,
    ...status,
    by,
    formatListTime(Date.parse(note.source.at), now),
    ...until,
    ...quote,
  ].join(" · ");
}

const isReplies = Schema.is(Schema.Struct({ replies: Schema.Array(Schema.String) }));
const isProposal = Schema.is(Schema.Struct({ proposalId: Schema.String }));
const isHandOff = Schema.is(Schema.Struct({ bot: Schema.String, draft: Schema.String }));

const isCallOf = (entry: TimelineEntry, name: string) => {
  const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
  return (
    item?.type === "dynamic_tool" && !!item.toolName && resolveT3McpToolName(item.toolName) === name
  );
};

const isCompletedCall = (entry: TimelineEntry, name: string) => {
  if (!isCallOf(entry, name)) return false;
  const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
  return item?.type === "dynamic_tool" && item.status === "completed";
};

const completedCall = (entry: TimelineEntry, name: string, part: "input" | "output" = "input") => {
  if (entry.kind !== "work" || !isCallOf(entry, name)) return null;
  const item = entry.entry.structuredPayload;
  return item?.type === "dynamic_tool" && item.status === "completed" ? item[part] : null;
};

const isReaction = Schema.is(Schema.Struct({ emoji: Schema.String }));

export function botReactions(entries: ReadonlyArray<TimelineEntry>): ReadonlyMap<string, string> {
  const reactions = new Map<string, string>();
  const replies = new Map<string, string | undefined>();
  let userMessageId: string | null = null;
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") userMessageId = entry.message.id;
    else if (userMessageId !== null && entry.kind === "message")
      replies.set(
        userMessageId,
        entry.message.streaming ? undefined : emojiOnlyReply(entry.message.text),
      );
    const reacted = completedCall(entry, "react");
    if (userMessageId !== null && isReaction(reacted)) reactions.set(userMessageId, reacted.emoji);
  }
  for (const [id, emoji] of replies) if (emoji && !reactions.has(id)) reactions.set(id, emoji);
  return reactions;
}

export const BOT_OFFER_TTL_MS = 30 * 60_000;

/** Buttons also end at a message from another run or `BOT_OFFER_TTL_MS` after the call; `expiresAt` is when the shown ones end. */
export function botTurnOffers(
  entries: ReadonlyArray<TimelineEntry>,
  now: number,
): {
  readonly replies: ReadonlyArray<string>;
  readonly proposal: string | null;
  readonly handOff: { readonly bot: string; readonly draft: string } | null;
  readonly expiresAt: number | null;
} {
  let replies: ReadonlyArray<string> = [];
  let proposal: string | null = null;
  let handOff: { bot: string; draft: string } | null = null;
  let expiresAt: number | null = null;
  const laterRuns: Array<ReturnType<typeof entryRunId>> = [];
  for (const entry of entries.toReversed()) {
    if (entry.kind === "message" && entry.message.role === "user") break;
    if (entry.kind === "message") laterRuns.push(entryRunId(entry));
    if (replies.length === 0 && proposal === null) {
      const runId = entryRunId(entry);
      const offeredAt = Date.parse(entry.createdAt);
      const live =
        !laterRuns.some((later) => later !== runId) && now < offeredAt + BOT_OFFER_TTL_MS;
      const offered = completedCall(entry, "offer_replies");
      if (isReplies(offered) && live) {
        replies = offered.replies;
        expiresAt = offeredAt + BOT_OFFER_TTL_MS;
      }
      const proposed = completedCall(entry, "propose_bots", "output");
      if (isProposal(proposed) && live) {
        proposal = proposed.proposalId;
        expiresAt = offeredAt + BOT_OFFER_TTL_MS;
      }
    }
    const handed = completedCall(entry, "hand_off");
    if (!handOff && isHandOff(handed)) handOff = { bot: handed.bot, draft: handed.draft };
  }
  return { replies, proposal, handOff, expiresAt };
}

const isShowUi = Schema.is(ShowUiInput);

/**
 * The places the bot pointed at with `show_ui` since the user last wrote, oldest first, each
 * keyed by its call, while `BOT_OFFER_TTL_MS` lasts.
 */
export function botUiTips(
  entries: ReadonlyArray<TimelineEntry>,
  now: number,
): ReadonlyArray<ShowUiInput & { readonly id: string }> {
  const tips: Array<ShowUiInput & { readonly id: string }> = [];
  for (const entry of entries.toReversed()) {
    if (entry.kind === "message" && entry.message.role === "user") break;
    const input = completedCall(entry, "show_ui");
    if (isShowUi(input) && now < Date.parse(entry.createdAt) + BOT_OFFER_TTL_MS)
      tips.unshift({ id: entry.id, target: input.target, text: input.text });
  }
  return tips;
}

const isStatus = Schema.is(Schema.Struct({ text: Schema.String }));

export function botStatusLine(entries: ReadonlyArray<TimelineEntry>): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "message" && entry.message.role === "user") return null;
    const item =
      entry.kind === "work" && isCompletedCall(entry, "status")
        ? entry.entry.structuredPayload
        : undefined;
    if (item?.type === "dynamic_tool" && isStatus(item.input)) return item.input.text;
  }
  return null;
}

type BotTypingRow =
  | { readonly kind: "message"; readonly message: Pick<ChatMessage, "role"> }
  | { readonly kind: Exclude<MessagesTimelineRow["kind"], "message"> };

/**
 * The typing bubble's rule: the bot works and its newest row is not answer text, streaming or
 * finished while the run settles. The working row and the trailing "Thinking" placeholder only
 * mark that a turn runs.
 */
export function botAwaitsAnswer(rows: ReadonlyArray<BotTypingRow>): boolean {
  if (!rows.some((row) => row.kind === "working")) return false;
  const last = rows.findLast((row) => row.kind !== "working" && row.kind !== "thinking");
  return !(last?.kind === "message" && last.message.role === "assistant");
}

export interface StatusSwapState {
  readonly text: string;
  /** The line sliding out, if the line has changed since mount. */
  readonly leaving: string | null;
  readonly swaps: number;
}

/**
 * A new line replaces the shown one and becomes the only leaving line, so rapid changes never
 * queue. Text that grows or shrinks from the same start is the same line, updated in place.
 */
export function swapStatus(state: StatusSwapState, text: string): StatusSwapState {
  if (text === state.text) return state;
  if (text.startsWith(state.text) || state.text.startsWith(text)) return { ...state, text };
  return { text, leaving: state.text, swaps: state.swaps + 1 };
}

const ACTIVITY_ARG_MAX = 48;

export function botToolActivity(entry: Pick<WorkLogEntry, "label" | "structuredPayload">): string {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool" || !item.toolName) return entry.label;
  const name = resolveT3McpToolName(item.toolName) ?? item.toolName;
  const input: unknown = item.input;
  const first =
    typeof input === "object" && input !== null
      ? Object.values(input).find((value) => typeof value === "string")
      : undefined;
  const arg = (first ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!arg) return name;
  return `${name} ${arg.length > ACTIVITY_ARG_MAX ? `${arg.slice(0, ACTIVITY_ARG_MAX - 1)}…` : arg}`;
}

const LINK_PREVIEWS = 2;

export function messageLinks(text: string): ReadonlyArray<string> {
  const links: Array<string> = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    const link = match[0].replace(/[.,;:!?]+$/, "");
    if (!links.includes(link)) links.push(link);
    if (links.length === LINK_PREVIEWS) break;
  }
  return links;
}

export function usageSourceLabel(source: string): string {
  return source === BOT_USAGE_CHAT
    ? t("Chat")
    : source === BOT_USAGE_WORKERS
      ? t("Workers")
      : source === BOT_USAGE_OTHER
        ? t("Other")
        : source;
}

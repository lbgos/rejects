import {
  isBotKeepWarmMessage,
  isBotUpkeepMessage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isAnthropicModel } from "@t3tools/shared/claudeCompaction";
import * as DateTime from "effect/DateTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * `atTokens`: compact once the context reaches it, capped at NEAR_CAP of the window the provider reports; null means near the cap only.
 * `beforeExpiry`: also compact an idle chat shortly before its prompt cache expires, for models whose cold reads cost full price. First match wins.
 */
const COMPACTION: ReadonlyArray<{
  readonly matches: (model: string) => boolean;
  readonly atTokens: number | null;
  readonly beforeExpiry: boolean;
}> = [
  // Reads cost 2% and the cache lives hours to days, through Claude Code too, which tags 5m.
  // 882k input cap; compacts at 400k by choice.
  { matches: (model) => /deepseek/i.test(model), atTokens: 400_000, beforeExpiry: false },
  // 98k input cap on our routes.
  { matches: (model) => /glm/i.test(model), atTokens: 90_000, beforeExpiry: false },
  // Reads cost 5%; a miss is cheaper than a rewrite. 90% of the 272k cap.
  { matches: (model) => /gpt|codex/i.test(model), atTokens: 245_000, beforeExpiry: false },
  { matches: isAnthropicModel, atTokens: 400_000, beforeExpiry: true },
];
const UNKNOWN_MODEL = { atTokens: null, beforeExpiry: false };
const NEAR_CAP = 0.9;
const LEAD_OF_TTL = 1 / 12;
const MIN_WARM_OF_TTL = 1 / 60;
const MAX_NUDGES = 3;
/** A nudge that read less than this share of its input from the cache rewrote it; stop nudging. */
const NUDGE_MIN_HIT = 0.5;
/** Below this context a cold read after expiry costs little, so an idle chat is not compacted. */
const IDLE_COMPACT_MIN_TOKENS = 100_000;

const terminal = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "interrupted" ||
  run.status === "cancelled" ||
  run.status === "rolled_back";

export type ContextStep =
  | { readonly type: "wait"; readonly untilMs: number }
  | { readonly type: "compact"; readonly runId: OrchestrationV2Run["id"] }
  /** Keep-warm turn `nudge` (1-based) of the idle spell after run `runId`. */
  | { readonly type: "nudge"; readonly runId: OrchestrationV2Run["id"]; readonly nudge: number };

/**
 * An idle Claude chat is nudged shortly before its cache expires, up to MAX_NUDGES times, then compacted at the next window from 100k up; a dead cache gets neither.
 * Times come from persisted runs and cache reports, so a restart recomputes them.
 */
export function nextContextStep(
  records: {
    readonly thread: {
      readonly activeProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
    };
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly runtimeRequests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>;
    readonly providerTurns: ReadonlyArray<
      Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">
    >;
  },
  nowMs: number,
  canNudge = true,
): ContextStep | null {
  if (records.runs.some((run) => !terminal(run))) return null;
  if (records.runtimeRequests.some((request) => request.status === "pending")) return null;
  const byOrdinal = records.runs.toSorted((left, right) => left.ordinal - right.ordinal);
  const latest = byOrdinal.at(-1);
  // The idle spell starts at the chat's last own turn; upkeep turns after it belong to the spell.
  const anchor = byOrdinal.findLast((run) => !isBotUpkeepMessage(run.userMessageId));
  if (
    latest === undefined ||
    anchor === undefined ||
    anchor.providerThreadId === null ||
    anchor.providerThreadId !== records.thread.activeProviderThreadId ||
    anchor.status !== "completed" ||
    latest.completedAt === null
  )
    return null;
  const spell = byOrdinal.filter((run) => run.ordinal > anchor.ordinal);
  // One compaction per idle spell: never compact a compaction.
  if (spell.some((run) => !isBotKeepWarmMessage(run.userMessageId))) return null;
  const usages = records.providerTurns
    .filter((turn) => turn.providerThreadId === anchor.providerThreadId)
    .flatMap((turn) => (turn.tokenUsage === undefined ? [] : [turn.tokenUsage]))
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const usage = usages[0];
  if (usage === undefined) return null;
  const policy =
    COMPACTION.find((family) => family.matches(anchor.modelSelection.model)) ?? UNKNOWN_MODEL;
  const nearCap = usage.maxTokens == null ? Infinity : NEAR_CAP * usage.maxTokens;
  const full = usage.usedTokens >= Math.min(policy.atTokens ?? Infinity, nearCap);
  const compact = { type: "compact", runId: anchor.id } as const;
  if (!policy.beforeExpiry) return full ? compact : null;
  // The cache lives from the last request, a keep-warm turn's included, for that request's TTL.
  const ttlMs =
    usages.find((candidate) => candidate.promptCacheTtlMs !== undefined)?.promptCacheTtlMs ?? HOUR;
  const reportedEnd = Date.parse(usage.promptCacheExpiresAt ?? "");
  const endMs = Number.isFinite(reportedEnd)
    ? reportedEnd
    : DateTime.toEpochMillis(latest.completedAt) + ttlMs;
  if (nowMs > endMs - ttlMs * MIN_WARM_OF_TTL) return null;
  if (full) return compact;
  const missed =
    isBotKeepWarmMessage(latest.userMessageId) &&
    (usage.cachedInputTokens ?? 0) < NUDGE_MIN_HIT * (usage.inputTokens ?? 0);
  // A 5m cache would need a nudge every 4.6 min; only a 1h cache is worth keeping warm.
  const nudging =
    canNudge &&
    ttlMs === HOUR &&
    spell.length < MAX_NUDGES &&
    spell.every((run) => run.status === "completed") &&
    !missed;
  if (!nudging && usage.usedTokens < IDLE_COMPACT_MIN_TOKENS) return null;
  const dueMs = endMs - ttlMs * LEAD_OF_TTL;
  if (nowMs < dueMs) return { type: "wait", untilMs: dueMs };
  return nudging ? { type: "nudge", runId: anchor.id, nudge: spell.length + 1 } : compact;
}

const WAKE_SUMMARY_CHARS = 300;
const RESULT_MESSAGE_CHARS = 4000;
const RECAP_MESSAGES = 12;
const RECAP_MESSAGE_CHARS = 600;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const REACTED_MESSAGE_CHARS = 120;

export function reactedMessages(input: {
  readonly reactions: Readonly<Record<string, string>> | undefined;
  readonly messages: ReadonlyArray<Message>;
  readonly historyFromMs?: number | undefined;
  readonly max: number;
}): ReadonlyArray<{ readonly emoji: string; readonly text: string }> {
  const byId = new Map<string, Message>(input.messages.map((m) => [m.id, m]));
  return Object.entries(input.reactions ?? {})
    .flatMap(([messageId, emoji]) => {
      const message = byId.get(messageId);
      return message?.role === "assistant" &&
        message.text.trim() &&
        DateTime.toEpochMillis(message.createdAt) >= (input.historyFromMs ?? 0)
        ? [{ emoji, text: cut(message.text.trim(), REACTED_MESSAGE_CHARS) }]
        : [];
    })
    .slice(-input.max);
}

/** Calls that hand the answer to the user. */
const DELIVERY_TOOLS = new Set(["notify_user", "send_telegram"]);
const TEXT_ITEMS = new Set<OrchestrationV2TurnItem["type"]>([
  "assistant_message",
  "reasoning",
  "user_message",
  "checkpoint",
  "notification",
  "compaction",
  "error",
]);

/** The text a delivery call carried, such as notify_user's `text`. */
const sentText = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "text" in input &&
  typeof input.text === "string" &&
  input.text.trim()
    ? input.text.trim()
    : undefined;

/**
 * A wake's one answer. Without a send, the text after its last call. With sends, the longest of
 * every text block it wrote and its pushed texts joined in order: a digest wins over narration,
 * a short push and a closing "sent" line. Empty when nothing qualifies.
 */
export function wakeAnswer(
  items: ReadonlyArray<{
    readonly ordinal: number;
    readonly type: OrchestrationV2TurnItem["type"];
    readonly toolName?: string | null;
    readonly messageId?: string;
    readonly input?: unknown;
  }>,
  messages: ReadonlyArray<Pick<Message, "id" | "role" | "text" | "streaming">>,
): string {
  const texts = new Map<string, string>(
    messages
      .filter((m) => m.role === "assistant" && !m.streaming && m.text.trim())
      .map((m) => [m.id, m.text.trim()]),
  );
  const blocks: string[] = [];
  const pushed: string[] = [];
  let sends = 0;
  let block: string[] = [];
  const close = () => {
    if (block.length > 0) blocks.push(block.join("\n\n"));
    block = [];
  };
  for (const item of [...items].sort((a, b) => a.ordinal - b.ordinal)) {
    const text = item.type === "assistant_message" ? texts.get(item.messageId ?? "") : undefined;
    if (text !== undefined) block.push(text);
    else if (DELIVERY_TOOLS.has((item.toolName ?? "").replace(/^.*__/, ""))) {
      close();
      sends += 1;
      const sent = sentText(item.input);
      // The same text sent twice (a push beside Telegram) is one notification.
      if (sent !== undefined && !pushed.includes(sent)) pushed.push(sent);
    } else if (!TEXT_ITEMS.has(item.type)) close();
  }
  if (sends === 0) return block.join("\n\n");
  close();
  return [...blocks, pushed.join("\n\n")].reduce(
    (longest, answer) => (answer.length > longest.length ? answer : longest),
    "",
  );
}

/** A wake's reply as its chat message. Briefings post whole digests, so only a cap applies. */
export const wakeResultMessage = (reply: string) => cut(reply.trim(), RESULT_MESSAGE_CHARS);

export const wakeSummary = (reply: string) =>
  cut(
    reply
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / "),
    WAKE_SUMMARY_CHARS,
  );

type Message = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "runId" | "role" | "text" | "streaming" | "createdAt"
>;

/** Flush runs and messages before `historyFrom` never count. */
export function unseenMessages(input: {
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "providerThreadId" | "userMessageId" | "requestedAt"
    >
  >;
  readonly messages: ReadonlyArray<Message>;
  readonly run: Pick<OrchestrationV2Run, "id" | "ordinal" | "requestedAt">;
  readonly providerThreadId: OrchestrationV2ProviderThread["id"];
  readonly historyFromMs?: number | undefined;
}): ReadonlyArray<{ readonly role: "user" | "you"; readonly at: string; readonly text: string }> {
  const startMs = DateTime.toEpochMillis(input.run.requestedAt);
  const previous = input.runs
    .filter(
      (r) =>
        r.providerThreadId === input.providerThreadId &&
        r.ordinal < input.run.ordinal &&
        !isBotUpkeepMessage(r.userMessageId),
    )
    .reduce<(typeof input.runs)[number] | undefined>(
      (found, r) => (found === undefined || r.ordinal > found.ordinal ? r : found),
      undefined,
    );
  const sinceMs = previous
    ? DateTime.toEpochMillis(previous.requestedAt)
    : (input.historyFromMs ?? 0);
  const upkeepRuns = new Set(
    input.runs.filter((r) => isBotUpkeepMessage(r.userMessageId)).map((r) => r.id),
  );
  const seenRuns = new Set(
    input.runs.filter((r) => r.providerThreadId === input.providerThreadId).map((r) => r.id),
  );
  return input.messages
    .filter((m) => {
      const atMs = DateTime.toEpochMillis(m.createdAt);
      if (m.streaming || !m.text.trim() || m.role === "system") return false;
      if (atMs < sinceMs || atMs >= startMs || atMs < (input.historyFromMs ?? 0)) return false;
      if (m.runId !== null && (upkeepRuns.has(m.runId) || seenRuns.has(m.runId))) return false;
      return previous === undefined || m.runId === null;
    })
    .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
    .slice(-RECAP_MESSAGES)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("you" as const),
      at: DateTime.formatIso(m.createdAt).slice(0, 16).replace("T", " "),
      text: cut(m.text.trim(), RECAP_MESSAGE_CHARS),
    }));
}

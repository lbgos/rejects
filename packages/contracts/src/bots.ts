import { ComputerAction } from "./botComputer.ts";
import { BotReadiness } from "./botReadiness.ts";
import { BOT_ICON_NAMES } from "./botIcons.ts";
import * as Schema from "effect/Schema";
import { MessageId, ThreadId, ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import { ZdrState } from "./zdr.ts";

/**
 * A runaway guard, not a budget. The heaviest day measured on one bot was 3.1M charged tokens
 * (a 15-minute watch plus one scraping loop); 20M is over six times that.
 */
export const DEFAULT_BOT_DAILY_TOKEN_CAP = 20_000_000;
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));
export const BOT_MODEL_TEMPLATES = ["light", "opus", "lead"] as const;
export const BotModelTemplate = Schema.Literals(BOT_MODEL_TEMPLATES);
export type BotModelTemplate = typeof BotModelTemplate.Type;
export const BOT_OPUS_MODEL = "claude-opus-5-5";
export const BOT_CHEAP_MODELS = [
  "deepseek-v4.1-flash",
  "zai-glm-5-3-flash",
  "zai-glm-5-3",
] as const;
export interface BotModelSource {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly enabled: boolean;
  readonly supportedRuntimeModes?: ReadonlyArray<string> | undefined;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isCustom: boolean }>;
}
export const findBotModel = (
  providers: ReadonlyArray<BotModelSource>,
  slugs: ReadonlyArray<string>,
  allowCodex = false,
): ModelSelection | undefined => {
  for (const slug of slugs) {
    const serving = providers.filter(
      (provider) =>
        provider.enabled &&
        (allowCodex || provider.driver !== "codex") &&
        (provider.supportedRuntimeModes === undefined ||
          provider.supportedRuntimeModes.includes("full-access")) &&
        provider.models.some((model) => model.slug === slug),
    );
    // A driver lists its catalog on every instance; the instance that added the model as its own,
    // else one with no models of its own, is the one that really serves it.
    const best =
      serving.find((p) => p.models.some((m) => m.slug === slug && m.isCustom)) ??
      serving.find((p) => !p.models.some((m) => m.isCustom)) ??
      serving[0];
    if (best) return { instanceId: best.instanceId, model: slug };
  }
  return undefined;
};
/**
 * A template's models. A bot that already runs the model a template picks keeps its selection,
 * so its options (such as Opus effort) survive a template switch.
 */
export const botTemplateModels = (
  template: BotModelTemplate,
  providers: ReadonlyArray<BotModelSource>,
  current?: {
    readonly modelSelection: ModelSelection;
    readonly workerModel?: ModelSelection | undefined;
  },
):
  | { readonly modelSelection: ModelSelection; readonly workerModel?: ModelSelection }
  | undefined => {
  const keep = (picked: ModelSelection | undefined) =>
    [current?.modelSelection, current?.workerModel].find(
      (own) => own?.instanceId === picked?.instanceId && own?.model === picked?.model,
    ) ?? picked;
  const cheap = keep(findBotModel(providers, BOT_CHEAP_MODELS));
  const opus = keep(findBotModel(providers, [BOT_OPUS_MODEL]));
  if (template === "light") return cheap && { modelSelection: cheap };
  if (template === "opus") return opus && { modelSelection: opus };
  return opus && cheap && { modelSelection: opus, workerModel: cheap };
};
export const BOT_OWN_SKILLS_MAX = 20;
export const BOT_OWN_SKILL_DESCRIPTION_MAX = 160;
export const BotOwnSkill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/), Schema.isMaxLength(40)),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BOT_OWN_SKILL_DESCRIPTION_MAX),
  ),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  updatedAt: Schema.String,
});
export type BotOwnSkill = typeof BotOwnSkill.Type;
const Icon = Schema.Literals(BOT_ICON_NAMES);
export const BotInput = Schema.Struct({
  name: Name,
  icon: Schema.optional(Icon),
  persona: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  modelSelection: ModelSelection,
  modelTemplate: Schema.optional(BotModelTemplate),
  workerModel: Schema.optional(ModelSelection),
  dailyTokenCap: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  starters: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
      Schema.isMaxLength(4),
    ),
  ),
  kind: Schema.optional(Schema.Literals(["music"])),
  skills: Schema.optional(Schema.Array(Schema.Literals(["music"]))),
  tools: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(60))).check(Schema.isMaxLength(60)),
  ),
  ownSkills: Schema.optional(
    Schema.Array(BotOwnSkill).check(Schema.isMaxLength(BOT_OWN_SKILLS_MAX)),
  ),
});
export type BotInput = typeof BotInput.Type;
export const MEMORY_NOTE_MAX_LENGTH = 500;
export const MemoryNoteText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MEMORY_NOTE_MAX_LENGTH),
);
export const MemoryNoteStatus = Schema.Literals(["fresh", "stale", "contradicted"]);
export type MemoryNoteStatus = typeof MemoryNoteStatus.Type;
export const MemoryNoteSource = Schema.Struct({
  by: Schema.String,
  threadId: Schema.optional(ThreadId),
  messageId: Schema.optional(MessageId),
  quote: Schema.optional(Schema.String),
  at: Schema.String,
});
export type MemoryNoteSource = typeof MemoryNoteSource.Type;
export const MemoryNote = Schema.Struct({
  id: Schema.String,
  text: MemoryNoteText,
  status: MemoryNoteStatus,
  reason: Schema.optional(Schema.String),
  source: MemoryNoteSource,
  checkedAt: Schema.optional(Schema.String),
  /**
   * Kept in every turn's context while it fits. "user": the user pinned it, and only they unpin it.
   * "auto": pinned on import or by the nightly check, which may unpin it.
   */
  pinned: Schema.optional(Schema.Literals(["user", "auto"])),
  until: Schema.optional(Schema.String),
  retiredAt: Schema.optional(Schema.String),
  supersededBy: Schema.optional(Schema.String),
  useCount: Schema.optional(Schema.Number),
  lastUsedAt: Schema.optional(Schema.String),
});
export type MemoryNote = typeof MemoryNote.Type;
export const MEMORY_NOTES_MAX = 2000;
export const BOT_MEMORY_NOTES_MAX = 500;
export const BotMemory = Schema.Array(MemoryNote).check(Schema.isMaxLength(MEMORY_NOTES_MAX));
export type BotMemory = typeof BotMemory.Type;
const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();
/** A short stable id from the note's first text and time (FNV-1a), so ids need no randomness. */
export function noteId(text: string, at: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${at}\n${text}`) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `n${hash.toString(36).padStart(7, "0")}`;
}
/** `id` null adds one; empty text or a copy of another note forgets it; unchanged text on a stale or contradicted note marks it fresh. A pin and an end date still ahead stay. */
export function editNote(
  notes: BotMemory,
  id: string | null,
  text: string,
  at: string,
  max: number = MEMORY_NOTES_MAX,
): BotMemory {
  const line = oneLine(text).slice(0, MEMORY_NOTE_MAX_LENGTH);
  const duplicate = (except?: string) =>
    notes.some((note) => note.id !== except && note.text.toLowerCase() === line.toLowerCase());
  if (id === null) {
    if (!line || duplicate() || notes.length >= max) return notes;
    return [
      ...notes,
      { id: noteId(line, at), text: line, status: "fresh", source: { by: "user", at } },
    ];
  }
  const current = notes.find((note) => note.id === id);
  if (!current || (line === current.text && current.status === "fresh")) return notes;
  if (!line || duplicate(id)) return notes.filter((note) => note.id !== id);
  // An end date that has passed would mark the note stale again the next night.
  const { reason: _reason, until: _until, ...rest } = current;
  const until = current.until && current.until >= at.slice(0, 10) ? { until: current.until } : {};
  const next: MemoryNote =
    line === current.text
      ? { ...rest, ...until, status: "fresh", checkedAt: at }
      : {
          id,
          text: line,
          status: "fresh",
          source: { by: "user", at },
          ...(current.pinned ? { pinned: current.pinned } : {}),
          ...until,
        };
  return notes.map((note) => (note.id === id ? next : note));
}
export const MEMORY_PAGE_MAX = 100;
export const MemoryNotesPage = Schema.Struct({
  notes: BotMemory,
  total: Schema.Int,
});
export type MemoryNotesPage = typeof MemoryNotesPage.Type;
export const MemoryChange = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  threadId: Schema.optional(ThreadId),
  op: Schema.Literals([
    "confirm",
    "rewrite",
    "merge",
    "stale",
    "contradicted",
    "delete",
    "expire",
    "add",
    "pin",
    "unpin",
  ]),
  reason: Schema.optional(Schema.String),
  before: Schema.Array(MemoryNote),
  after: Schema.Array(MemoryNote),
  undone: Schema.optional(Schema.Boolean),
});
export type MemoryChange = typeof MemoryChange.Type;
export const MemoryDreams = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(ModelSelection),
  fallbackModelSelection: ModelSelection,
  lastRun: Schema.NullOr(
    Schema.Struct({
      at: Schema.String,
      summary: Schema.String,
      counts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      errors: Schema.Array(Schema.String),
    }),
  ),
  changes: Schema.Array(MemoryChange),
});
export type MemoryDreams = typeof MemoryDreams.Type;
export const BotDreamRun = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  at: Schema.String,
  durationMs: Schema.Number,
  model: ModelSelection,
  input: Schema.Number,
  cached: Schema.Number,
  output: Schema.Number,
  outcome: Schema.Literals(["changed", "skipped", "failed"]),
  result: Schema.String,
});
export type BotDreamRun = typeof BotDreamRun.Type;
export const BOT_REACTIONS = ["👍", "❤️", "😂", "‼️", "❓", "✅", "👀", "⏰"] as const;
export const BotReaction = Schema.Literals(BOT_REACTIONS);
export type BotReaction = typeof BotReaction.Type;
export const BotReactEmoji = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16));
export type BotReactEmoji = typeof BotReactEmoji.Type;
const SINGLE_EMOJI =
  /^\p{Extended_Pictographic}(?:[\p{Emoji_Modifier}\uFE0F]|\u200D\p{Extended_Pictographic})*$/u;
export const isSingleEmoji = (text: string) => SINGLE_EMOJI.test(text);
export const emojiOnlyReply = (text: string) => {
  const trimmed = text.trim();
  return isSingleEmoji(trimmed) ? trimmed : undefined;
};
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/gu;
const ACKNOWLEDGEMENTS = new Set(
  [
    "ок|окей|хорошо|ладно|понял|поняла|понятно|принято|ясно|договорились|пожалуйста",
    "всегда пожалуйста|не за что|рад помочь|рада помочь|обращайся|обращайтесь|на здоровье",
    "отлично|супер|взаимно|спасибо",
    "гаразд|добре|зрозумів|зрозуміла|зрозуміло|прийнято|домовились|будь ласка|нема за що",
    "немає за що|радий допомогти|рада допомогти|звертайся|звертайтеся|чудово|навзаєм|дякую",
    "ok|okay|got it|noted|sure|understood|you're welcome|no problem|anytime|glad to help",
    "happy to help|great|thanks|thank you",
    "готово|сделано|зроблено|done|reaction sent|reacted|реакция отправлена|реакцію надіслано",
    "no text|no reply|без текста|нет текста|без тексту|немає тексту",
  ].flatMap((line) => line.split("|")),
);
const ECHO_MAX_CHARS = 24;
export const isReactionEcho = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("?") || [...trimmed].length > ECHO_MAX_CHARS) return false;
  const clauses = trimmed
    .replace(EMOJI, "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replaceAll("’", "'")
    .replace(/[()[\]"«»*_`]/gu, "")
    .split(/[,.!;:…]+/u)
    .map((clause) => clause.trim().replace(/\s+/gu, " "))
    .filter((clause) => clause !== "");
  return clauses.every((clause) => ACKNOWLEDGEMENTS.has(clause));
};

export const messagesKeptByOffers = <T>(
  items: ReadonlyArray<T>,
  kindOf: (item: T) => "message" | "offer" | "other",
): ReadonlySet<number> => {
  const kept = new Set<number>();
  let latest: number | undefined;
  for (const [index, item] of items.entries()) {
    const kind = kindOf(item);
    if (kind === "message") latest = index;
    else if (kind === "offer" && latest !== undefined) kept.add(latest);
  }
  return kept;
};
const Reaction = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16));
export const BotReactions = Schema.Record(Schema.String, Reaction);
export type BotReactions = typeof BotReactions.Type;
const MAX_REACTIONS = 200;
export function setReaction(
  reactions: BotReactions | undefined,
  messageId: string,
  emoji: string | null,
): BotReactions {
  const { [messageId]: _previous, ...rest } = reactions ?? {};
  const entries = Object.entries(rest);
  if (emoji !== null) entries.push([messageId, emoji]);
  return Object.fromEntries(entries.slice(-MAX_REACTIONS));
}
const IPV4_ENTRY = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?:(\d{1,5})$/;
/** The broadest grant: one /24. */
const LOCAL_NETWORK_MIN_PREFIX = 24;
/** `scripts/bot-sandbox-net.sh` applies the same rule. */
export const parseLocalNetworkEntry = (text: string): string | undefined => {
  const match = IPV4_ENTRY.exec(text.trim());
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  const prefix = match[5] === undefined ? 32 : Number(match[5]);
  const port = Number(match[6]);
  const [first = 0, second = 0] = octets;
  if (
    octets.some((octet) => octet > 255) ||
    prefix > 32 ||
    prefix < LOCAL_NETWORK_MIN_PREFIX ||
    port < 1 ||
    port > 65535 ||
    !(
      first === 10 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  )
    return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (octets.reduce((value, octet) => value * 256 + octet, 0) & mask) >>> 0;
  const address = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".");
  return `${address}${prefix === 32 ? "" : `/${prefix}`}:${port}`;
};
export const LocalNetworkEntry = Schema.String.check(
  Schema.makeFilter((text) => parseLocalNetworkEntry(text) === text),
);
export const LOCAL_NETWORK_MAX_ENTRIES = 32;
/**
 * A standalone bot is sealed for good: no other bot reaches it and it reaches none, it has no
 * memory, files or schedules, and nothing of the others enters its prompt. Only the user's own
 * create call sets it; no update or bot tool changes it.
 */
export const BotStandalone = Schema.optional(Schema.Literal(true));
export const BotCreateInput = Schema.Struct({ ...BotInput.fields, standalone: BotStandalone });
export type BotCreateInput = typeof BotCreateInput.Type;
export const BotRecord = Schema.Struct({
  ...BotInput.fields,
  standalone: BotStandalone,
  localNetwork: Schema.optional(Schema.Array(Schema.String)),
  memory: Schema.optional(BotMemory),
  muted: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(BotReactions),
  historyFrom: Schema.optional(Schema.String),
  threadId: ThreadId,
  projectId: ProjectId,
  createdAt: Schema.String,
  unread: Schema.Boolean,
  stopReason: Schema.optional(Schema.String),
  lastNotification: Schema.NullOr(Schema.String),
  /** When the preview was set. A preview from before `historyFrom` is not shown. */
  previewAt: Schema.optional(Schema.String),
  notifiedAt: Schema.NullOr(Schema.String),
});
export type BotRecord = typeof BotRecord.Type;
export const BOT_COMPACT_MESSAGE_PREFIX = "bots:compact:";
/**
 * Message ids of the server's keep-warm turns, `bots:keepwarm:<run>:<n>`: a non-persisted resume of the
 * chat's Claude session that reads its prompt cache so the cache outlives an idle spell.
 */
export const BOT_KEEPWARM_MESSAGE_PREFIX = "bots:keepwarm:";
export const isBotKeepWarmMessage = (messageId: string) =>
  messageId.startsWith(BOT_KEEPWARM_MESSAGE_PREFIX);
export const BOT_KEEPWARM_TEXT = "Reply with only: ok";
export const isBotUpkeepMessage = (messageId: string) =>
  messageId.startsWith(BOT_COMPACT_MESSAGE_PREFIX) ||
  isBotKeepWarmMessage(messageId) ||
  messageId.startsWith("bots:flush:");
export const TELEGRAM_MESSAGE_PREFIX = "tg:";
export const isTelegramMessage = (messageId: string) =>
  messageId.startsWith(TELEGRAM_MESSAGE_PREFIX);
/** The server's hidden prompt that starts a fresh instance's first turn in the main bot's chat. */
export const BOT_KICKOFF_MESSAGE_PREFIX = "bots:kickoff:";
export const isBotKickoffMessage = (messageId: string) =>
  messageId.startsWith(BOT_KICKOFF_MESSAGE_PREFIX);
/** The example a new bot answers right after the main bot creates it; its answer pushes. */
export const BOT_EXAMPLE_MESSAGE_PREFIX = "bots:example:";
export const isBotExampleMessage = (messageId: string) =>
  messageId.startsWith(BOT_EXAMPLE_MESSAGE_PREFIX);
export const BOT_USAGE_CHAT = "Chat";
export const BOT_USAGE_WORKERS = "Workers";
export const BOT_USAGE_OTHER = "Other";
export const BOT_USAGE_KEEPWARM = "Keep-warm";
export const BOT_USAGE_DREAMING = "Dreaming";
export const BotUsageDay = Schema.Struct({
  day: Schema.String,
  tokens: Schema.Number,
  turns: Schema.Number,
  sources: Schema.Array(
    Schema.Struct({ source: Schema.String, tokens: Schema.Number, turns: Schema.Number }),
  ),
});
export type BotUsageDay = typeof BotUsageDay.Type;
export const BotSummary = Schema.Struct({
  ...BotRecord.fields,
  noteCount: Schema.optional(Schema.Int),
  tokensToday: Schema.Number,
  usage: Schema.Array(BotUsageDay),
  dreams: Schema.optional(Schema.Array(BotDreamRun)),
  stopped: Schema.Boolean,
  resumesAt: Schema.NullOr(Schema.String),
  main: Schema.optional(Schema.Boolean),
});
export type BotSummary = typeof BotSummary.Type;
export const BotScreen = Schema.Struct({
  available: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  activity: Schema.NullOr(Schema.String),
  controlling: Schema.Boolean,
  width: Schema.Int,
  height: Schema.Int,
});
export type BotScreen = typeof BotScreen.Type;
export const BotRecordingStep = Schema.Struct({
  at: Schema.String,
  action: Schema.String,
  detail: Schema.String,
  status: Schema.Literals(["ok", "refused", "failed"]),
  image: Schema.Boolean,
});
export type BotRecordingStep = typeof BotRecordingStep.Type;
export const BotRecording = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  steps: Schema.Array(BotRecordingStep),
});
export type BotRecording = typeof BotRecording.Type;
export const LinkPreview = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  site: Schema.String,
  image: Schema.NullOr(Schema.String),
});
export type LinkPreview = typeof LinkPreview.Type;
/**
 * The places a bot can point at with `show_ui`. The client marks each with `data-ui-target` and
 * knows how to reveal it (a route on a phone, the sidebar on desktop); the model never names a
 * selector.
 */
export const UI_TARGETS = [
  "dictation",
  "notifications",
  "accounts",
  "bots",
  "new_bot",
  "settings",
] as const;
export const UiTarget = Schema.Literals(UI_TARGETS);
export type UiTarget = typeof UiTarget.Type;
export const ShowUiInput = Schema.Struct({
  target: UiTarget,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type ShowUiInput = typeof ShowUiInput.Type;

export const BotPreferences = Schema.Struct({
  language: Schema.optional(Schema.Literals(["en", "uk", "ru"])),
  experience: Schema.optional(Schema.Literals(["new", "experienced"])),
  /** The user's IANA zone: fixed-time schedules, the nightly check and bots' clocks use it. */
  timeZone: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type BotPreferences = typeof BotPreferences.Type;
export const BOTS_ENDPOINTS = {
  list: {
    path: "/api/bots/list",
    payload: Schema.Struct({
      viewing: Schema.optional(ThreadId),
      left: Schema.optional(ThreadId),
      /** Random per page load, so one client leaving a chat does not end another's view of it. */
      client: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
      /** The device's IANA zone; the server keeps the first one it gets as the user's. */
      timeZone: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
    }),
    success: Schema.Array(BotSummary),
    scope: AuthOrchestrationReadScope,
  },
  create: {
    path: "/api/bots/create",
    payload: BotCreateInput,
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  preferences: {
    path: "/api/bots/preferences",
    payload: Schema.Struct({}),
    success: BotPreferences,
    scope: AuthOrchestrationReadScope,
  },
  setPreferences: {
    path: "/api/bots/preferences/set",
    payload: BotPreferences,
    success: BotPreferences,
    scope: AuthOrchestrationOperateScope,
  },
  setup: {
    path: "/api/bots/setup",
    payload: Schema.Struct({
      language: Schema.Literals(["en", "uk", "ru"]),
      experience: Schema.Literals(["new", "experienced"]),
      /** The first run's pick; a fresh instance's main bot and Steward run on it. */
      modelSelection: Schema.optional(ModelSelection),
    }),
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  readiness: {
    path: "/api/bots/readiness",
    payload: Schema.Struct({}),
    success: BotReadiness,
    scope: AuthOrchestrationReadScope,
  },
  /**
   * The pending proposal as only a client sees it: its display id and the nonce a Create tap
   * must send with it. No tool result ever carries the nonce, so the main bot cannot approve.
   */
  proposal: {
    path: "/api/bots/proposal",
    payload: Schema.Struct({}),
    success: Schema.NullOr(Schema.Struct({ id: Schema.String, nonce: Schema.String })),
    scope: AuthOrchestrationReadScope,
  },
  /**
   * The user's Create tap under the main bot's `propose_bots` proposal: the only way a proposal
   * is approved, so `bot_create` can make its bots. Fails once the proposal is replaced or used up.
   */
  approveProposal: {
    path: "/api/bots/proposal/approve",
    payload: Schema.Struct({
      proposalId: Schema.String.check(Schema.isMaxLength(64)),
      nonce: Schema.String.check(Schema.isMaxLength(64)),
      /** The Create message the client sends next; only it may use the approval. */
      messageId: MessageId,
    }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  releaseProposal: {
    path: "/api/bots/proposal/release",
    payload: Schema.Struct({ proposalId: Schema.String.check(Schema.isMaxLength(64)) }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  update: {
    path: "/api/bots/update",
    payload: Schema.Struct({ threadId: ThreadId, ...BotInput.fields }),
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  notes: {
    path: "/api/bots/memory/notes",
    payload: Schema.Struct({
      threadId: Schema.NullOr(ThreadId),
      query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      retired: Schema.optional(Schema.Boolean),
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_PAGE_MAX })),
    }),
    success: MemoryNotesPage,
    scope: AuthOrchestrationReadScope,
  },
  setLocalNetwork: {
    path: "/api/bots/local-network",
    payload: Schema.Struct({
      threadId: ThreadId,
      localNetwork: Schema.Array(LocalNetworkEntry).check(
        Schema.isMaxLength(LOCAL_NETWORK_MAX_ENTRIES),
      ),
    }),
    success: BotRecord,
    scope: AuthSettingsWriteScope,
  },
  editNote: {
    path: "/api/bots/memory/edit",
    payload: Schema.Struct({
      threadId: Schema.NullOr(ThreadId),
      id: Schema.NullOr(Schema.String),
      text: Schema.String.check(Schema.isMaxLength(MEMORY_NOTE_MAX_LENGTH)),
    }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  setNote: {
    path: "/api/bots/memory/set",
    payload: Schema.Struct({
      threadId: Schema.NullOr(ThreadId),
      id: Schema.String,
      pinned: Schema.optional(Schema.Boolean),
      retired: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  dreams: {
    path: "/api/bots/memory/dreams",
    payload: Schema.Struct({}),
    success: MemoryDreams,
    scope: AuthOrchestrationReadScope,
  },
  setDreams: {
    path: "/api/bots/memory/dreams/set",
    payload: Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    }),
    success: MemoryDreams,
    scope: AuthOrchestrationOperateScope,
  },
  dreamNow: {
    path: "/api/bots/memory/dreams/run",
    payload: Schema.Struct({}),
    success: MemoryDreams,
    scope: AuthOrchestrationOperateScope,
  },
  undoDream: {
    path: "/api/bots/memory/dreams/undo",
    payload: Schema.Struct({ id: Schema.String }),
    success: MemoryDreams,
    scope: AuthOrchestrationOperateScope,
  },
  zdr: {
    path: "/api/bots/zdr",
    payload: Schema.Struct({}),
    success: ZdrState,
    scope: AuthOrchestrationReadScope,
  },
  /** Turning zero data retention off fails unless `confirmOff` is set: the client asks first. */
  setZdr: {
    path: "/api/bots/zdr/set",
    payload: Schema.Struct({
      enabled: Schema.Boolean,
      confirmOff: Schema.optional(Schema.Boolean),
    }),
    success: ZdrState,
    scope: AuthOrchestrationOperateScope,
  },
  linkPreview: {
    path: "/api/bots/link-preview",
    payload: Schema.Struct({ url: Schema.String }),
    success: LinkPreview,
    scope: AuthOrchestrationReadScope,
  },
  mute: {
    path: "/api/bots/mute",
    payload: Schema.Struct({ threadId: ThreadId, muted: Schema.Boolean }),
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  react: {
    path: "/api/bots/react",
    payload: Schema.Struct({
      threadId: ThreadId,
      messageId: MessageId,
      emoji: Schema.NullOr(Reaction),
    }),
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  read: {
    path: "/api/bots/read",
    payload: Schema.Struct({ threadId: ThreadId, notifiedAt: Schema.NullOr(Schema.String) }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  unread: {
    path: "/api/bots/unread",
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  clear: {
    path: "/api/bots/clear",
    payload: Schema.Struct({ threadId: ThreadId }),
    success: BotRecord,
    scope: AuthOrchestrationOperateScope,
  },
  delete: {
    path: "/api/bots/delete",
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  screen: {
    path: "/api/bots/screen",
    payload: Schema.Struct({ threadId: ThreadId }),
    success: BotScreen,
    scope: AuthOrchestrationReadScope,
  },
  recordings: {
    path: "/api/bots/recordings",
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Array(BotRecording),
    scope: AuthOrchestrationReadScope,
  },
  recordingImage: {
    path: "/api/bots/recording-image",
    payload: Schema.Struct({ threadId: ThreadId, id: Schema.String, step: Schema.Int }),
    success: Schema.Struct({ image: Schema.NullOr(Schema.String) }),
    scope: AuthOrchestrationReadScope,
  },
  computerControl: {
    path: "/api/bots/computer-control",
    payload: Schema.Struct({ threadId: ThreadId, active: Schema.Boolean }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  computerInput: {
    path: "/api/bots/computer-input",
    payload: Schema.Struct({ threadId: ThreadId, input: ComputerAction }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  computerStop: {
    path: "/api/bots/computer-stop",
    payload: Schema.Struct({ threadId: ThreadId, reset: Schema.Boolean }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
} as const;

/**
 * Tokens a provider turn charges against a bot's daily cap. Input includes cache reads, which
 * cost about a tenth of fresh input on every provider bots run on, so they count at that rate.
 */
export const chargedTokens = (usage: {
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}) => {
  const cached = usage.cachedInputTokens ?? 0;
  return Math.round((usage.inputTokens ?? 0) - cached + cached / 10 + (usage.outputTokens ?? 0));
};

const TOKEN_UNITS = [
  { suffix: "M", size: 1_000_000 },
  { suffix: "k", size: 1_000 },
] as const;

export function formatTokens(tokens: number): string {
  for (const { suffix, size } of TOKEN_UNITS) {
    if (tokens >= size)
      return `${Number((tokens / size).toFixed(tokens >= size * 10 ? 0 : 2))}${suffix}`;
  }
  return String(tokens);
}

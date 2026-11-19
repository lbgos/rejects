import {
  BOT_USAGE_CHAT,
  BOT_USAGE_OTHER,
  BOT_USAGE_WORKERS,
  BotMemory,
  BotPreferences,
  BotRecord,
  BotSummary,
  BotUsageDay,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  isBotKickoffMessage,
  MemoryNote,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import { telegramLinked } from "../telegram/linked.ts";
import { webAllowed } from "../mcp/BotTools.ts";
import { botInstructions, workerInstructions } from "./instructions.ts";
import { webBots } from "./WebBrowser.ts";
import { setDefaultChatLanguage } from "./language.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";
import { scheduleTimeZone } from "../scheduledTasks/Schedule.ts";
import { legacyNote } from "./memory.ts";

export const MESSAGES_PER_HOUR = 20;
/** About one trivial turn of context, so such turns still reach the cap (40 of them under the default cap) without one stop capping the bot. */
export const UNREPORTED_TURN_TOKENS = 50_000;
const DAY_MS = 86_400_000;
export const WAKES_KEPT = 24;
const Wake = Schema.Struct({
  threadId: ThreadId,
  botThreadId: ThreadId,
  taskId: Schema.String,
  title: Schema.String,
  startedAt: Schema.Number,
  result: Schema.optional(Schema.String),
});
export type Wake = typeof Wake.Type;
export const USAGE_DAYS_KEPT = 14;
const USAGE_SOURCES_KEPT = 8;
const Usage = Schema.Struct({
  day: Schema.String,
  turns: Schema.Record(Schema.String, Schema.Number),
  sources: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  history: Schema.optional(Schema.Array(BotUsageDay)),
});
type Usage = typeof Usage.Type;
const sumTokens = (turns: Usage["turns"]) => Object.values(turns).reduce((a, b) => a + b, 0);
export const summarizeUsage = (usage: Pick<Usage, "day" | "turns" | "sources">): BotUsageDay => {
  const bySource = new Map<string, { tokens: number; turns: number }>();
  for (const [turn, tokens] of Object.entries(usage.turns)) {
    const source = usage.sources?.[turn] ?? BOT_USAGE_OTHER;
    const entry = bySource.get(source) ?? { tokens: 0, turns: 0 };
    bySource.set(source, { tokens: entry.tokens + tokens, turns: entry.turns + 1 });
  }
  const ranked = [...bySource]
    .map(([source, entry]) => ({ source, ...entry }))
    .toSorted((a, b) => b.tokens - a.tokens);
  const head = ranked.slice(0, USAGE_SOURCES_KEPT);
  const tail = ranked.slice(USAGE_SOURCES_KEPT);
  const merged = [...tail, ...head.filter((s) => s.source === BOT_USAGE_OTHER)];
  const other = {
    source: BOT_USAGE_OTHER,
    tokens: merged.reduce((a, s) => a + s.tokens, 0),
    turns: merged.reduce((a, s) => a + s.turns, 0),
  };
  return {
    day: usage.day,
    tokens: sumTokens(usage.turns),
    turns: Object.keys(usage.turns).length,
    sources:
      tail.length === 0 ? head : [...head.filter((s) => s.source !== BOT_USAGE_OTHER), other],
  };
};
const rollUsage = (stored: Usage | undefined, today: string, oldest: string): Usage => {
  const history = (stored?.history ?? []).filter((entry) => entry.day >= oldest);
  if (stored?.day === today) return { ...stored, history };
  const finished =
    stored && stored.day >= oldest && Object.keys(stored.turns).length > 0
      ? [...history, summarizeUsage(stored)]
      : history;
  return { day: today, turns: {}, history: finished.slice(-USAGE_DAYS_KEPT) };
};
const Onboarding = Schema.Struct({
  kickoff: Schema.optional(Schema.Literals(["pending", "done"])),
  /** Set by a fresh instance's first run; the main bot's first `show_ui` ends it. */
  tour: Schema.optional(Schema.Literals(["pending", "done"])),
  proposal: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      /**
       * Client-only proof of a Create tap: the web reads it over HTTP and the Telegram button
       * carries it. It never appears in a tool result or in text the model sees.
       */
      nonce: Schema.optional(Schema.String),
      /** The message the tap approved: only a run it starts may use the approval. */
      messageId: Schema.optional(Schema.String),
      botThreadId: ThreadId,
      /** Template ids stay strings here, so a renamed template cannot make the file unreadable. */
      bots: Schema.Array(Schema.Struct({ template: Schema.String, name: Schema.String })),
      /** Set only by the user's Create tap in the client, never by a message. */
      approved: Schema.optional(Schema.Boolean),
      /** The main bot's run the approval belongs to; the approval dies with that run. */
      runId: Schema.optional(Schema.String),
    }),
  ),
});
export type Onboarding = typeof Onboarding.Type;
const State = Schema.Struct({
  steward: Schema.optional(
    Schema.Struct({
      sequence: Schema.Number,
      delivered: Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Number })),
    }),
  ),
  stewardRemoved: Schema.optional(Schema.Boolean),
  bots: Schema.Array(BotRecord),
  owners: Schema.Record(Schema.String, ThreadId),
  usage: Schema.Record(Schema.String, Usage),
  /**
   * The default cap whose floor was last applied to every bot. A bot below a higher default is
   * raised once; a cap the owner lowers afterwards stays.
   */
  capFloor: Schema.optional(Schema.Number),
  alerts: Schema.optional(Schema.Array(Schema.String)),
  pausedUntil: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  wakes: Schema.optional(Schema.Array(Wake)),
  /** The user's shared notes before `BotMemoryStore`; read once to import them, then left as is. */
  userMemory: Schema.optional(BotMemory),
  mainBot: Schema.optional(ThreadId),
  preferences: Schema.optional(BotPreferences),
  onboarding: Schema.optional(Onboarding),
  messages: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ key: Schema.String, at: Schema.Number })),
  ),
});
const StoredMemory = Schema.Array(Schema.Union([MemoryNote, Schema.String]));
const StoredState = Schema.Struct({
  ...State.fields,
  bots: Schema.Array(Schema.Struct({ ...BotRecord.fields, memory: Schema.optional(StoredMemory) })),
  userMemory: Schema.optional(StoredMemory),
});
const upgradeMemory = (memory: typeof StoredMemory.Type, at: string): BotMemory =>
  memory.map((entry) => (typeof entry === "string" ? legacyNote(entry, at) : entry));
export const withHistoryFrom = (bot: BotRecord, historyFrom: string): BotRecord => {
  const { previewAt, ...rest } = bot;
  return bot.lastNotification === null ||
    (previewAt !== undefined && Date.parse(previewAt) >= Date.parse(historyFrom))
    ? { ...bot, historyFrom }
    : { ...rest, historyFrom, lastNotification: null, notifiedAt: null, unread: false };
};
/** Tool names a stored bot may hold from before a rename, and the tool each became. */
const RENAMED_TOOLS: Readonly<Record<string, string>> = { youtube_transcript: "video_transcript" };
const renameTools = (tools: ReadonlyArray<string>) => [
  ...new Set(tools.map((tool) => RENAMED_TOOLS[tool] ?? tool)),
];
const upgrade = (stored: typeof StoredState.Type, at: string): typeof State.Type => {
  const { bots, userMemory, ...rest } = stored;
  const raiseCaps = stored.capFloor !== DEFAULT_BOT_DAILY_TOKEN_CAP;
  return {
    ...rest,
    capFloor: DEFAULT_BOT_DAILY_TOKEN_CAP,
    bots: bots.map(({ memory, ...stored }) => {
      // A stop reason describes the cap that was hit, so raising the cap clears it.
      const { stopReason: _stopped, ...raised } = stored;
      const capped =
        raiseCaps && stored.dailyTokenCap < DEFAULT_BOT_DAILY_TOKEN_CAP
          ? { ...raised, dailyTokenCap: DEFAULT_BOT_DAILY_TOKEN_CAP }
          : stored;
      const renamed = capped.tools ? { ...capped, tools: renameTools(capped.tools) } : capped;
      const bot =
        memory === undefined ? renamed : { ...renamed, memory: upgradeMemory(memory, at) };
      return bot.historyFrom === undefined ? bot : withHistoryFrom(bot, bot.historyFrom);
    }),
    ...(userMemory === undefined ? {} : { userMemory: upgradeMemory(userMemory, at) }),
  };
};
const empty = (): typeof State.Type => ({
  bots: [],
  owners: {},
  usage: {},
  messages: {},
  capFloor: DEFAULT_BOT_DAILY_TOKEN_CAP,
});
const withoutWakes = (state: typeof State.Type, gone: ReadonlySet<string>): typeof State.Type => ({
  ...state,
  owners: Object.fromEntries(Object.entries(state.owners).filter(([thread]) => !gone.has(thread))),
  wakes: (state.wakes ?? []).filter((wake) => !gone.has(wake.threadId)),
});
export class BotStoreError extends Schema.TaggedError<BotStoreError>()("BotStoreError", {
  operation: Schema.Literals(["read", "write", "missing", "duplicate", "cap", "rate", "zone"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.operation === "rate"
      ? "Bot message cap reached. Work stopped until the hourly window resets."
      : this.operation === "cap"
        ? "Bot daily token cap reached. Work stopped until tomorrow."
        : this.operation === "duplicate"
          ? "A bot with this name already exists."
          : this.operation === "zone"
            ? "Unknown time zone."
            : `Bot operation failed: ${this.operation}.`;
  }
}
/**
 * A zone as the device or Settings spelled it, if Intl accepts it. Kept as given: Intl may resolve a
 * current name to an old alias (Node's ICU turns Europe/Kyiv into Europe/Kiev).
 */
const validZone = (zone: string): Option.Option<string> =>
  Option.map(DateTime.zoneMakeNamed(zone.trim()), () => zone.trim());
export class BotStore extends Context.Service<
  BotStore,
  {
    readonly stewardCursor: Effect.Effect<number | undefined>;
    readonly stewardDelivery: (key: string) => Effect.Effect<"ready" | "duplicate" | "limited">;
    readonly stewardHandled: (sequence: number, key?: string) => Effect.Effect<void, BotStoreError>;
    readonly stewardRemoved: Effect.Effect<boolean>;
    readonly family: (id: ThreadId) => Effect.Effect<readonly ThreadId[]>;
    readonly claimAlert: (key: string) => Effect.Effect<boolean, BotStoreError>;
    readonly list: Effect.Effect<readonly BotSummary[], BotStoreError>;
    readonly get: (id: ThreadId) => Effect.Effect<BotRecord | undefined>;
    readonly owner: (id: ThreadId) => Effect.Effect<BotRecord | undefined>;
    readonly botFor: (id: ThreadId) => Effect.Effect<BotRecord | undefined>;
    readonly startWake: (
      wake: Omit<Wake, "result" | "startedAt">,
    ) => Effect.Effect<void, BotStoreError>;
    readonly wake: (id: ThreadId) => Effect.Effect<Wake | undefined>;
    readonly endWake: (
      id: ThreadId,
      result: string,
    ) => Effect.Effect<
      { readonly wake: Wake; readonly pruned: readonly ThreadId[] } | undefined,
      BotStoreError
    >;
    readonly previousWake: (id: ThreadId) => Effect.Effect<Wake | undefined>;
    readonly forgetWakes: (
      botThreadId: ThreadId,
    ) => Effect.Effect<readonly ThreadId[], BotStoreError>;
    readonly inherit: (
      thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
    ) => Effect.Effect<void, BotStoreError>;
    readonly put: (bot: BotRecord) => Effect.Effect<void, BotStoreError>;
    /** Applies `change` to the bot as stored now, so a concurrent notify or stop is kept. */
    readonly edit: (
      id: ThreadId,
      change: (bot: BotRecord) => BotRecord,
    ) => Effect.Effect<BotRecord, BotStoreError>;
    readonly markRead: (
      id: ThreadId,
      notifiedAt: string | null,
    ) => Effect.Effect<void, BotStoreError>;
    readonly markUnread: (id: ThreadId) => Effect.Effect<void, BotStoreError>;
    readonly remove: (id: ThreadId) => Effect.Effect<void, BotStoreError>;
    readonly recordStop: (id: ThreadId, reason: string) => Effect.Effect<void, BotStoreError>;
    readonly notify: (id: ThreadId, text: string) => Effect.Effect<BotRecord, BotStoreError>;
    readonly preview: (id: ThreadId, text: string) => Effect.Effect<BotRecord, BotStoreError>;
    readonly assertBudget: (id: ThreadId) => Effect.Effect<void, BotStoreError>;
    /** The largest report per turn counts. An ended turn with no reported usage is charged `UNREPORTED_TURN_TOKENS`. */
    readonly charge: (
      id: ThreadId,
      turn: string,
      tokens: number,
      options?: { readonly ended?: boolean; readonly source?: string },
    ) => Effect.Effect<boolean, BotStoreError>;
    readonly message: (
      from: ThreadId,
      to: ThreadId,
      key: string,
    ) => Effect.Effect<boolean, BotStoreError>;
    readonly persona: (
      id: ThreadId,
      options?: { readonly sealed?: boolean },
    ) => Effect.Effect<string | undefined>;
    readonly legacyMemory: Effect.Effect<{
      readonly you: BotMemory;
      readonly bots: ReadonlyArray<{ readonly threadId: ThreadId; readonly notes: BotMemory }>;
    }>;
    readonly named: (name: string) => Effect.Effect<BotRecord | undefined>;
    readonly mainBot: Effect.Effect<ThreadId | undefined>;
    readonly setMainBot: (id: ThreadId | null) => Effect.Effect<void, BotStoreError>;
    /** That is the turn's one notification, so it sends no push; `endTelegramTurn` clears the mark when the run ends. */
    readonly sentToTelegram: (id: ThreadId) => Effect.Effect<void>;
    readonly telegramTurn: (id: ThreadId) => Effect.Effect<boolean>;
    readonly endTelegramTurn: (id: ThreadId) => Effect.Effect<void>;
    readonly preferences: Effect.Effect<BotPreferences>;
    readonly setPreferences: (
      change: BotPreferences,
    ) => Effect.Effect<BotPreferences, BotStoreError>;
    /** The user's IANA zone: the one their device reported first, else the host's. */
    readonly timeZone: Effect.Effect<string>;
    /**
     * Keeps a device's zone as the user's when no valid one is set; later devices and travel change
     * nothing. Settings changes it through `setPreferences`.
     */
    readonly seedTimeZone: (zone: string) => Effect.Effect<void, BotStoreError>;
    readonly onboarding: Effect.Effect<Onboarding>;
    readonly updateOnboarding: (
      change: (current: Onboarding) => Onboarding,
    ) => Effect.Effect<Onboarding, BotStoreError>;
    /** Ties an approval to the main bot's run it starts; later runs cannot use it. */
    readonly claimApproval: (
      runId: string,
      messageId: string,
    ) => Effect.Effect<void, BotStoreError>;
    readonly endApproval: (runId: string) => Effect.Effect<void, BotStoreError>;
    /**
     * Drops an approval a run already claimed when the user writes again, so a later message
     * cannot make its bots. The message that started the claimed run keeps it.
     */
    readonly endApprovalOnMessage: (messageId: string) => Effect.Effect<void, BotStoreError>;
    readonly bridged: (id: ThreadId) => Effect.Effect<boolean>;
    readonly setBridged: (ids: ReadonlySet<ThreadId>) => Effect.Effect<void>;
  }
>()("t3/bots/BotStore") {}

/** False when the main bot has replaced or used the proposal up since, or when the call came from a tool: only a client ever receives the nonce. */
export const approveProposal = (
  store: BotStore["Service"],
  id: string,
  nonce: string,
  messageId: string,
) =>
  store
    .updateOnboarding((current) => {
      const proposal = current.proposal;
      return proposal?.id === id && nonce.length > 0 && proposal.nonce === nonce
        ? { ...current, proposal: { ...proposal, approved: true, runId: undefined, messageId } }
        : current;
    })
    .pipe(Effect.map(({ proposal }) => proposal?.id === id && proposal.approved === true));

/**
 * The end of the first-run turn, however it ended, ends a pending tour: the tour runs in that
 * turn, and a reply that skipped show_ui must not keep restarting it on later turns.
 */
export const endTourAfter = (store: BotStore["Service"], userMessageId: string) =>
  isBotKickoffMessage(userMessageId)
    ? store
        .updateOnboarding((current) =>
          current.tour === "pending" ? { ...current, tour: "done" } : current,
        )
        .pipe(Effect.asVoid)
    : Effect.void;

export const releaseProposal = (store: BotStore["Service"], id: string) =>
  store.updateOnboarding((current) =>
    current.proposal?.id === id
      ? { ...current, proposal: { ...current.proposal, approved: undefined, runId: undefined } }
      : current,
  );

const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, "bots.json");
  const telegramFile = path.join(config.stateDir, "telegram.json");
  const camofoxFile = path.join(config.stateDir, "camofox.json");
  const lock = yield* Semaphore.make(1);
  const loadedAt = DateTime.formatIso(yield* DateTime.now);
  let state = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredState))),
    Effect.map((stored) => upgrade(stored, loadedAt)),
    Effect.catchTags({
      PlatformError: (e) =>
        e.reason._tag === "NotFound" ? Effect.succeed(empty()) : Effect.fail(e),
    }),
    Effect.orDie,
  );
  if (state.preferences?.language) setDefaultChatLanguage(state.preferences.language);
  const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const day = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 10);
  const owner = (id: ThreadId) =>
    state.bots.find((bot) => bot.threadId === (state.owners[id] ?? id));
  let bridgedIds: ReadonlySet<ThreadId> = new Set();
  const telegramTurns = new Set<ThreadId>();
  const wakeOf = (id: ThreadId) => state.wakes?.find((wake) => wake.threadId === id);
  const botFor = (id: ThreadId) =>
    state.bots.find((bot) => bot.threadId === (wakeOf(id)?.botThreadId ?? id));
  const usage = (id: ThreadId, at: number) =>
    rollUsage(state.usage[id], day(at), day(at - USAGE_DAYS_KEPT * DAY_MS));
  const total = (id: ThreadId, at: number) => sumTokens(usage(id, at).turns);
  const sourceOf = (id: ThreadId, bot: BotRecord) =>
    wakeOf(id)?.title ?? (id === bot.threadId ? BOT_USAGE_CHAT : BOT_USAGE_WORKERS);
  const userZone = () => {
    const stored = state.preferences?.timeZone;
    const zone = stored === undefined ? Option.none() : validZone(stored);
    return Option.getOrElse(zone, () => DateTime.zoneToString(scheduleTimeZone(undefined)));
  };
  const save = (next: typeof State.Type) =>
    encodeState(next).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tap(() =>
        Effect.sync(() => {
          state = next;
        }),
      ),
      Effect.mapError((cause) => new BotStoreError({ operation: "write", cause })),
    );
  const mutate = <A>(f: () => Effect.Effect<A, BotStoreError>) =>
    lock.withPermit(Effect.suspend(f));
  const setPreview = (id: ThreadId, text: string, notified: boolean) =>
    mutate(() =>
      Effect.gen(function* () {
        const bot = owner(id);
        if (!bot) return yield* new BotStoreError({ operation: "missing" });
        const at = DateTime.formatIso(DateTime.makeUnsafe(yield* now));
        const next: BotRecord = notified
          ? { ...bot, unread: true, lastNotification: text, previewAt: at, notifiedAt: at }
          : { ...bot, lastNotification: text, previewAt: at };
        yield* save({
          ...state,
          bots: state.bots.map((b) => (b.threadId === bot.threadId ? next : b)),
        });
        return next;
      }),
    );
  const replace = (bot: BotRecord) =>
    state.bots.some(
      (b) => b.threadId !== bot.threadId && b.name.toLowerCase() === bot.name.toLowerCase(),
    )
      ? Effect.fail(new BotStoreError({ operation: "duplicate" }))
      : save({
          ...state,
          bots: [...state.bots.filter((b) => b.threadId !== bot.threadId), bot],
        });
  const assertBudget = Effect.fn("BotStore.assertBudget")(function* (id: ThreadId) {
    const bot = owner(id);
    if (bot && (state.pausedUntil?.[bot.threadId] ?? 0) > (yield* now))
      return yield* new BotStoreError({ operation: "rate" });
    if (bot && total(bot.threadId, yield* now) >= bot.dailyTokenCap)
      return yield* new BotStoreError({ operation: "cap" });
  });
  return BotStore.of({
    stewardCursor: Effect.sync(() => state.steward?.sequence),
    stewardRemoved: Effect.sync(() => state.stewardRemoved === true),
    stewardDelivery: Effect.fn("BotStore.stewardDelivery")(function* (key) {
      const delivered = state.steward?.delivered ?? [];
      if (delivered.some((event) => event.key === key)) return "duplicate" as const;
      const at = yield* now;
      return delivered.filter((event) => event.at > at - 3600000).length >= MESSAGES_PER_HOUR
        ? ("limited" as const)
        : ("ready" as const);
    }),
    stewardHandled: (sequence, key) =>
      mutate(() =>
        Effect.gen(function* () {
          const at = yield* now;
          const delivered = state.steward?.delivered ?? [];
          yield* save({
            ...state,
            steward: {
              sequence: Math.max(sequence, state.steward?.sequence ?? 0),
              delivered:
                key && !delivered.some((event) => event.key === key)
                  ? [...delivered.slice(-1999), { key, at }]
                  : delivered,
            },
          });
        }),
      ),
    family: (id) =>
      Effect.sync(() => [
        id,
        ...Object.entries(state.owners)
          .filter(([, root]) => root === id)
          .map(([child]) => ThreadId.make(child)),
      ]),
    claimAlert: (key) =>
      mutate(() =>
        Effect.gen(function* () {
          const currentDay = day(yield* now);
          const id = `${currentDay}:${key}`;
          if (state.alerts?.includes(id)) return false;
          yield* save({
            ...state,
            alerts: [...(state.alerts ?? []).filter((a) => a.startsWith(currentDay)), id],
          });
          return true;
        }),
      ),
    get: (id) => Effect.sync(() => state.bots.find((bot) => bot.threadId === id)),
    owner: (id) => Effect.sync(() => owner(id)),
    botFor: (id) => Effect.sync(() => botFor(id)),
    wake: (id) => Effect.sync(() => wakeOf(id)),
    startWake: (wake) =>
      mutate(() =>
        Effect.gen(function* () {
          if (wakeOf(wake.threadId) || !state.bots.some((b) => b.threadId === wake.botThreadId))
            return;
          yield* save({
            ...state,
            owners: { ...state.owners, [wake.threadId]: wake.botThreadId },
            wakes: [...(state.wakes ?? []), { ...wake, startedAt: yield* now }],
          });
        }),
      ),
    endWake: (id, result) =>
      mutate(() =>
        Effect.gen(function* () {
          const current = wakeOf(id);
          if (!current || current.result !== undefined) return undefined;
          const wake = { ...current, result };
          const wakes = (state.wakes ?? []).map((w) => (w.threadId === id ? wake : w));
          const pruned = wakes
            .filter((w) => w.botThreadId === wake.botThreadId && w.result !== undefined)
            .toSorted((a, b) => b.startedAt - a.startedAt)
            .slice(WAKES_KEPT)
            .map((w) => w.threadId);
          yield* save(withoutWakes({ ...state, wakes }, new Set(pruned)));
          return { wake, pruned };
        }),
      ),
    previousWake: (id) =>
      Effect.sync(() => {
        const current = wakeOf(id);
        if (!current) return undefined;
        return (state.wakes ?? [])
          .filter(
            (w) =>
              w.botThreadId === current.botThreadId &&
              w.taskId === current.taskId &&
              w.result !== undefined &&
              w.startedAt < current.startedAt,
          )
          .toSorted((a, b) => b.startedAt - a.startedAt)[0];
      }),
    forgetWakes: (botThreadId) =>
      mutate(() =>
        Effect.gen(function* () {
          const gone = (state.wakes ?? [])
            .filter((w) => w.botThreadId === botThreadId)
            .map((w) => w.threadId);
          if (gone.length > 0) yield* save(withoutWakes(state, new Set(gone)));
          return gone;
        }),
      ),
    list: Effect.gen(function* () {
      const at = yield* now;
      // Notes live in BotMemoryStore; the list carries only their count.
      return state.bots.map(({ memory: _memory, ...bot }) => {
        const current = usage(bot.threadId, at);
        const tokensToday = sumTokens(current.turns);
        const paused = state.pausedUntil?.[bot.threadId] ?? 0;
        // Usage days are UTC dates, so a capped bot resumes at the next UTC midnight.
        const resumesAt = Math.max(
          paused > at ? paused : 0,
          tokensToday >= bot.dailyTokenCap ? (Math.floor(at / DAY_MS) + 1) * DAY_MS : 0,
        );
        return {
          ...bot,
          tokensToday,
          usage: [summarizeUsage(current), ...(current.history ?? []).toReversed()],
          stopped: resumesAt > 0,
          resumesAt: resumesAt > 0 ? DateTime.formatIso(DateTime.makeUnsafe(resumesAt)) : null,
          ...(state.mainBot === bot.threadId ? { main: true } : {}),
        };
      });
    }),
    put: (bot) => mutate(() => replace(bot)),
    edit: (id, change) =>
      mutate(() => {
        const bot = state.bots.find((b) => b.threadId === id);
        if (!bot) return Effect.fail(new BotStoreError({ operation: "missing" }));
        const next = change(bot);
        return replace(next).pipe(Effect.as(next));
      }),
    inherit: (thread) =>
      mutate(() => {
        const parent = thread.lineage.parentThreadId;
        const bot = parent === null ? undefined : owner(parent);
        return !bot || state.owners[thread.id] === bot.threadId
          ? Effect.void
          : save({ ...state, owners: { ...state.owners, [thread.id]: bot.threadId } });
      }),
    markRead: (id, notifiedAt) =>
      mutate(() =>
        save({
          ...state,
          bots: state.bots.map((b) =>
            b.threadId === id && b.notifiedAt === notifiedAt ? { ...b, unread: false } : b,
          ),
        }),
      ),
    markUnread: (id) =>
      mutate(() =>
        save({
          ...state,
          bots: state.bots.map((b) => (b.threadId === id ? { ...b, unread: true } : b)),
        }),
      ),
    remove: (id) =>
      mutate(() => {
        const { [id]: _usage, ...usage } = state.usage;
        const { [id]: _messages, ...messages } = state.messages;
        const { [id]: _paused, ...pausedUntil } = state.pausedUntil ?? {};
        const { mainBot, ...rest } = state;
        return save({
          ...rest,
          ...(mainBot === undefined || mainBot === id ? {} : { mainBot }),
          ...(id === STEWARD_THREAD_ID ? { stewardRemoved: true } : {}),
          wakes: (state.wakes ?? []).filter((w) => w.botThreadId !== id),
          bots: state.bots.filter((b) => b.threadId !== id),
          owners: Object.fromEntries(
            Object.entries(state.owners).filter(([child, root]) => child !== id && root !== id),
          ),
          usage,
          messages,
          pausedUntil,
        });
      }),
    recordStop: (id, reason) =>
      mutate(() =>
        save({
          ...state,
          bots: state.bots.map((bot) =>
            bot.threadId === id ? { ...bot, stopReason: reason } : bot,
          ),
        }),
      ),
    notify: (id, text) => setPreview(id, text, true),
    preview: (id, text) => setPreview(id, text, false),
    assertBudget,
    charge: (id, turn, reported, options) =>
      mutate(() =>
        Effect.gen(function* () {
          const bot = owner(id);
          if (!bot) return false;
          const at = yield* now;
          const current = usage(bot.threadId, at);
          const previous = current.turns[turn] ?? 0;
          const tokens =
            reported === 0 && previous === 0 && options?.ended ? UNREPORTED_TURN_TOKENS : reported;
          if (previous >= tokens) return false;
          const next = {
            ...current,
            turns: { ...current.turns, [turn]: tokens },
            sources: {
              ...current.sources,
              [turn]: current.sources?.[turn] ?? options?.source ?? sourceOf(id, bot),
            },
          };
          yield* save({
            ...state,
            usage: {
              ...state.usage,
              [bot.threadId]: next,
            },
          });
          return (
            sumTokens(next.turns) >= bot.dailyTokenCap &&
            sumTokens(current.turns) < bot.dailyTokenCap
          );
        }),
      ),
    message: (from, to, key) =>
      mutate(() =>
        Effect.gen(function* () {
          const sender = owner(from),
            receiver = owner(to);
          if (!sender || !receiver) return true;
          const at = yield* now;
          const recent = (state.messages[sender.threadId] ?? []).filter((m) => m.at > at - 3600000);
          if (recent.some((m) => m.key === key)) return true;
          if (recent.length >= MESSAGES_PER_HOUR) {
            const until = recent[0]!.at + 3600000;
            if ((state.pausedUntil?.[sender.threadId] ?? 0) !== until)
              yield* save({
                ...state,
                pausedUntil: { ...state.pausedUntil, [sender.threadId]: until },
              });
            return false;
          }
          yield* assertBudget(from);
          yield* save({
            ...state,
            messages: { ...state.messages, [sender.threadId]: [...recent, { key, at }] },
          });
          return true;
        }),
      ),
    persona: Effect.fn("BotStore.persona")(function* (
      id: ThreadId,
      options?: { readonly sealed?: boolean },
    ) {
      const bot = owner(id);
      if (!bot) return undefined;
      if (bot.threadId !== id && !wakeOf(id)) return workerInstructions(bot.name);
      const linked = yield* telegramLinked(fs, telegramFile);
      return botInstructions({
        telegramLinked: linked,
        bot,
        // A standalone bot sees no other bot, and none sees it.
        roster: bot.standalone
          ? []
          : state.bots.filter((b) => b.threadId !== bot.threadId && !b.standalone),
        messagesPerHour: MESSAGES_PER_HOUR,
        timeZone: userZone(),
        bridged: bridgedIds.has(bot.threadId),
        main: state.mainBot === bot.threadId,
        sealed: options?.sealed,
        experience: state.preferences?.experience,
        tour: state.onboarding?.tour === "pending",
        web: webAllowed(yield* webBots(fs, camofoxFile), bot.threadId),
      });
    }),
    legacyMemory: Effect.sync(() => ({
      you: state.userMemory ?? [],
      bots: state.bots.map((bot) => ({ threadId: bot.threadId, notes: bot.memory ?? [] })),
    })),
    named: (name) =>
      Effect.sync(() => {
        const wanted = name.trim().toLowerCase();
        return state.bots.find(
          (bot) => bot.name.toLowerCase() === wanted || bot.threadId === name.trim(),
        );
      }),
    mainBot: Effect.sync(() => state.mainBot),
    setMainBot: (id) =>
      mutate(() => {
        if (id !== null && !state.bots.some((bot) => bot.threadId === id))
          return Effect.fail(new BotStoreError({ operation: "missing" }));
        const { mainBot: _previous, ...rest } = state;
        return save(id === null ? rest : { ...rest, mainBot: id });
      }),
    sentToTelegram: (id) => Effect.sync(() => void telegramTurns.add(id)),
    telegramTurn: (id) => Effect.sync(() => telegramTurns.has(id)),
    endTelegramTurn: (id) => Effect.sync(() => void telegramTurns.delete(id)),
    preferences: Effect.sync(() => state.preferences ?? {}),
    setPreferences: (change) =>
      mutate(() => {
        const zone = change.timeZone === undefined ? undefined : validZone(change.timeZone);
        if (zone !== undefined && Option.isNone(zone))
          return Effect.fail(new BotStoreError({ operation: "zone" }));
        const preferences = {
          ...state.preferences,
          ...change,
          ...(zone === undefined ? {} : { timeZone: zone.value }),
        };
        return save({ ...state, preferences }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (preferences.language) setDefaultChatLanguage(preferences.language);
            }),
          ),
          Effect.as(preferences),
        );
      }),
    timeZone: Effect.sync(userZone),
    seedTimeZone: (zone) =>
      mutate(() => {
        const stored = state.preferences?.timeZone;
        const seed = validZone(zone);
        return (stored !== undefined && Option.isSome(validZone(stored))) || Option.isNone(seed)
          ? Effect.void
          : save({ ...state, preferences: { ...state.preferences, timeZone: seed.value } });
      }),
    onboarding: Effect.sync(() => state.onboarding ?? {}),
    updateOnboarding: (change) =>
      mutate(() => {
        const onboarding = change(state.onboarding ?? {});
        return save({ ...state, onboarding }).pipe(Effect.as(onboarding));
      }),
    claimApproval: (runId, messageId) =>
      mutate(() => {
        const proposal = state.onboarding?.proposal;
        if (proposal?.approved !== true || proposal.runId !== undefined) return Effect.void;
        // A run the tap did not start cannot use the approval: the Create message never came.
        if (proposal.messageId !== undefined && proposal.messageId !== messageId) {
          const { proposal: _stale, ...onboarding } = state.onboarding ?? {};
          return save({ ...state, onboarding });
        }
        return save({
          ...state,
          onboarding: { ...state.onboarding, proposal: { ...proposal, runId } },
        });
      }),
    endApproval: (runId) =>
      mutate(() => {
        const proposal = state.onboarding?.proposal;
        if (proposal?.approved !== true || proposal.runId !== runId) return Effect.void;
        const { proposal: _ended, ...onboarding } = state.onboarding ?? {};
        return save({ ...state, onboarding });
      }),
    endApprovalOnMessage: (messageId) =>
      mutate(() => {
        const proposal = state.onboarding?.proposal;
        if (proposal?.approved !== true || proposal.messageId === messageId) return Effect.void;
        const { proposal: _ended, ...onboarding } = state.onboarding ?? {};
        return save({ ...state, onboarding });
      }),
    bridged: (id) => Effect.sync(() => bridgedIds.has(id)),
    setBridged: (ids) =>
      Effect.sync(() => {
        bridgedIds = ids;
      }),
  });
});
export const layer = Layer.effect(BotStore, make);

export const standingBot = Effect.fn("BotStore.standingBot")(function* (
  store: BotStore["Service"],
) {
  const steward = yield* store.get(STEWARD_THREAD_ID);
  if (steward) return steward;
  const main = yield* store.mainBot;
  return main === undefined ? undefined : yield* store.get(main);
});

import {
  BOT_MEMORY_NOTES_MAX,
  BOT_USAGE_DREAMING,
  BotDreamRun,
  type BotMemory,
  chargedTokens,
  isBotUpkeepMessage,
  MEMORY_NOTES_MAX,
  MemoryNote,
  MemoryChange,
  type MemoryDreams,
  ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { nextScheduledRunAt, scheduleTimeZone } from "../scheduledTasks/Schedule.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Memory from "./BotMemoryStore.ts";
import * as Notifications from "./BotNotifications.ts";
import * as Store from "./BotStore.ts";
import {
  applyDream,
  type DreamChange,
  type DreamMessage,
  DreamOutput,
  dreamPrompt,
  expireStale,
  undoChange,
} from "./dreaming.ts";
import { CORE_CHARS, recallQueries, RECALL_MIN } from "./memory.ts";
import {
  applySkillDream,
  callLine,
  type SkillDreamRun,
  SkillDreamOutput,
  skillDreamPrompt,
  skillLine,
  unsavedSkillsLine,
} from "./skillDreams.ts";
import { STEWARD_MODEL } from "./steward.ts";

const FIRST_WINDOW_MS = 14 * 86_400_000;
const MESSAGES_PER_SCOPE = 80;
/** Replies shorter than this get the bot message they answer, so "yes" can be read. */
const SHORT_REPLY = 60;
const CHANGES_KEPT = 300;
const CHANGES_SHOWN = 100;
const WHOLE_SCOPE_NOTES = 120;
const BATCH_UNCHECKED = 60;
const BATCH_NEIGHBOURS = 3;
const BATCH_PER_MESSAGE = 2;
const RETIRED_KEPT_MS = 90 * 86_400_000;
/** How far back the skill check reads a bot's runs, so a request repeated on another day counts. */
const SKILL_WINDOW_MS = 7 * 86_400_000;
const SKILL_RUNS = 30;
const SKILL_CALLS_PER_RUN = 12;
const RUNS_KEPT = 14;

const Stored = Schema.Struct({
  enabled: Schema.Boolean,
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  /** User messages after this are new to the check; it moves only when a run had no errors. */
  lastRunAt: Schema.optional(Schema.String),
  lastRun: Schema.optional(
    Schema.Struct({
      at: Schema.String,
      summary: Schema.String,
      counts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
      errors: Schema.Array(Schema.String),
    }),
  ),
  changes: Schema.Array(MemoryChange),
  /** Newest first, `RUNS_KEPT` per bot; absent from state files written before runs were kept. */
  runs: Schema.optional(Schema.Array(BotDreamRun)),
});
type Stored = typeof Stored.Type;

export class BotDreamsError extends Schema.TaggedError<BotDreamsError>()("BotDreamsError", {
  operation: Schema.Literals(["read", "write", "missing", "busy"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.operation === "busy"
      ? "The memory check is already running."
      : this.operation === "missing"
        ? "That change or its bot no longer exists."
        : `Memory check ${this.operation} failed.`;
  }
}

export class BotDreams extends Context.Service<
  BotDreams,
  {
    readonly state: Effect.Effect<MemoryDreams>;
    readonly runs: Effect.Effect<ReadonlyArray<BotDreamRun>>;
    readonly set: (change: {
      readonly enabled?: boolean | undefined;
      readonly modelSelection?: ModelSelection | null | undefined;
    }) => Effect.Effect<MemoryDreams, BotDreamsError>;
    readonly check: Effect.Effect<MemoryDreams, BotDreamsError>;
    readonly runNow: Effect.Effect<MemoryDreams, BotDreamsError>;
    readonly undo: (id: string) => Effect.Effect<MemoryDreams, BotDreamsError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/BotDreams") {}

const NIGHTLY = { type: "fixed_time", timeOfDay: "03:30" } as const;

const COUNT_WORDS: Record<MemoryChange["op"] | "refused", string> = {
  add: "added",
  pin: "pinned",
  unpin: "unpinned",
  confirm: "confirmed",
  rewrite: "corrected",
  merge: "merged",
  stale: "marked stale",
  contradicted: "marked contradicted",
  delete: "deleted",
  expire: "expired",
  refused: "refused",
};

function runResult(changes: ReadonlyArray<Pick<MemoryChange, "op">>, refused: number, skills = 0) {
  const counts: Record<string, number> = refused > 0 ? { refused } : {};
  for (const change of changes) counts[change.op] = (counts[change.op] ?? 0) + 1;
  if (skills > 0) counts.skills = skills;
  const parts = [
    ...Object.entries(COUNT_WORDS).flatMap(([key, word]) =>
      counts[key] === undefined ? [] : [`${counts[key]} ${word}`],
    ),
    ...(skills > 0 ? [`${skills} ${skills === 1 ? "skill" : "skills"} written`] : []),
  ];
  return { counts, summary: parts.length > 0 ? parts.join(", ") : "No changes" };
}

const causeText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const keepRuns = (runs: ReadonlyArray<BotDreamRun>): ReadonlyArray<BotDreamRun> => {
  const kept = new Map<string, number>();
  const out: Array<BotDreamRun> = [];
  for (const run of runs) {
    const key = run.threadId ?? "you";
    const count = kept.get(key) ?? 0;
    if (count >= RUNS_KEPT) continue;
    kept.set(key, count + 1);
    out.push(run);
  }
  return out;
};

type RunEntry = {
  readonly threadId: ThreadId | undefined;
  readonly at: number;
  durationMs: number;
  input: number;
  cached: number;
  output: number;
  called: boolean;
  refused: number;
  skills: number;
  error?: string;
};

const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Stored));
const encodeSnapshot = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ scope: Schema.String, notes: Schema.Array(MemoryNote) })),
  ),
);
const BACKUP_DAYS = 14;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const bots = yield* Store.BotStore;
  // The nightly check runs at 03:30 in the user's zone.
  const nextRun = Effect.all([DateTime.now, bots.timeZone]).pipe(
    Effect.map(
      ([now, zone]) =>
        nextScheduledRunAt(NIGHTLY, now, scheduleTimeZone(zone)) ?? DateTime.add(now, { days: 1 }),
    ),
  );
  const notifications = yield* Notifications.BotNotifications;
  const memory = yield* Memory.BotMemoryStore;
  const threads = yield* Threads.ThreadManagementService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const file = path.join(config.stateDir, "bot-dreams.json");
  const lock = yield* Semaphore.make(1);
  const runs = yield* Semaphore.make(1);
  // Runs started from a request outlive it, so a dropped client cannot cut a run short.
  const scope = yield* Effect.scope;
  let running = false;
  let stored: Stored = yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))),
    Effect.catchTags({
      PlatformError: (e) =>
        e.reason._tag === "NotFound"
          ? Effect.succeed<Stored>({ enabled: false, changes: [] })
          : Effect.fail(e),
    }),
    Effect.orDie,
  );
  const save = (next: Stored) =>
    lock.withPermit(
      encodeStored(next).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: file, contents })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tap(() =>
          Effect.sync(() => {
            stored = next;
          }),
        ),
        Effect.mapError((cause) => new BotDreamsError({ operation: "write", cause })),
      ),
    );

  const state = Effect.gen(function* () {
    return {
      enabled: stored.enabled,
      running,
      nextRunAt: stored.enabled ? DateTime.formatIso(yield* nextRun) : null,
      modelSelection: stored.modelSelection ?? null,
      fallbackModelSelection: (yield* Store.standingBot(bots))?.modelSelection ?? STEWARD_MODEL,
      lastRun: stored.lastRun ?? null,
      changes: stored.changes.slice(0, CHANGES_SHOWN),
    } satisfies MemoryDreams;
  });

  const chatMessages = Effect.fn("BotDreams.chatMessages")(function* (bot: {
    readonly threadId: ThreadId;
    readonly name: string;
  }) {
    const records = yield* threads
      .getThreadRecords(bot.threadId, ["messages"], { turnItemTypes: [] })
      .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
    const ordered = records.messages
      .filter((m) => !m.streaming && m.role !== "system")
      .toSorted(
        (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
      );
    const out: DreamMessage[] = [];
    let lastBotText: string | undefined;
    for (const message of ordered) {
      if (message.role === "assistant") {
        if (message.text.trim()) lastBotText = message.text;
        continue;
      }
      if (message.createdBy !== "user" || isBotUpkeepMessage(message.id) || !message.text.trim())
        continue;
      out.push({
        id: message.id,
        at: DateTime.formatIso(message.createdAt),
        bot: bot.name,
        text: message.text,
        ...(message.text.length < SHORT_REPLY && lastBotText ? { replyTo: lastBotText } : {}),
      });
    }
    return out;
  });

  const chatRuns = Effect.fn("BotDreams.chatRuns")(function* (threadId: ThreadId, from: string) {
    const recent = (yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.orElseSucceed(() => ({ runs: [] })))).runs
      .map((run) => ({ id: run.id, at: DateTime.formatIso(run.requestedAt) }))
      .filter((run) => run.at >= from)
      .slice(-SKILL_RUNS);
    if (recent.length === 0) return [];
    const { turnItems } = yield* threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message", "dynamic_tool", "command_execution"],
        turnItemRunIds: recent.map((run) => run.id),
      })
      .pipe(Effect.orElseSucceed(() => ({ turnItems: [] })));
    const runs = new Map(
      recent.map((run) => [run.id, { at: run.at, request: "", calls: [] as string[] }]),
    );
    for (const item of turnItems) {
      const run = item.runId === null ? undefined : runs.get(item.runId);
      if (run === undefined) continue;
      if (item.type === "user_message") {
        if (item.createdBy === "user") run.request = `${run.request} ${item.text}`.trim();
      } else if (run.calls.length < SKILL_CALLS_PER_RUN) {
        const call = callLine(item);
        if (call !== undefined) run.calls.push(call);
      }
    }
    return [...runs]
      .filter(([, run]) => run.request !== "" && run.calls.length > 0)
      .map(([id, run]): SkillDreamRun => ({ id, ...run }));
  });

  const batch = Effect.fn("BotDreams.batch")(function* (
    scope: Memory.MemoryScope,
    all: BotMemory,
    messages: ReadonlyArray<DreamMessage>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const picked = new Set<string>();
    const likest = (query: string, limit: number, min: number) =>
      memory
        .search([scope], query, { limit, min, now, scan: false })
        .pipe(Effect.orElseSucceed(() => []));
    for (const note of all.filter((n) => n.checkedAt === undefined).slice(0, BATCH_UNCHECKED)) {
      picked.add(note.id);
      for (const { entry } of yield* likest(note.text, BATCH_NEIGHBOURS + 1, 0.35))
        picked.add(entry.note.id);
    }
    for (const message of messages) {
      const [query] = recallQueries(message.text);
      if (query === undefined) continue;
      for (const { entry } of yield* likest(query, BATCH_PER_MESSAGE, RECALL_MIN))
        picked.add(entry.note.id);
    }
    return all.filter((note: MemoryNote) => picked.has(note.id));
  });

  const backups = path.join(config.baseDir, "backups", "memory");
  const backUpNotes = Effect.fn("BotDreams.backUpNotes")(
    function* (nowMs: number) {
      const day = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 10);
      yield* fs.makeDirectory(backups, { recursive: true });
      yield* writeFileStringAtomically({
        filePath: path.join(backups, `notes-${day(nowMs)}.json`),
        contents: yield* encodeSnapshot(yield* memory.snapshot),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const oldest = `notes-${day(nowMs - BACKUP_DAYS * 86_400_000)}.json`;
      for (const name of yield* fs.readDirectory(backups))
        if (/^notes-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < oldest)
          yield* fs.remove(path.join(backups, name));
    },
    Effect.mapError((cause) => new BotDreamsError({ operation: "write", cause })),
  );

  const run = Effect.fn("BotDreams.run")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const since =
      stored.lastRunAt ?? DateTime.formatIso(DateTime.makeUnsafe(nowMs - FIRST_WINDOW_MS));
    const model =
      stored.modelSelection ?? (yield* Store.standingBot(bots))?.modelSelection ?? STEWARD_MODEL;
    // A standalone bot's chat never reaches notes, its own or the shared ones every bot gets.
    const roster = (yield* bots.list.pipe(Effect.orElseSucceed(() => []))).filter(
      (bot) => bot.kind !== "music" && !bot.standalone,
    );
    const chats = new Map<ThreadId, ReadonlyArray<DreamMessage>>();
    for (const bot of roster) chats.set(bot.threadId, yield* chatMessages(bot));
    const entries = new Map<ThreadId | "you", RunEntry>();
    const everything = [...chats.values()].flat();
    const recent = (messages: ReadonlyArray<DreamMessage>) =>
      messages
        .filter((m) => m.at > since)
        .toSorted((a, b) => a.at.localeCompare(b.at))
        .slice(-MESSAGES_PER_SCOPE);
    const scopes = [
      {
        threadId: undefined,
        owner: "the user's shared notes, which every bot gets",
        messages: recent(everything),
        sourceMessages: everything,
      },
      ...roster.map((bot) => ({
        threadId: bot.threadId,
        owner: `the working rules of the bot ${bot.name}`,
        messages: recent(chats.get(bot.threadId) ?? []),
        sourceMessages: chats.get(bot.threadId) ?? [],
      })),
    ];
    yield* backUpNotes(nowMs);
    yield* memory
      .purgeRetired(DateTime.formatIso(DateTime.makeUnsafe(nowMs - RETIRED_KEPT_MS)))
      .pipe(Effect.ignore({ log: true }));
    const changes: Array<DreamChange & { readonly threadId?: ThreadId }> = [];
    const errors: string[] = [];
    let refused = 0;
    for (const scope of scopes) {
      const entry: RunEntry = {
        threadId: scope.threadId,
        at: yield* Clock.currentTimeMillis,
        durationMs: 0,
        input: 0,
        cached: 0,
        output: 0,
        called: false,
        refused: 0,
        skills: 0,
      };
      entries.set(scope.threadId ?? "you", entry);
      const target: Memory.MemoryScope = scope.threadId ?? "you";
      const all = yield* memory.notes(target).pipe(Effect.orElseSucceed((): BotMemory => []));
      if (all.length === 0 && scope.messages.length === 0) continue;
      const notes =
        all.length <= WHOLE_SCOPE_NOTES ? all : yield* batch(target, all, scope.messages);
      const pinChars = CORE_CHARS[Memory.scopeKind(target)];
      const refusals: string[] = [];
      const sources = new Map(
        notes.flatMap((note): Array<[string, DreamMessage]> => {
          const message = scope.sourceMessages.find((m) => m.id === note.source.messageId);
          return message ? [[note.id, message]] : [];
        }),
      );
      const worthChecking =
        scope.messages.length > 0 || notes.some((note) => note.checkedAt === undefined);
      const started = yield* Clock.currentTimeMillis;
      const output = worthChecking
        ? yield* textGeneration
            .generateStructured({
              modelSelection: model,
              prompt: dreamPrompt({
                ...scope,
                notes,
                pinChars,
                partial: notes.length < all.length,
                sources,
                now,
              }),
              outputSchema: DreamOutput,
              cwd: config.stateDir,
              operation: "bots.dream",
              onUsage: (usage) => {
                entry.input += usage.input;
                entry.cached += usage.cached;
                entry.output += usage.output;
              },
            })
            .pipe(
              Effect.timeout("5 minutes"),
              Effect.catchCause((cause) =>
                Effect.logWarning("memory check failed", { owner: scope.owner, cause }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      errors.push(`Could not check ${scope.owner}.`);
                      entry.error ??= causeText(cause);
                      return undefined;
                    }),
                  ),
                ),
              ),
              Effect.ensuring(
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((ended) =>
                    Effect.sync(() => {
                      entry.durationMs += ended - started;
                      entry.called = true;
                    }),
                  ),
                ),
              ),
            )
        : { ops: [] };
      if (output === undefined) continue;
      const forgotten = yield* memory
        .forgotten(target)
        .pipe(
          Effect.orElseSucceed(() => ({ hashes: new Set<string>(), messages: new Set<string>() })),
        );
      const snapshot = new Map(notes.map((note) => [note.id, JSON.stringify(note)]));
      const apply = (current: BotMemory) => {
        const expired = expireStale(current, now);
        // A note the user or a bot changed while the model read it keeps that change.
        const unchanged = (id: string) =>
          snapshot.get(id) === JSON.stringify(current.find((note) => note.id === id));
        const result = applyDream({
          forgotten,
          notes: expired.notes,
          ops: output.ops.filter((op) => op.ids.every(unchanged)),
          messages: scope.messages,
          sources,
          now,
          pinChars,
          max: target === "you" ? MEMORY_NOTES_MAX : BOT_MEMORY_NOTES_MAX,
        });
        refusals.push(...result.refused);
        changes.push(
          ...[...expired.changes, ...result.changes].map((change) =>
            scope.threadId ? { ...change, threadId: scope.threadId } : change,
          ),
        );
        // Fresh notes the model read and left alone count as checked; stale ones keep their date to expire.
        return result.notes.map((note) =>
          worthChecking && note.status === "fresh" && snapshot.has(note.id) && unchanged(note.id)
            ? { ...note, checkedAt: now }
            : note,
        );
      };
      yield* Effect.asVoid(memory.edit(target, apply)).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            errors.push(`Could not save ${scope.owner}.`);
            entry.error ??= "could not save its notes";
          }),
        ),
      );
      refused += refusals.length;
      entry.refused += refusals.length;
      if (refusals.length > 0)
        yield* Effect.logInfo("memory check refused ops", { owner: scope.owner, refusals });
    }
    let skillsWritten = 0;
    for (const bot of roster) {
      const entry = entries.get(bot.threadId);
      if (entry === undefined) continue;
      const runs = yield* chatRuns(
        bot.threadId,
        DateTime.formatIso(DateTime.makeUnsafe(nowMs - SKILL_WINDOW_MS)),
      );
      if (!runs.some((run) => run.at > since)) continue;
      const notes = (yield* memory
        .notes(bot.threadId)
        .pipe(Effect.orElseSucceed((): BotMemory => []))).filter((n) => n.status === "fresh");
      const started = yield* Clock.currentTimeMillis;
      const output = yield* textGeneration
        .generateStructured({
          modelSelection: model,
          prompt: skillDreamPrompt({ bot: bot.name, runs, skills: bot.ownSkills ?? [], notes }),
          outputSchema: SkillDreamOutput,
          cwd: config.stateDir,
          operation: "bots.dreamSkills",
          onUsage: (usage) => {
            entry.input += usage.input;
            entry.cached += usage.cached;
            entry.output += usage.output;
          },
        })
        .pipe(
          Effect.timeout("5 minutes"),
          Effect.catchCause((cause) =>
            Effect.logWarning("skill check failed", { bot: bot.name, cause }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  errors.push(`Could not check the skills of ${bot.name}.`);
                  entry.error ??= causeText(cause);
                  return undefined;
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((ended) =>
                Effect.sync(() => {
                  entry.durationMs += ended - started;
                  entry.called = true;
                }),
              ),
            ),
          ),
        );
      if (output === undefined || output.skills.length === 0) continue;
      let result: ReturnType<typeof applySkillDream> | undefined;
      let saved = true;
      yield* bots
        .edit(bot.threadId, (current) => {
          result = applySkillDream({ own: current.ownSkills ?? [], output, runs, notes, now });
          return result.written.length > 0
            ? { ...current, ownSkills: [...result.skills] }
            : current;
        })
        .pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              errors.push(`Could not save the skills of ${bot.name}.`);
              entry.error ??= "could not save its skills";
              saved = false;
            }),
          ),
        );
      if (result === undefined) continue;
      const applied: ReturnType<typeof applySkillDream> = result;
      entry.refused += applied.refused.length;
      if (!saved) {
        // Nothing was written, so nothing is announced or moved; the owner hears that instead.
        if (applied.written.length > 0)
          yield* notifications
            .notify(bot.threadId, unsavedSkillsLine(applied.written.map(({ name }) => name)), {
              quiet: true,
            })
            .pipe(Effect.ignore({ log: true }));
        continue;
      }
      entry.skills = applied.written.length;
      if (applied.refused.length > 0)
        yield* Effect.logInfo("skill check refused", { bot: bot.name, refused: applied.refused });
      if (applied.written.length === 0) continue;
      skillsWritten += applied.written.length;
      // Notes the new skills cover leave memory, logged as deletes so the user can undo them.
      const moved = new Map(applied.movedNotes.map((m) => [m.id, m.skill]));
      if (moved.size > 0)
        yield* Effect.asVoid(
          memory.edit(bot.threadId, (current) => {
            for (const note of current)
              if (moved.has(note.id))
                changes.push({
                  at: now,
                  op: "delete",
                  reason: `Moved to skill ${moved.get(note.id)}`,
                  before: [note],
                  after: [],
                  threadId: bot.threadId,
                });
            return current.filter((note) => !moved.has(note.id));
          }),
        ).pipe(Effect.ignore({ log: true }));
      yield* notifications
        .notify(
          bot.threadId,
          applied.written
            .map(({ name, created }) =>
              skillLine(
                applied.skills.find((s) => s.name === name) ?? { name, description: "" },
                created,
              ),
            )
            .join("\n"),
          // Written at night: the chat and the list show it, without waking the user.
          { quiet: true },
        )
        .pipe(Effect.ignore({ log: true }));
    }
    const endedMs = yield* Clock.currentTimeMillis;
    const rows: Array<BotDreamRun> = [];
    for (const bot of roster) {
      const entry = entries.get(bot.threadId);
      if (entry === undefined) continue;
      const outcome = entry.error !== undefined ? "failed" : entry.called ? "changed" : "skipped";
      rows.push({
        threadId: bot.threadId,
        at: DateTime.formatIso(DateTime.makeUnsafe(entry.at)),
        durationMs: entry.durationMs,
        model,
        input: entry.input,
        cached: entry.cached,
        output: entry.output,
        outcome,
        result:
          outcome === "failed"
            ? `Failed: ${entry.error}`
            : outcome === "skipped"
              ? "Skipped: no new notes or messages"
              : runResult(
                  changes.filter((change) => change.threadId === bot.threadId),
                  entry.refused,
                  entry.skills,
                ).summary,
      });
    }
    // Each scope's spend counts against its bot; the shared notes come out of the standing bot's.
    const sharedEntry = entries.get("you");
    const sharedOwner = (yield* Store.standingBot(bots))?.threadId;
    const charges: ReadonlyArray<{
      readonly id: ThreadId | undefined;
      readonly entry: RunEntry | undefined;
      readonly key: string;
    }> = [
      { id: sharedOwner, entry: sharedEntry, key: "you" },
      ...roster.map((bot) => ({
        id: bot.threadId,
        entry: entries.get(bot.threadId),
        key: bot.threadId,
      })),
    ];
    for (const { id, entry, key } of charges) {
      if (id === undefined || entry === undefined) continue;
      const tokens = chargedTokens({
        inputTokens: entry.input,
        cachedInputTokens: entry.cached,
        outputTokens: entry.output,
      });
      if (tokens === 0) continue;
      yield* bots
        .charge(id, `dream:${now}:${key}`, tokens, { ended: true, source: BOT_USAGE_DREAMING })
        .pipe(Effect.ignore({ log: true }));
    }
    const totals = [...entries.values()].reduce(
      (sum, entry) => ({
        input: sum.input + entry.input,
        cached: sum.cached + entry.cached,
        output: sum.output + entry.output,
      }),
      { input: 0, cached: 0, output: 0 },
    );
    yield* Effect.logInfo("memory check ran", {
      at: now,
      durationMs: endedMs - nowMs,
      model: `${model.instanceId}/${model.model}`,
      input: totals.input,
      cached: totals.cached,
      output: totals.output,
      shared:
        sharedEntry === undefined
          ? null
          : {
              durationMs: sharedEntry.durationMs,
              input: sharedEntry.input,
              cached: sharedEntry.cached,
              output: sharedEntry.output,
            },
      bots: rows,
    });
    const logged = changes.map((change, index) => ({ ...change, id: `${now}#${index}` }));
    yield* save({
      ...stored,
      ...(errors.length === 0 ? { lastRunAt: now } : {}),
      lastRun: { at: now, ...runResult(changes, refused, skillsWritten), errors },
      changes: [...logged.toReversed(), ...stored.changes].slice(0, CHANGES_KEPT),
      runs: keepRuns([...rows, ...(stored.runs ?? [])]),
    });
  });

  const runOnce = runs.withPermit(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        running = true;
      }),
      () => run(),
      () =>
        Effect.sync(() => {
          running = false;
        }),
    ),
  );

  return BotDreams.of({
    state,
    runs: Effect.sync(() => stored.runs ?? []),
    set: (change) =>
      save({
        ...stored,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.modelSelection === undefined ? {} : { modelSelection: change.modelSelection }),
      }).pipe(Effect.andThen(state)),
    check: runOnce.pipe(Effect.andThen(state)),
    runNow: Effect.suspend(() => {
      if (running) return Effect.fail(new BotDreamsError({ operation: "busy" }));
      running = true;
      return Effect.forkIn(
        runOnce.pipe(
          Effect.catchCause((cause) => Effect.logWarning("memory check failed", { cause })),
        ),
        scope,
      );
    }).pipe(Effect.andThen(state)),
    undo: Effect.fn("BotDreams.undo")(function* (id) {
      const change = stored.changes.find((c) => c.id === id);
      if (!change) return yield* new BotDreamsError({ operation: "missing" });
      if (!change.undone) {
        yield* memory
          .edit(change.threadId ?? "you", (notes) => undoChange(notes, change))
          .pipe(Effect.mapError(() => new BotDreamsError({ operation: "missing" })));
        yield* save({
          ...stored,
          changes: stored.changes.map((c) => (c.id === id ? { ...c, undone: true } : c)),
        });
      }
      return yield* state;
    }),
    start: Effect.fn("BotDreams.start")(() =>
      forkParked(
        Effect.gen(function* () {
          while (true) {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(Duration.millis(DateTime.toEpochMillis(yield* nextRun) - now));
            if (!stored.enabled) continue;
            yield* runOnce.pipe(
              Effect.catchCause((cause) => Effect.logWarning("memory check failed", { cause })),
            );
          }
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(BotDreams, make);

import {
  BOT_MEMORY_NOTES_MAX,
  type BotMemory,
  MEMORY_NOTES_MAX,
  MemoryNote,
  type MemoryNotesPage,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Store from "./BotStore.ts";
import { MemoryEmbedder } from "./MemoryEmbedder.ts";
import {
  coreNotes,
  cosine,
  type Forgotten,
  forgetKey,
  ftsQuery,
  fuseRanked,
  importPins,
  matchesTyped,
  PINNED_CHARS,
  QUERY_CHARS,
  type Ranked,
  rankNotes,
  type ScopeKind,
  searchText,
} from "./memory.ts";

export type MemoryScope = "you" | ThreadId;
export const scopeKind = (scope: MemoryScope): ScopeKind => (scope === "you" ? "you" : "bot");
const scopeMax = (scope: MemoryScope) =>
  scope === "you" ? MEMORY_NOTES_MAX : BOT_MEMORY_NOTES_MAX;

const PIN = { none: 0, auto: 1, user: 2 } as const;
const CANDIDATES = 100;
const SCAN_BELOW = 5;
const EMBED_BATCH = 32;

export class BotMemoryError extends Schema.TaggedError<BotMemoryError>()("BotMemoryError", {
  operation: Schema.Literals(["read", "write", "missing", "cap"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.operation === "cap"
      ? "Memory is full. Merge or remove some notes."
      : this.operation === "missing"
        ? "That note no longer exists."
        : `Memory ${this.operation} failed.`;
  }
}

const isMemoryError = Schema.is(BotMemoryError);

export interface SearchOptions {
  readonly limit: number;
  readonly min: number;
  readonly now: number;
  readonly retired?: boolean | undefined;
  readonly since?: string | undefined;
  /** Scan every note when the index finds few; the per-turn recall skips that to stay fast. */
  readonly scan?: boolean | undefined;
  readonly dense?: number | undefined;
}

export interface MemoryEntry {
  readonly scope: MemoryScope;
  readonly note: MemoryNote;
}

export class BotMemoryStore extends Context.Service<
  BotMemoryStore,
  {
    readonly notes: (scope: MemoryScope) => Effect.Effect<BotMemory, BotMemoryError>;
    readonly edit: (
      scope: MemoryScope,
      change: (notes: BotMemory) => BotMemory,
      options?: {
        readonly remove?: "retire" | "delete" | undefined;
        readonly supersededBy?: (() => string | undefined) | undefined;
        /** The user asked to forget the removed notes: they leave a tombstone even when retired. */
        readonly forget?: (() => boolean) | undefined;
      },
    ) => Effect.Effect<BotMemory, BotMemoryError>;
    readonly setNote: (
      scope: MemoryScope,
      id: string,
      change: { readonly pinned?: boolean | undefined; readonly retired?: boolean | undefined },
    ) => Effect.Effect<void, BotMemoryError>;
    readonly page: (
      scope: MemoryScope,
      request: {
        readonly query?: string | undefined;
        readonly retired?: boolean | undefined;
        readonly offset: number;
        readonly limit: number;
      },
    ) => Effect.Effect<MemoryNotesPage, BotMemoryError>;
    readonly core: (
      scope: MemoryScope,
      today: string,
    ) => Effect.Effect<
      { readonly shown: ReadonlyArray<MemoryNote>; readonly total: number },
      BotMemoryError
    >;
    readonly search: (
      scopes: ReadonlyArray<MemoryScope>,
      query: string,
      options: SearchOptions,
    ) => Effect.Effect<Array<Ranked<MemoryEntry>>, BotMemoryError>;
    readonly touch: (
      entries: ReadonlyArray<{ readonly scope: MemoryScope; readonly id: string }>,
      at: string,
    ) => Effect.Effect<void, BotMemoryError>;
    readonly counts: Effect.Effect<ReadonlyMap<string, number>, BotMemoryError>;
    readonly forgotten: (scope: MemoryScope) => Effect.Effect<Forgotten, BotMemoryError>;
    readonly snapshot: Effect.Effect<
      ReadonlyArray<{ readonly scope: string; readonly notes: BotMemory }>,
      BotMemoryError
    >;
    readonly drop: (scope: MemoryScope) => Effect.Effect<void, BotMemoryError>;
    readonly purgeRetired: (before: string) => Effect.Effect<number, BotMemoryError>;
    readonly importLegacy: (
      scopes: ReadonlyArray<{ readonly scope: MemoryScope; readonly notes: BotMemory }>,
      at: string,
    ) => Effect.Effect<ReadonlyArray<MemoryScope>, BotMemoryError>;
    readonly pendingImports: (
      scopes: ReadonlyArray<MemoryScope>,
    ) => Effect.Effect<ReadonlyArray<MemoryScope>, BotMemoryError>;
    /** Stops early while the embedder is unavailable. */
    readonly syncVectors: Effect.Effect<
      { readonly notes: number; readonly vectors: number } | undefined,
      BotMemoryError
    >;
  }
>()("t3/bots/BotMemoryStore") {}

interface Row {
  readonly scope: string;
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly reason: string | null;
  readonly source_by: string;
  readonly thread_id: string | null;
  readonly message_id: string | null;
  readonly quote: string | null;
  readonly at: string;
  readonly checked_at: string | null;
  readonly until: string | null;
  readonly superseded_by: string | null;
  readonly retired_at: string | null;
  readonly pinned: number;
  readonly use_count: number;
  readonly last_used_at: string | null;
}

const STATUSES = new Set<string>(["fresh", "stale", "contradicted"]);

const toNote = (row: Row): MemoryNote => ({
  id: row.id,
  text: row.text,
  status: STATUSES.has(row.status) ? (row.status as MemoryNote["status"]) : "stale",
  ...(row.reason === null ? {} : { reason: row.reason }),
  source: {
    by: row.source_by,
    ...(row.thread_id === null ? {} : { threadId: ThreadId.make(row.thread_id) }),
    ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
    ...(row.quote === null ? {} : { quote: row.quote }),
    at: row.at,
  },
  ...(row.checked_at === null ? {} : { checkedAt: row.checked_at }),
  ...(row.pinned === PIN.user
    ? { pinned: "user" }
    : row.pinned === PIN.auto
      ? { pinned: "auto" }
      : {}),
  ...(row.until === null ? {} : { until: row.until }),
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
  ...(row.use_count > 0 ? { useCount: row.use_count } : {}),
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
});

/** A note as `edit` hands it out and compares it: use counts change on every turn, so they stay out. */
const content = (note: MemoryNote): MemoryNote => {
  const { useCount: _useCount, lastUsedAt: _lastUsedAt, ...rest } = note;
  return rest;
};

const fingerprint = Schema.encodeSync(Schema.fromJsonString(MemoryNote));

const toScope = (scope: string): MemoryScope => (scope === "you" ? "you" : ThreadId.make(scope));

const toVector = (blob: Uint8Array) => new Float32Array(Uint8Array.from(blob).buffer);

export const makeMemoryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const embedder = Option.getOrUndefined(yield* Effect.serviceOption(MemoryEmbedder));
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const syncLock = yield* Semaphore.make(1);
  const failed =
    (operation: "read" | "write") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new BotMemoryError({ operation, cause })));

  // A table of its own, created here and not by a numbered migration: migration numbers belong to
  // upstream T3 Code, and a fork's number would collide with its next one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memory_notes (
      seq INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      source_by TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      quote TEXT,
      at TEXT NOT NULL,
      checked_at TEXT,
      until TEXT,
      superseded_by TEXT,
      retired_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      search_text TEXT NOT NULL,
      UNIQUE (scope, id)
    )
  `.pipe(failed("write"));
  // What the user forgot, so the nightly check does not add it again: no text, only its hash.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memory_forgotten (
      scope TEXT NOT NULL,
      hash TEXT NOT NULL,
      message_id TEXT,
      at TEXT NOT NULL
    )
  `.pipe(failed("write"));
  yield* sql`
    CREATE INDEX IF NOT EXISTS bot_memory_forgotten_scope ON bot_memory_forgotten (scope)
  `.pipe(failed("write"));
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memory_imports (
      scope TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      notes INTEGER NOT NULL
    )
  `.pipe(failed("write"));
  // `seq` is the rowid, so VACUUM keeps the index's rowids valid. Builds without FTS5 trigram
  // support search by scanning.
  const fts = yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS bot_memory_notes_fts USING fts5(
      search_text, content = 'bot_memory_notes', content_rowid = 'seq', tokenize = 'trigram'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning("Memory search index unavailable; search will scan notes.", cause).pipe(
          Effect.as(false),
        ),
    ),
    failed("write"),
  );
  if (fts) {
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS bot_memory_notes_fts_insert AFTER INSERT ON bot_memory_notes
      BEGIN
        INSERT INTO bot_memory_notes_fts (rowid, search_text) VALUES (new.seq, new.search_text);
      END
    `.pipe(failed("write"));
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS bot_memory_notes_fts_delete AFTER DELETE ON bot_memory_notes
      BEGIN
        INSERT INTO bot_memory_notes_fts (bot_memory_notes_fts, rowid, search_text)
        VALUES ('delete', old.seq, old.search_text);
      END
    `.pipe(failed("write"));
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS bot_memory_notes_fts_update
      AFTER UPDATE OF search_text ON bot_memory_notes
      BEGIN
        INSERT INTO bot_memory_notes_fts (bot_memory_notes_fts, rowid, search_text)
        VALUES ('delete', old.seq, old.search_text);
        INSERT INTO bot_memory_notes_fts (rowid, search_text) VALUES (new.seq, new.search_text);
      END
    `.pipe(failed("write"));
  }

  // A live note's vector, made by `model`. Edits that change a note's text or delete it drop the
  // vector; a retired note keeps its own unless the user forgot it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memory_vectors (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (scope, id)
    )
  `.pipe(failed("write"));
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS bot_memory_vectors_note_delete AFTER DELETE ON bot_memory_notes
    BEGIN
      DELETE FROM bot_memory_vectors WHERE scope = old.scope AND id = old.id;
    END
  `.pipe(failed("write"));
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS bot_memory_vectors_note_text AFTER UPDATE OF text ON bot_memory_notes
    WHEN old.text IS NOT new.text
    BEGIN
      DELETE FROM bot_memory_vectors WHERE scope = old.scope AND id = old.id;
    END
  `.pipe(failed("write"));

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const liveVectors = sql<{ readonly notes: number; readonly vectors: number }>`
    SELECT COUNT(*) AS notes, COUNT(v.id) AS vectors FROM bot_memory_notes n
    LEFT JOIN bot_memory_vectors v ON v.scope = n.scope AND v.id = n.id
    WHERE n.retired_at IS NULL
  `.pipe(
    failed("read"),
    Effect.map((found) => ({ notes: found[0]?.notes ?? 0, vectors: found[0]?.vectors ?? 0 })),
  );

  let behind = false;
  const syncVectors = Effect.fn("BotMemoryStore.syncVectors")(function* () {
    if (!embedder) return undefined;
    return yield* syncLock.withPermit(
      Effect.gen(function* () {
        while (true) {
          const missing = yield* sql<{
            readonly scope: string;
            readonly id: string;
            readonly text: string;
          }>`
            SELECT n.scope, n.id, n.text FROM bot_memory_notes n
            WHERE n.retired_at IS NULL AND NOT EXISTS (
              SELECT 1 FROM bot_memory_vectors v WHERE v.scope = n.scope AND v.id = n.id
            )
            ORDER BY n.seq LIMIT ${EMBED_BATCH}
          `.pipe(failed("read"));
          if (missing.length === 0) {
            behind = false;
            break;
          }
          const embedded = yield* embedder.embed(
            missing.map((note) => note.text),
            "passage",
          );
          if (!embedded) {
            behind = true;
            break;
          }
          const stored = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Vectors of another model do not compare with this one's queries: after a model
                // change, the first note embedded clears them and this loop embeds every note again.
                yield* sql`DELETE FROM bot_memory_vectors WHERE model <> ${embedded.model}`;
                let stored = 0;
                for (const [index, note] of missing.entries()) {
                  const vector = embedded.vectors[index]!;
                  // Only while the note still reads as embedded; an edit meanwhile waits for the next pass.
                  const written = yield* sql<{ readonly id: string }>`
                    INSERT OR REPLACE INTO bot_memory_vectors (scope, id, model, vector)
                    SELECT scope, id, ${embedded.model},
                      ${new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)}
                    FROM bot_memory_notes
                    WHERE scope = ${note.scope} AND id = ${note.id} AND text = ${note.text}
                      AND retired_at IS NULL
                    RETURNING id
                  `;
                  stored += written.length;
                }
                return stored;
              }),
            )
            .pipe(failed("write"));
          if (stored === 0) break;
        }
        return yield* liveVectors;
      }),
    );
  });

  const syncLater = embedder
    ? syncVectors().pipe(
        Effect.catch((cause) => Effect.logWarning("Bot memory vectors failed to sync", { cause })),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    : Effect.void;

  const rows = (scope: MemoryScope, retired = false) =>
    (retired
      ? sql<Row>`SELECT * FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NOT NULL ORDER BY seq`
      : sql<Row>`SELECT * FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NULL ORDER BY seq`
    ).pipe(failed("read"));

  const notes = (scope: MemoryScope) =>
    rows(scope).pipe(Effect.map((found) => found.map((row) => content(toNote(row)))));

  const upsert = (scope: MemoryScope, note: MemoryNote) =>
    sql`
      INSERT INTO bot_memory_notes (
        scope, id, text, status, reason, source_by, thread_id, message_id, quote, at,
        checked_at, until, pinned, search_text
      ) VALUES (
        ${scope}, ${note.id}, ${note.text}, ${note.status}, ${note.reason ?? null},
        ${note.source.by}, ${note.source.threadId ?? null}, ${note.source.messageId ?? null},
        ${note.source.quote ?? null}, ${note.source.at}, ${note.checkedAt ?? null},
        ${note.until ?? null}, ${note.pinned ? PIN[note.pinned] : PIN.none}, ${searchText(note.text)}
      )
      ON CONFLICT (scope, id) DO UPDATE SET
        text = excluded.text, status = excluded.status, reason = excluded.reason,
        source_by = excluded.source_by, thread_id = excluded.thread_id,
        message_id = excluded.message_id, quote = excluded.quote, at = excluded.at,
        checked_at = excluded.checked_at, until = excluded.until, pinned = excluded.pinned,
        search_text = excluded.search_text, retired_at = NULL, superseded_by = NULL
    `;

  const edit = Effect.fn("BotMemoryStore.edit")(function* (
    scope: MemoryScope,
    change: (notes: BotMemory) => BotMemory,
    options?: {
      readonly remove?: "retire" | "delete" | undefined;
      readonly supersededBy?: (() => string | undefined) | undefined;
      readonly forget?: (() => boolean) | undefined;
    },
  ) {
    return yield* lock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* notes(scope);
            const after = change(before);
            if (after === before) return before;
            if (after.length > scopeMax(scope))
              return yield* new BotMemoryError({ operation: "cap" });
            const at = yield* now;
            const supersededBy = options?.supersededBy?.() ?? null;
            const forget = options?.forget?.() ?? false;
            const previous = new Map(before.map((note) => [note.id, fingerprint(note)]));
            const kept = new Set(after.map((note) => note.id));
            for (const note of after) {
              const next = content(note);
              if (previous.get(note.id) !== fingerprint(next)) yield* upsert(scope, next);
            }
            for (const note of before) {
              if (kept.has(note.id)) continue;
              if (options?.remove === "delete" || forget)
                yield* sql`
                  INSERT INTO bot_memory_forgotten (scope, hash, message_id, at)
                  VALUES (${scope}, ${forgetKey(note.text)}, ${note.source.messageId ?? null}, ${at})
                `;
              if (options?.remove === "delete")
                yield* sql`DELETE FROM bot_memory_notes WHERE scope = ${scope} AND id = ${note.id}`;
              else
                yield* sql`
                  UPDATE bot_memory_notes
                  SET retired_at = ${at}, superseded_by = ${supersededBy}, pinned = 0
                  WHERE scope = ${scope} AND id = ${note.id}
                `;
              if (forget)
                yield* sql`DELETE FROM bot_memory_vectors WHERE scope = ${scope} AND id = ${note.id}`;
            }
            return after.map(content);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isMemoryError(cause) ? cause : new BotMemoryError({ operation: "write", cause }),
          ),
          Effect.tap(() => syncLater),
        ),
    );
  });

  const setNote = Effect.fn("BotMemoryStore.setNote")(function* (
    scope: MemoryScope,
    id: string,
    change: { readonly pinned?: boolean | undefined; readonly retired?: boolean | undefined },
  ) {
    const found = yield* sql<Row>`
      SELECT * FROM bot_memory_notes WHERE scope = ${scope} AND id = ${id}
    `.pipe(failed("read"));
    const row = found[0];
    if (!row) return yield* new BotMemoryError({ operation: "missing" });
    if (change.retired === false && row.retired_at !== null) {
      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NULL
      `.pipe(failed("read"));
      if ((live[0]?.count ?? 0) >= scopeMax(scope))
        return yield* new BotMemoryError({ operation: "cap" });
    }
    const at = yield* now;
    const retiredAt =
      change.retired === undefined
        ? row.retired_at
        : change.retired
          ? (row.retired_at ?? at)
          : null;
    // A pin the user sets or clears is theirs; the nightly check leaves it alone.
    const pinned =
      retiredAt !== null
        ? PIN.none
        : change.pinned === undefined
          ? row.pinned
          : change.pinned
            ? PIN.user
            : PIN.none;
    yield* sql`
      UPDATE bot_memory_notes
      SET pinned = ${pinned}, retired_at = ${retiredAt},
        superseded_by = ${retiredAt === null ? null : row.superseded_by}
      WHERE scope = ${scope} AND id = ${id}
    `.pipe(failed("write"));
    if (retiredAt === null && row.retired_at !== null) yield* syncLater;
  });

  const search = Effect.fn("BotMemoryStore.search")(function* (
    scopes: ReadonlyArray<MemoryScope>,
    query: string,
    options: SearchOptions,
  ) {
    if (scopes.length === 0) return [];
    const retired = options.retired === true;
    const match = fts ? ftsQuery(query) : undefined;
    let found: ReadonlyArray<Row> =
      match === undefined
        ? []
        : yield* (
            retired
              ? sql<Row>`
                SELECT n.* FROM bot_memory_notes_fts f JOIN bot_memory_notes n ON n.seq = f.rowid
                WHERE bot_memory_notes_fts MATCH ${match} AND n.scope IN ${sql.in(scopes)}
                  AND n.retired_at IS NOT NULL
                ORDER BY bm25(bot_memory_notes_fts) LIMIT ${CANDIDATES}`
              : sql<Row>`
                SELECT n.* FROM bot_memory_notes_fts f JOIN bot_memory_notes n ON n.seq = f.rowid
                WHERE bot_memory_notes_fts MATCH ${match} AND n.scope IN ${sql.in(scopes)}
                  AND n.retired_at IS NULL
                ORDER BY bm25(bot_memory_notes_fts) LIMIT ${CANDIDATES}`
          ).pipe(failed("read"));
    if (found.length < SCAN_BELOW && (options.scan ?? true))
      found = yield* (
        retired
          ? sql<Row>`SELECT * FROM bot_memory_notes WHERE scope IN ${sql.in(scopes)} AND retired_at IS NOT NULL`
          : sql<Row>`SELECT * FROM bot_memory_notes WHERE scope IN ${sql.in(scopes)} AND retired_at IS NULL`
      ).pipe(failed("read"));
    const since = options.since;
    const lexical = rankNotes(
      found
        .filter((row) => since === undefined || row.at.slice(0, 10) >= since)
        .map((row) => ({ scope: toScope(row.scope), note: toNote(row) })),
      query,
      options,
    );
    const denseMin = options.dense;
    if (denseMin === undefined || !embedder || query.trim() === "") return lexical;
    const embedded = yield* embedder.embed([query.trim().slice(0, QUERY_CHARS)], "query");
    const target = embedded?.vectors[0];
    if (!embedded || !target) return lexical;
    if (behind) {
      behind = false;
      yield* syncLater;
    }
    const near = yield* (
      retired
        ? sql<Row & { readonly vector: Uint8Array }>`
          SELECT n.*, v.vector FROM bot_memory_vectors v
          JOIN bot_memory_notes n ON n.scope = v.scope AND n.id = v.id
          WHERE v.model = ${embedded.model} AND n.scope IN ${sql.in(scopes)}
            AND n.retired_at IS NOT NULL`
        : sql<Row & { readonly vector: Uint8Array }>`
          SELECT n.*, v.vector FROM bot_memory_vectors v
          JOIN bot_memory_notes n ON n.scope = v.scope AND n.id = v.id
          WHERE v.model = ${embedded.model} AND n.scope IN ${sql.in(scopes)}
            AND n.retired_at IS NULL`
    ).pipe(failed("read"));
    const dense = near
      .filter((row) => since === undefined || row.at.slice(0, 10) >= since)
      .map((row) => ({
        entry: { scope: toScope(row.scope), note: toNote(row) },
        similarity: cosine(target, toVector(row.vector)),
      }))
      .filter((found) => found.similarity >= denseMin)
      .toSorted((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit);
    return fuseRanked(lexical, dense, options.limit);
  });

  const count = (scope: MemoryScope, retired: boolean) =>
    (retired
      ? sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NOT NULL`
      : sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NULL`
    ).pipe(
      failed("read"),
      Effect.map((found) => found[0]?.count ?? 0),
    );

  const page = Effect.fn("BotMemoryStore.page")(function* (
    scope: MemoryScope,
    request: {
      readonly query?: string | undefined;
      readonly retired?: boolean | undefined;
      readonly offset: number;
      readonly limit: number;
    },
  ) {
    const retired = request.retired === true;
    const query = request.query?.trim();
    if (query) {
      const ranked = (yield* search([scope], query, {
        limit: scopeMax(scope),
        min: 0,
        now: yield* Clock.currentTimeMillis,
        retired,
      })).filter(({ entry }) => matchesTyped(entry.note.text, query));
      return {
        notes: ranked
          .slice(request.offset, request.offset + request.limit)
          .map(({ entry }) => entry.note),
        total: ranked.length,
      };
    }
    const found = yield* (
      retired
        ? sql<Row>`
          SELECT * FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NOT NULL
          ORDER BY retired_at DESC, seq DESC LIMIT ${request.limit} OFFSET ${request.offset}`
        : sql<Row>`
          SELECT * FROM bot_memory_notes WHERE scope = ${scope} AND retired_at IS NULL
          ORDER BY pinned DESC, at DESC, seq DESC LIMIT ${request.limit} OFFSET ${request.offset}`
    ).pipe(failed("read"));
    return { notes: found.map(toNote), total: yield* count(scope, retired) };
  });

  const importLegacy = Effect.fn("BotMemoryStore.importLegacy")(function* (
    scopes: ReadonlyArray<{ readonly scope: MemoryScope; readonly notes: BotMemory }>,
    at: string,
  ) {
    return yield* lock.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const done = new Set(
              (yield* sql<{ readonly scope: string }>`SELECT scope FROM bot_memory_imports`).map(
                (row) => row.scope,
              ),
            );
            const imported: MemoryScope[] = [];
            for (const { scope, notes: legacy } of scopes) {
              if (done.has(scope)) continue;
              const pins = importPins(legacy, PINNED_CHARS[scopeKind(scope)]);
              for (const note of legacy)
                yield* sql`
                  INSERT OR IGNORE INTO bot_memory_notes (
                    scope, id, text, status, reason, source_by, thread_id, message_id, quote, at,
                    checked_at, pinned, search_text
                  ) VALUES (
                    ${scope}, ${note.id}, ${note.text}, ${note.status}, ${note.reason ?? null},
                    ${note.source.by}, ${note.source.threadId ?? null},
                    ${note.source.messageId ?? null}, ${note.source.quote ?? null},
                    ${note.source.at}, ${note.checkedAt ?? null}, ${pins.has(note.id) ? PIN.auto : PIN.none},
                    ${searchText(note.text)}
                  )`;
              yield* sql`
                INSERT INTO bot_memory_imports (scope, at, notes) VALUES (${scope}, ${at}, ${legacy.length})`;
              imported.push(scope);
            }
            return imported;
          }),
        )
        .pipe(
          failed("write"),
          Effect.tap(() => syncLater),
        ),
    );
  });

  if (embedder)
    yield* syncVectors().pipe(
      Effect.tap((synced) => Effect.logInfo("Bot memory vectors synced", synced)),
      Effect.catch((cause) => Effect.logWarning("Bot memory vectors failed to sync", { cause })),
      Effect.forkIn(scope),
    );

  return BotMemoryStore.of({
    notes,
    edit,
    setNote,
    page,
    core: Effect.fn("BotMemoryStore.core")(function* (scope, today) {
      const found = (yield* rows(scope)).map(toNote);
      return { shown: coreNotes(found, scopeKind(scope), today), total: found.length };
    }),
    search,
    touch: (entries, at) =>
      entries.length === 0
        ? Effect.void
        : sql
            .withTransaction(
              Effect.forEach(
                entries,
                ({ scope, id }) => sql`
                  UPDATE bot_memory_notes SET use_count = use_count + 1, last_used_at = ${at}
                  WHERE scope = ${scope} AND id = ${id}`,
                { discard: true },
              ),
            )
            .pipe(failed("write")),
    counts: sql<{ readonly scope: string; readonly count: number }>`
      SELECT scope, COUNT(*) AS count FROM bot_memory_notes WHERE retired_at IS NULL GROUP BY scope
    `.pipe(
      failed("read"),
      Effect.map((found) => new Map(found.map((row) => [row.scope, row.count]))),
    ),
    forgotten: (scope) =>
      sql<{ readonly hash: string; readonly message_id: string | null }>`
        SELECT hash, message_id FROM bot_memory_forgotten WHERE scope = ${scope}
      `.pipe(
        failed("read"),
        Effect.map((rows) => ({
          hashes: new Set(rows.map((row) => row.hash)),
          messages: new Set(rows.flatMap((row) => (row.message_id ? [row.message_id] : []))),
        })),
      ),
    snapshot: sql<Row>`SELECT * FROM bot_memory_notes ORDER BY scope, seq`.pipe(
      failed("read"),
      Effect.map((rows) =>
        [...Map.groupBy(rows, (row) => row.scope)].map(([scope, found]) => ({
          scope,
          notes: found.map(toNote),
        })),
      ),
    ),
    drop: (scope) =>
      sql
        .withTransaction(
          sql`DELETE FROM bot_memory_notes WHERE scope = ${scope}`.pipe(
            Effect.andThen(sql`DELETE FROM bot_memory_forgotten WHERE scope = ${scope}`),
          ),
        )
        .pipe(failed("write"), Effect.asVoid),
    purgeRetired: (before) =>
      sql<{ readonly id: string }>`
        DELETE FROM bot_memory_notes WHERE retired_at IS NOT NULL AND retired_at < ${before}
        RETURNING id
      `.pipe(
        failed("write"),
        Effect.map((found) => found.length),
      ),
    importLegacy,
    pendingImports: (scopes) =>
      sql<{ readonly scope: string }>`SELECT scope FROM bot_memory_imports`.pipe(
        failed("read"),
        Effect.map((found) => {
          const done = new Set(found.map((row) => row.scope));
          return scopes.filter((scope) => !done.has(scope));
        }),
      ),
    syncVectors: syncVectors(),
  });
});

/** Notes still kept only in `bots.json` are copied on startup after a dated backup of that file; `bots.json` itself is left as it is. */
export const layer = Layer.effect(
  BotMemoryStore,
  Effect.gen(function* () {
    const store = yield* makeMemoryStore.pipe(
      Effect.provideService(MemoryEmbedder, yield* MemoryEmbedder),
    );
    const bots = yield* Store.BotStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const legacy = yield* bots.legacyMemory;
    const scopes = [
      { scope: "you" as const, notes: legacy.you },
      ...legacy.bots.map(({ threadId, notes }) => ({ scope: threadId, notes })),
    ];
    const pending = new Set(yield* store.pendingImports(scopes.map(({ scope }) => scope)));
    if (scopes.some(({ scope, notes }) => pending.has(scope) && notes.length > 0)) {
      const at = yield* DateTime.now;
      const file = path.join(config.stateDir, "bots.json");
      const backup = `${file}.pre-memory-${DateTime.formatIso(at).replaceAll(/[:.]/g, "-")}`;
      yield* fs.copyFile(file, backup);
      const imported = yield* store.importLegacy(
        scopes.filter(({ scope }) => pending.has(scope)),
        DateTime.formatIso(at),
      );
      yield* Effect.logInfo("Bot memory imported from bots.json", {
        backup,
        scopes: imported.length,
        notes: scopes
          .filter(({ scope }) => imported.includes(scope))
          .reduce((sum, { notes }) => sum + notes.length, 0),
      });
    } else if (pending.size > 0) {
      // Scopes without notes, such as bots made since: mark them so a later start skips them.
      yield* store.importLegacy(
        scopes.filter(({ scope }) => pending.has(scope)),
        DateTime.formatIso(yield* DateTime.now),
      );
    }
    return store;
  }),
);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type MemoryNote,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Memory from "./BotMemoryStore.ts";
import * as Store from "./BotStore.ts";
import { forgetKey, legacyNote, MIN_MATCH } from "./memory.ts";
import { MemoryEmbedder } from "./MemoryEmbedder.ts";

const at = "2026-11-01T10:00:00.000Z";
const HOMELAB = ThreadId.make("homelab");
const note = (text: string, id?: string): MemoryNote => ({
  ...legacyNote(text, at),
  ...(id ? { id } : {}),
});
const texts = (notes: ReadonlyArray<MemoryNote>) => notes.map((n) => n.text);
const layerMemory = Layer.effect(Memory.BotMemoryStore, Memory.makeMemoryStore).pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const TOPICS = [
  ["sister", "сестр"],
  ["prague", "праг"],
  ["backup", "бэкап"],
  ["night", "ноч"],
];
const fakeEmbedder = () => {
  const state = {
    up: true,
    embedded: [] as string[],
    gate: undefined as
      | { readonly started: Deferred.Deferred<void>; readonly open: Deferred.Deferred<void> }
      | undefined,
  };
  const layer = Layer.succeed(MemoryEmbedder, {
    embed: (texts) =>
      Effect.gen(function* () {
        const gate = state.gate;
        state.gate = undefined;
        if (gate) {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.open);
        }
        if (!state.up) return undefined;
        state.embedded.push(...texts);
        return {
          model: "fake",
          vectors: texts.map((text) =>
            Float32Array.from(
              TOPICS.map((words) => (words.some((w) => text.toLowerCase().includes(w)) ? 1 : 0)),
            ),
          ),
        };
      }),
  });
  return { state, layer };
};
const layerHybrid = (embedder: Layer.Layer<MemoryEmbedder>) =>
  Layer.effect(Memory.BotMemoryStore, Memory.makeMemoryStore).pipe(
    Layer.provide(embedder),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

it.effect(
  "imports bots.json notes once, ids kept, pinning what every turn carried, after a backup",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      const own = [
        ...[1, 2, 3, 4, 5].map((n) => note(`${n}${"x".repeat(298)}`, `b${n}`)),
        note("Short.", "b6"),
      ];
      yield* fs.writeFileString(
        `${config.stateDir}/bots.json`,
        JSON.stringify({
          bots: [
            {
              name: "Homelab",
              persona: "Watches hosts.",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
              dailyTokenCap: 1000,
              threadId: HOMELAB,
              projectId: ProjectId.make("bots"),
              createdAt: at,
              unread: false,
              lastNotification: null,
              notifiedAt: null,
              memory: own,
            },
          ],
          owners: {},
          usage: {},
          messages: {},
          userMemory: [note("Metric units.", "u1")],
        }),
      );
      const database = NodeSqliteClient.layer({ filename: `${config.stateDir}/state.sqlite` });
      const layerStore = Memory.layer.pipe(
        Layer.provide(Layer.mergeAll(database, Store.layer, fakeEmbedder().layer)),
      );
      const start = Effect.gen(function* () {
        const memory = yield* Memory.BotMemoryStore;
        return {
          you: yield* memory.notes("you"),
          own: yield* memory.notes(HOMELAB),
          core: yield* memory.core(HOMELAB, at),
          vectors: yield* memory.syncVectors,
        };
      }).pipe(Effect.provide(layerStore));

      const first = yield* start;
      assert.deepEqual(
        first.own.map((n) => [n.id, n.pinned ?? false]),
        [
          ["b1", "auto"],
          ["b2", "auto"],
          ["b3", "auto"],
          ["b4", "auto"],
          ["b5", false],
          ["b6", false],
        ],
      );
      assert.deepEqual(
        first.you.map((n) => [n.id, n.text]),
        [["u1", "Metric units."]],
      );
      assert.deepEqual(first.vectors, { notes: 7, vectors: 7 });
      const backups = (yield* fs.readDirectory(config.stateDir)).filter((name) =>
        name.startsWith("bots.json.pre-memory-"),
      );
      assert.lengthOf(backups, 1);

      yield* Effect.gen(function* () {
        const memory = yield* Memory.BotMemoryStore;
        yield* memory.edit("you", () => [], { remove: "delete" });
      }).pipe(Effect.provide(layerStore));
      const second = yield* start;
      assert.deepEqual(second.you, []);
      assert.deepEqual(texts(second.own), texts(first.own));
      assert.lengthOf(
        (yield* fs.readDirectory(config.stateDir)).filter((name) =>
          name.startsWith("bots.json.pre-memory-"),
        ),
        1,
      );
      assert.include(yield* fs.readFileString(`${config.stateDir}/bots.json`), "Metric units.");
    }).pipe(
      Effect.provide(
        Config.layerTest(process.cwd(), { prefix: "bot-memory-import-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "retires what a change leaves out, deletes what the user forgets, and restores a note that comes back",
  () =>
    Effect.gen(function* () {
      const memory = yield* Memory.BotMemoryStore;
      const gamma = note("Gamma.", "c");
      const [a, b, c] = [
        note("Alpha.", "a"),
        note("Beta.", "b"),
        { ...gamma, source: { ...gamma.source, messageId: MessageId.make("m-c") } },
      ];
      yield* memory.edit(HOMELAB, () => [a, b, c]);
      yield* memory.edit(HOMELAB, (notes) => notes.filter((n) => n.id !== "b"), {
        supersededBy: () => "c",
      });
      yield* memory.edit(HOMELAB, (notes) => notes.filter((n) => n.id !== "c"), {
        remove: "delete",
      });
      assert.deepEqual(texts(yield* memory.notes(HOMELAB)), ["Alpha."]);
      const forgotten = yield* memory.forgotten(HOMELAB);
      assert.deepEqual([...forgotten.hashes], [forgetKey("Gamma.")]);
      assert.deepEqual([...forgotten.messages], ["m-c"]);
      const retired = yield* memory.page(HOMELAB, { retired: true, offset: 0, limit: 10 });
      assert.deepEqual(
        retired.notes.map((n) => [n.id, n.supersededBy]),
        [["b", "c"]],
      );
      yield* memory.edit(HOMELAB, (notes) => [...notes, b]);
      assert.deepEqual(texts(yield* memory.notes(HOMELAB)), ["Alpha.", "Beta."]);

      yield* memory.setNote(HOMELAB, "b", { pinned: true });
      const page = yield* memory.page(HOMELAB, { offset: 0, limit: 10 });
      assert.deepEqual(
        page.notes.map((n) => [n.id, n.pinned ?? false]),
        [
          ["b", "user"],
          ["a", false],
        ],
      );
      yield* memory.setNote(HOMELAB, "b", { retired: true });
      assert.deepEqual(texts(yield* memory.notes(HOMELAB)), ["Alpha."]);
      yield* memory.setNote(HOMELAB, "b", { retired: false });
      assert.deepEqual(
        (yield* memory.notes(HOMELAB)).map((n) => [n.id, n.pinned ?? false]),
        [
          ["a", false],
          ["b", false],
        ],
      );
      assert.equal(
        (yield* Effect.flip(memory.setNote(HOMELAB, "zz", { pinned: true }))).operation,
        "missing",
      );
    }).pipe(Effect.provide(layerMemory)),
);

it.effect("finds notes through the index with ё, й and endings folded", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    yield* memory.edit("you", () => [
      note("Ёжик живёт в Харькове."),
      note("Купить йогурт и сыр."),
      note("Backups run at night."),
    ]);
    const found = (query: string) =>
      memory
        .search(["you"], query, { limit: 5, min: MIN_MATCH, now: Date.parse(at), scan: false })
        .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.text)));
    assert.deepEqual(yield* found("ежик"), ["Ёжик живёт в Харькове."]);
    assert.deepEqual(yield* found("харьков"), ["Ёжик живёт в Харькове."]);
    assert.deepEqual(yield* found("иогурт"), ["Купить йогурт и сыр."]);
    assert.deepEqual(yield* found("kubernetes"), []);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("refuses to hold more notes than the scope's cap", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    const many = Array.from({ length: 501 }, (_, i) => note(`Note ${i}.`, `n${i}`));
    const error = yield* Effect.flip(memory.edit(HOMELAB, () => many));
    assert.equal(error.operation, "cap");
    yield* memory.edit("you", () => many);
    assert.lengthOf(yield* memory.notes("you"), 501);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect(
  "fuses the notes near the query's vector with the word ranking, words alone without it",
  () => {
    const embedder = fakeEmbedder();
    return Effect.gen(function* () {
      const memory = yield* Memory.BotMemoryStore;
      yield* memory.edit("you", () => [
        note("Моя сестра живёт в Праге.", "n1"),
        note("Backups run at night.", "n2"),
      ]);
      yield* memory.edit(HOMELAB, () => [note("Сестра соседа живёт в Праге.", "h1")]);
      const found = (query: string, dense?: number) =>
        memory
          .search(["you"], query, {
            limit: 5,
            min: MIN_MATCH,
            now: Date.parse(at),
            scan: false,
            dense,
          })
          .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.id)));
      yield* memory.syncVectors;
      assert.deepEqual(yield* found("where does my sister live?", 0.5), ["n1"]);
      assert.deepEqual(yield* found("backups at night", 0.5), ["n2"]);
      assert.deepEqual(yield* found("where does my sister live?"), []);
      yield* memory.setNote("you", "n1", { retired: true });
      assert.deepEqual(yield* found("where does my sister live?", 0.5), []);
      embedder.state.up = false;
      assert.deepEqual(yield* found("backups at night", 0.5), ["n2"]);
    }).pipe(Effect.provide(layerHybrid(embedder.layer)));
  },
);

it.effect("never keeps a vector for text that changed while it was embedded", () => {
  const embedder = fakeEmbedder();
  return Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    const gate = { started: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    embedder.state.gate = gate;
    yield* memory.edit("you", () => [note("Sister in Prague.", "n1")]);
    yield* Deferred.await(gate.started);
    yield* memory.edit("you", (notes) => notes.map((n) => ({ ...n, text: "Backups at night." })));
    yield* Deferred.succeed(gate.open, undefined);
    assert.deepEqual(yield* memory.syncVectors, { notes: 1, vectors: 1 });
    const nearest = (query: string) =>
      memory
        .search(["you"], query, { limit: 5, min: 2, now: Date.parse(at), scan: false, dense: 0.5 })
        .pipe(Effect.map((ranked) => ranked.map(({ entry }) => entry.note.id)));
    assert.deepEqual(yield* nearest("sister"), []);
    assert.deepEqual(yield* nearest("backups at night"), ["n1"]);
  }).pipe(Effect.provide(layerHybrid(embedder.layer)));
});

it.effect("keeps a vector per live note: backfilled, re-made on edit, dropped on forget", () => {
  const embedder = fakeEmbedder();
  return Effect.gen(function* () {
    const memory = yield* Memory.BotMemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const stored = sql<{ readonly id: string }>`SELECT id FROM bot_memory_vectors ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
    );
    embedder.state.up = false;
    yield* memory.edit("you", () => [note("Sister in Prague.", "n1"), note("Backups.", "n2")]);
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 0 });
    embedder.state.up = true;
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 2 });

    yield* memory.edit("you", (notes) =>
      notes.map((n) => (n.id === "n1" ? { ...n, text: "Sister moved to Brno." } : n)),
    );
    assert.deepEqual(yield* memory.syncVectors, { notes: 2, vectors: 2 });
    assert.include(embedder.state.embedded, "Sister moved to Brno.");

    yield* memory.edit("you", (notes) => notes.filter((n) => n.id !== "n2"), {
      forget: () => true,
    });
    assert.deepEqual(yield* stored, ["n1"]);
    const embeds = embedder.state.embedded.length;
    assert.deepEqual(yield* memory.syncVectors, { notes: 1, vectors: 1 });
    assert.equal(embedder.state.embedded.length, embeds);

    yield* memory.edit("you", () => [], { remove: "delete" });
    assert.deepEqual(yield* stored, []);
  }).pipe(Effect.provide(layerHybrid(embedder.layer)));
});

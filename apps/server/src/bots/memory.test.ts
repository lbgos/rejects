import { assert, describe, it } from "@effect/vitest";
import type { MemoryNote } from "@t3tools/contracts";
import * as Result from "effect/Result";
import {
  changeMemory,
  coreNotes,
  fuseRanked,
  importPins,
  legacyNote,
  memoryIndex,
  memorySearchResult,
  MIN_MATCH,
  quotes,
  looksSecret,
  RECALL_MIN,
  matchesTyped,
  rankNotes,
  recallQueries,
} from "./memory.ts";

const at = "2026-11-07T10:00:00.000Z";
const source = { by: "Homelab", at };
const memory = [
  legacyNote("Security: at most 2 items.", at),
  legacyNote("Skip Proxmox 9.1 news.", at),
];
const texts = (notes: ReadonlyArray<MemoryNote>) => notes.map((note) => note.text);

describe("changeMemory", () => {
  it.each([
    {
      name: "appends one note per entry and skips repeats",
      change: { add: ["More  AI\nagents.", "skip proxmox 9.1 news."] },
      expected: [...texts(memory), "More AI agents."],
    },
    {
      name: "removes the note containing a fragment",
      change: { remove: ["proxmox"], add: ["Proxmox only for 9.2+."] },
      expected: ["Security: at most 2 items.", "Proxmox only for 9.2+."],
    },
    {
      name: "removes a note by id",
      change: { remove: [memory[0]!.id] },
      expected: ["Skip Proxmox 9.1 news."],
    },
    {
      name: "removes a note copied with a list bullet or a leading date",
      change: { remove: ["- [2026-11-07] Skip  Proxmox 9.1 news.", "- Security: at most 2"] },
      expected: [],
    },
    {
      name: "takes one bare string as one note",
      change: { add: "More AI agents.", remove: "proxmox" },
      expected: ["Security: at most 2 items.", "More AI agents."],
    },
    {
      name: "keeps a note of a few sentences",
      change: { add: ["y".repeat(475)] },
      expected: [...texts(memory), "y".repeat(475)],
    },
    { name: "refuses a fragment that matches nothing", change: { remove: ["zfs"] }, error: "zfs" },
    { name: "refuses an ambiguous fragment", change: { remove: ["s"] }, error: "matches 2" },
    {
      name: "refuses to grow past the limit",
      change: { add: Array.from({ length: 99 }, (_, i) => `note ${i}`) },
      error: "at most 100",
    },
    {
      name: "refuses an overlong note, naming it and how to retry",
      change: { add: ["ok", "x".repeat(501)] },
      error: "Note 2 has 501 characters; a note holds at most 500",
    },
    {
      name: "refuses a card number",
      change: { add: ["Card 4111 1111 1111 1111 for the shop."] },
      error: "card numbers",
    },
    {
      name: "refuses a labelled password",
      change: { add: ["Router password: hunter22"] },
      error: "passwords",
    },
    {
      name: "refuses a key-like token",
      change: { add: ["Use sk-proj-9fA3kLmN0pQrStUvWxYz1234567890abcd for it."] },
      error: "keys",
    },
    {
      name: "keeps a phone-length number that is not a card",
      change: { add: ["Dentist: +380 44 123 4567."] },
      expected: [...texts(memory), "Dentist: +380 44 123 4567."],
    },
    { name: "refuses an end date that is not a date", change: { until: "soon" }, error: "until" },
  ])("$name", ({ change, expected, error }) => {
    const result = changeMemory(memory, change, source, 100);
    if (error) assert.include(Result.isFailure(result) ? result.failure : "", error);
    else
      assert.deepEqual(
        Result.isSuccess(result) ? texts(result.success.notes) : undefined,
        expected,
      );
  });

  it("gives new notes the change's source and end date", () => {
    const result = changeMemory(
      [],
      { add: ["In Lisbon this week."], until: "2026-11-14" },
      source,
      100,
    );
    const added = Result.isSuccess(result) ? result.success.added[0] : undefined;
    assert.deepEqual(added?.source, source);
    assert.equal(added?.until, "2026-11-14");
  });
});

describe("quotes", () => {
  it.each([
    ["exact words", "Use metric units please", "metric units", true],
    ["case, quote marks and spacing", "Call me “Lev”,  ok?", 'call me "lev", ok', true],
    [
      "parts around an ellipsis, in order",
      "I like tea. Also: never call after 9pm.",
      "I like tea … after 9pm",
      true,
    ],
    [
      "parts out of order",
      "I like tea. Also: never call after 9pm.",
      "after 9pm … I like tea",
      false,
    ],
    ["words the user never wrote", "Use metric units please", "imperial units", false],
    ["an empty quote", "Use metric units please", " … ", false],
  ])("%s", (_name, text, quote, expected) => {
    assert.equal(quotes(text, quote), expected);
  });
});

describe("core notes", () => {
  const today = "2026-11-08T00:00:00.000Z";
  const note = (text: string, extra: Partial<MemoryNote> = {}): MemoryNote => ({
    ...legacyNote(text, extra.source?.at ?? at),
    ...extra,
  });

  it("pins what the old budget showed and shows it the same way", () => {
    const notes = [
      note("Answers in Ukrainian."),
      note("Lives in Kyiv.", { status: "contradicted" }),
      note("Uses metric units."),
      note("Has a NAS at 10.0.0.12."),
    ];
    const pins = importPins(notes, 45);
    const pinned = notes.map((n) => (pins.has(n.id) ? { ...n, pinned: "auto" as const } : n));
    const shown = coreNotes(pinned, "bot", today).filter((n) => n.pinned);
    assert.equal(
      memoryIndex(shown, notes.length),
      "- Answers in Ukrainian.\n- Uses metric units.\n(2 more notes: memory_search finds them)",
    );
    assert.equal(memoryIndex([], 0), "empty");
  });

  it("puts pinned notes first, then the most used and newest, skipping what does not fit", () => {
    const long = "x".repeat(299);
    const notes = [
      note("Old and unused.", { source: { by: "user", at: "2026-01-01T00:00:00.000Z" } }),
      note("Pinned rule.", { pinned: "user" }),
      note(long, { useCount: 9 }),
      note("Used a lot.", { useCount: 5 }),
      note("Recent.", { source: { by: "user", at: "2026-11-06T00:00:00.000Z" } }),
      note("Ended trip.", { until: "2026-11-01" }),
      note("Gone.", { retiredAt: at }),
    ];
    assert.deepEqual(texts(coreNotes(notes, "bot", today)), [
      "Pinned rule.",
      long,
      "Used a lot.",
      "Recent.",
      "Old and unused.",
    ]);
    const crowded = [
      ...Array.from({ length: 3 }, (_, i) => note(`${i}${long.slice(1)}`, { useCount: 9 })),
      ...notes,
    ];
    const shown = texts(coreNotes(crowded, "bot", today));
    assert.equal(shown.filter((text) => text.length > 250).length, 3);
    assert.deepEqual(
      shown.filter((text) => text.length < 250),
      ["Pinned rule.", "Used a lot.", "Recent.", "Old and unused."],
    );
  });
});

describe("rankNotes", () => {
  const now = Date.parse("2026-11-08T00:00:00.000Z");
  const entries = [
    {
      scope: "bot" as const,
      note: { ...legacyNote("Old NAS at 10.0.0.9.", at), status: "stale" as const },
    },
    { scope: "bot" as const, note: legacyNote("NAS at 10.0.0.12 runs TrueNAS.", at) },
    { scope: "you" as const, note: legacyNote("Prefers short answers.", at) },
    { scope: "you" as const, note: legacyNote("Дружина Оксана, день народження 12 травня.", at) },
  ];
  it.each([
    [
      "ranks fresh matches before stale ones",
      "nas",
      ["NAS at 10.0.0.12 runs TrueNAS.", "Old NAS at 10.0.0.9."],
    ],
    ["finds a typo", "truenaz", ["NAS at 10.0.0.12 runs TrueNAS.", "Old NAS at 10.0.0.9."]],
    [
      "finds another ending",
      "день народження Оксани",
      ["Дружина Оксана, день народження 12 травня."],
    ],
    ["finds nothing for unrelated words", "kubernetes cluster", []],
  ])("%s", (_name, query, expected) => {
    const ranked = rankNotes(entries, query, { limit: 5, min: MIN_MATCH, now });
    assert.deepEqual(
      memorySearchResult(ranked).notes.map((note) => note.text),
      expected,
    );
  });

  it.each([
    ["a whole word", "Ada", "Ada eats no mushrooms", true],
    ["the start of a word", "mush", "Leo does not eat mushrooms", true],
    ["a typo", "mushroms", "Leo does not eat mushrooms", true],
    ["another ending", "Оксани", "Дружина Оксана, день народження 12 травня.", true],
    ["a word that only shares letters", "Ada", "Packed lunches on school days", false],
    ["repeated letters", "zzzz", "Friday is pizza night.", false],
    ["one word of two", "Ada pizza", "Ada eats no mushrooms", false],
  ])("a typed search matches %s: %s", (_name, query, text, expected) => {
    assert.equal(matchesTyped(text, query), expected);
  });

  it("lifts a recent, often-used note among equal matches", () => {
    const old = legacyNote("Gym on Monday.", "2026-01-01T00:00:00.000Z");
    const used = { ...legacyNote("Gym on Thursday.", "2026-01-01T00:00:00.000Z"), useCount: 10 };
    const ranked = rankNotes([{ note: old }, { note: used }], "gym", {
      limit: 2,
      min: MIN_MATCH,
      now,
    });
    assert.deepEqual(
      ranked.map(({ entry }) => entry.note.text),
      ["Gym on Thursday.", "Gym on Monday."],
    );
  });
});

describe("fuseRanked", () => {
  it("puts notes both rankings found first, fresh notes before the others", () => {
    const entry = (id: string, status: MemoryNote["status"] = "fresh") => ({
      scope: "you",
      note: { ...legacyNote(id, at), id, status },
    });
    const [a, b, c, d] = [entry("a"), entry("b"), entry("c"), entry("d", "stale")];
    const fused = fuseRanked(
      [a, b, d].map((found) => ({ entry: found, relevance: 0.5, score: 1 })),
      [d, b, c].map((found) => ({ entry: found, similarity: 0.9 })),
      3,
    );
    assert.deepEqual(
      fused.map(({ entry, relevance }) => [entry.note.id, relevance]),
      [
        ["b", 0.5],
        ["a", 0.5],
        ["c", 0.9],
      ],
    );
  });

  it("keeps a note that matches nearly every query word ahead of what the vectors add", () => {
    const entry = (id: string) => ({ scope: "you", note: { ...legacyNote(id, at), id } });
    const [exact, weak, near] = [entry("exact"), entry("weak"), entry("near")];
    const fused = fuseRanked(
      [
        { entry: exact, relevance: 0.95, score: 1 },
        { entry: weak, relevance: 0.5, score: 0.6 },
      ],
      [near, weak].map((found) => ({ entry: found, similarity: 0.85 })),
      3,
    );
    assert.deepEqual(
      fused.map(({ entry }) => entry.note.id),
      ["exact", "weak", "near"],
    );
  });
});

describe("looksSecret", () => {
  it.each([
    ["password: hunter2", true],
    ["пароль: hunter2", true],
    ["Пароль = abc123", true],
    ["токен: ghp_abcdefg1234", true],
    ["пин-код: 1234", true],
    ["пін-код: 1234", true],
    ["Пароль від роутера: qwerty12", true],
    ["Пароль від роутера лежить у Vaultwarden.", false],
    ["Mapping pin 4 to GPIO.", false],
  ])("%s", (text, secret) => {
    assert.equal(looksSecret(text), secret);
  });
});

describe("recallQueries", () => {
  it.each([
    ["a follow-up leans on the reply's end", "the second one", "Pick: 1) Lisbon 2) Porto", 2],
    [
      "a message that names its topic stands alone",
      "Сколько памяти на сервере node1 сейчас?",
      "Done.",
      1,
    ],
    ["an acknowledgement", "Спасибо!", "Done.", 0],
    ["only short words", "ok, at 9", undefined, 0],
  ])("%s", (_name, message, reply, count) => {
    const queries = recallQueries(message, reply);
    assert.lengthOf(queries, count);
    if (count === 2) assert.deepEqual(queries, [message, reply]);
  });
});

describe("recall relevance", () => {
  const now = Date.parse("2026-11-08T00:00:00.000Z");
  const sister = { note: legacyNote("Сестра живет в Харькове, зовут Оля.", at) };
  const reply =
    "Готово: напоминание на завтра в 9:00 поставил, список покупок обновил, а бэкап NAS прошёл без ошибок. Если нужно, могу ещё проверить погоду на выходные и пробки по дороге.";
  const best = (queries: ReadonlyArray<string>) =>
    Math.max(
      0,
      ...queries.map(
        (query) => rankNotes([sister], query, { limit: 5, min: 0, now })[0]?.relevance ?? 0,
      ),
    );

  it("scores the message on its own when the bot's last reply is long", () => {
    assert.isAtLeast(best(recallQueries("Где живет сестра?", reply)), RECALL_MIN);
  });

  it("bounds a pasted wall of text to a few hundred characters of query", () => {
    const pasted = Array.from({ length: 20_000 }, (_, i) => `слово${i}`).join(" ");
    assert.isAtMost(recallQueries(pasted)[0]!.length, 400);
  });
});

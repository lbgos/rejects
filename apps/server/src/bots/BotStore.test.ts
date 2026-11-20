import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BOT_KICKOFF_MESSAGE_PREFIX,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Store from "./BotStore.ts";
import { writeOwnSkill } from "./skills.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";
const bot = (name: string): BotRecord => ({
  name,
  persona: `Report ${name}`,
  modelSelection: {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "opencode-go/deepseek-v4.1-flash",
  },
  dailyTokenCap: 100,
  threadId: ThreadId.make(name),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-10-26T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
});
const layer = Store.layer.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "bots-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "charges cumulative usage once, includes workers, blocks at the cap and resets next day",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.BotStore;
      const news = bot("news");
      yield* store.put(news);
      const child = ThreadId.make("worker");
      yield* store.inherit({
        id: child,
        lineage: {
          parentThreadId: news.threadId,
          rootThreadId: news.threadId,
          relationshipToParent: "subagent",
        },
      });
      assert.isFalse(yield* store.charge(news.threadId, "turn-a", 30));
      assert.isFalse(yield* store.charge(news.threadId, "turn-a", 20));
      assert.isFalse(yield* store.charge(child, "turn-b", 60));
      assert.equal((yield* store.list)[0]?.tokensToday, 90);
      assert.isTrue(yield* store.charge(child, "turn-b", 70));
      assert.isFalse(yield* store.charge(child, "turn-b", 70));
      assert.equal((yield* Effect.flip(store.assertBudget(news.threadId))).operation, "cap");
      assert.equal((yield* Effect.flip(store.assertBudget(child))).operation, "cap");
      yield* TestClock.adjust("24 hours");
      yield* store.assertBudget(child);
      assert.equal((yield* store.list)[0]?.tokensToday, 0);
    }).pipe(Effect.provide(layer)),
);
it.effect("charges an estimate, not the whole cap, for a turn that ends without usage", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const news = { ...bot("news"), dailyTokenCap: 3 * Store.UNREPORTED_TURN_TOKENS + 1_000 };
    yield* store.put(news);
    assert.isFalse(yield* store.charge(news.threadId, "stopped", 0));
    assert.isFalse(yield* store.charge(news.threadId, "stopped", 0, { ended: true }));
    assert.isFalse(yield* store.charge(news.threadId, "stopped", 0, { ended: true }));
    yield* store.assertBudget(news.threadId);
    assert.isFalse(yield* store.charge(news.threadId, "answered", 1_200));
    assert.isFalse(yield* store.charge(news.threadId, "answered", 0, { ended: true }));
    const [summary] = yield* store.list;
    assert.equal(summary?.tokensToday, Store.UNREPORTED_TURN_TOKENS + 1_200);
    assert.isFalse(summary?.stopped);
    assert.isNull(summary?.resumesAt);
    assert.isFalse(yield* store.charge(news.threadId, "silent-1", 0, { ended: true }));
    assert.isTrue(yield* store.charge(news.threadId, "silent-2", 0, { ended: true }));
    assert.equal((yield* Effect.flip(store.assertBudget(news.threadId))).operation, "cap");
    const capped = (yield* store.list)[0];
    assert.isTrue(capped?.stopped);
    assert.equal(capped?.resumesAt, "1970-01-02T00:00:00.000Z");
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "atomically caps concurrent bot messages, deduplicates retries, and expires the window",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.BotStore;
      const news = bot("news"),
        ops = bot("ops");
      yield* store.put(news);
      yield* store.put(ops);
      const result = yield* Effect.forEach(
        Array.from({ length: 25 }, (_, i) => i),
        (i) => store.message(news.threadId, ops.threadId, `msg:${i}`),
        { concurrency: "unbounded" },
      );
      assert.equal(result.filter(Boolean).length, Store.MESSAGES_PER_HOUR);
      assert.isTrue(yield* store.message(news.threadId, ops.threadId, "msg:0"));
      assert.isFalse(yield* store.message(news.threadId, ops.threadId, "another"));
      assert.equal((yield* Effect.flip(store.assertBudget(news.threadId))).operation, "rate");
      assert.isTrue((yield* store.list).find((b) => b.threadId === news.threadId)?.stopped);
      yield* TestClock.adjust("1 hour");
      assert.isTrue(yield* store.message(news.threadId, ops.threadId, "another"));
    }).pipe(Effect.provide(layer)),
);
it.effect("adds the music rules to a bot the owner gives the skill", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const homelab = { ...bot("homelab"), skills: ["music" as const] };
    yield* store.put(homelab);
    yield* store.put(bot("news"));
    yield* store.put({ ...bot("tunes"), kind: "music" as const });
    const skilled = (yield* store.persona(homelab.threadId))!;
    assert.include(skilled, "Report homelab");
    assert.include(skilled, "use skill music.");
    assert.include(skilled, "[Wake: music]");
    const unskilled = (yield* store.persona(ThreadId.make("news")))!;
    assert.notInclude(unskilled, "use skill music");
    assert.notInclude(unskilled, "[Wake: music]");
    const news = (yield* store.persona(ThreadId.make("news")))!;
    // A web bot asks its peers itself; hand_off is left for work the user wants from that bot.
    assert.include(news, "t3_thread_send the question to its chat");
    assert.include(news, "Use hand_off instead, never as well");
    assert.notInclude(news, "reaches other bots");
    const music = (yield* store.persona(ThreadId.make("tunes")))!;
    assert.include(music, "You only download albums");
    assert.notInclude(music, "You have a computer");
  }).pipe(Effect.provide(layer)),
);
it.effect("names in a bot's prompt only the tools it gets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir } = yield* Config.ServerConfig;
    const store = yield* Store.BotStore;
    const own = writeOwnSkill(
      [],
      { name: "recap", description: "When asked for a recap", body: "1. Sum up." },
      "2026-11-11T10:00:00.000Z",
    );
    if (!own.ok) return assert.fail(own.error);
    const fable = { ...bot("fable"), standalone: true as const, ownSkills: own.skills };
    yield* store.put(bot("news"));
    yield* store.put(bot("ops"));
    yield* store.put(fable);
    // A standalone bot holds no read_skill: its prompt carries the video skill and no index.
    const alone = (yield* store.persona(fable.threadId))!;
    assert.notInclude(alone, "read_skill");
    assert.notMatch(alone, /web_browse|computer_shell|\btab\b/u);
    assert.include(alone, "Call video_transcript with the link before you answer.");
    const listed = { ...bot("listed"), standalone: true as const, tools: ["web_search"] };
    yield* store.put(listed);
    assert.notInclude((yield* store.persona(listed.threadId))!, "video_transcript");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      `${stateDir}/camofox.json`,
      JSON.stringify({ url: "http://camofox.test", accessKey: "k", bots: ["news"] }),
    );
    assert.include((yield* store.persona(ThreadId.make("news")))!, "call web_search first");
    for (const id of ["ops", "fable"]) {
      const prompt = (yield* store.persona(ThreadId.make(id)))!;
      assert.notInclude(prompt, "web_search");
      assert.notInclude(prompt, "web_browse");
    }
  }).pipe(Effect.provide(layer)),
);
it.effect("keeps notification unread until that version is opened and injects the roster", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const news = bot("news"),
      ops = { ...bot("ops"), description: "Watches hosts" };
    yield* store.put(news);
    yield* store.put(ops);
    yield* store.recordStop(news.threadId, "Cap reached");
    assert.isNull((yield* store.get(news.threadId))?.notifiedAt);
    assert.isFalse((yield* store.get(news.threadId))?.unread);
    const first = yield* store.notify(news.threadId, "First");
    yield* TestClock.adjust("1 second");
    yield* store.notify(news.threadId, "Second");
    yield* store.markRead(news.threadId, first.notifiedAt);
    assert.isTrue((yield* store.get(news.threadId))?.unread);
    const current = yield* store.get(news.threadId);
    yield* store.markRead(news.threadId, current!.notifiedAt);
    assert.isFalse((yield* store.get(news.threadId))?.unread);
    assert.include((yield* store.persona(news.threadId))!, "ops (thread ops): Watches hosts");
    assert.include((yield* store.persona(news.threadId))!, "Report news");
    // A standalone bot is in no roster, and its prompt has none, nor memory or shared notes.
    const fable = { ...bot("fable"), standalone: true as const };
    yield* store.put(fable);
    assert.notInclude((yield* store.persona(news.threadId))!, "Report fable");
    const alone = (yield* store.persona(fable.threadId))!;
    assert.include(alone, "Report fable");
    assert.include(alone, "call web_search first");
    for (const other of [
      "Other bots",
      "Report news",
      "Report ops",
      "update_memory",
      "memory_search",
      "hand_off",
    ])
      assert.notInclude(alone, other);
    yield* store.markUnread(news.threadId);
    assert.isTrue((yield* store.get(news.threadId))?.unread);
    const stale = (yield* store.get(news.threadId))!;
    yield* store.notify(news.threadId, "Third");
    yield* store.edit(news.threadId, (b) => ({ ...b, dailyTokenCap: stale.dailyTokenCap * 2 }));
    assert.include(yield* store.get(news.threadId), { lastNotification: "Third", unread: true });
    assert.equal(
      (yield* Effect.flip(store.edit(news.threadId, (b) => ({ ...b, name: "ops" })))).operation,
      "duplicate",
    );
    assert.equal((yield* store.named(" OPS "))?.threadId, ops.threadId);
    assert.equal((yield* store.named(ops.threadId))?.threadId, ops.threadId);
    assert.isUndefined(yield* store.named("op"));
    assert.isTrue(yield* store.claimAlert("cap:news"));
    assert.isFalse(yield* store.claimAlert("cap:news"));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps the first valid device zone as spelled, until Settings changes it to a valid one",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.BotStore;
      const news = bot("news");
      yield* store.put(news);
      yield* store.seedTimeZone("Not/AZone");
      // Kept as the device spells it, though Node's Intl resolves it to Europe/Kiev.
      yield* store.seedTimeZone("Europe/Kyiv");
      yield* store.seedTimeZone("America/New_York");
      assert.equal((yield* store.preferences).timeZone, "Europe/Kyiv");
      assert.equal(yield* store.timeZone, "Europe/Kyiv");
      assert.include(
        (yield* store.persona(news.threadId))!,
        "Schedules wake you, at least 5 minutes apart, in Europe/Kyiv.",
      );
      assert.equal(
        (yield* Effect.flip(store.setPreferences({ timeZone: "Not/AZone" }))).operation,
        "zone",
      );
      assert.equal(yield* store.timeZone, "Europe/Kyiv");
      assert.equal(
        (yield* store.setPreferences({ timeZone: "America/New_York" })).timeZone,
        "America/New_York",
      );
      yield* store.seedTimeZone("Europe/Kyiv");
      assert.equal(yield* store.timeZone, "America/New_York");
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps a deleted steward deleted and falls back to the main bot", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const steward = { ...bot("Steward"), threadId: STEWARD_THREAD_ID };
    const main = bot("Main");
    yield* store.put(steward);
    yield* store.put(main);
    yield* store.setMainBot(main.threadId);
    assert.isFalse(yield* store.stewardRemoved);
    assert.equal((yield* Store.standingBot(store))?.threadId, STEWARD_THREAD_ID);
    yield* store.remove(STEWARD_THREAD_ID);
    assert.equal((yield* Store.standingBot(store))?.threadId, main.threadId);
    const restored = yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* Store.BotStore;
        return { removed: yield* fresh.stewardRemoved, main: yield* fresh.mainBot };
      }).pipe(Effect.provide(Layer.fresh(Store.layer))),
    );
    assert.deepEqual(restored, { removed: true, main: main.threadId });
  }).pipe(Effect.provide(layer)),
);

it.effect("persists the steward cursor and dedupe keys and limits delivery to 20 per hour", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    assert.isUndefined(yield* store.stewardCursor);
    yield* store.stewardHandled(10);
    for (let i = 0; i < Store.MESSAGES_PER_HOUR; i++) {
      assert.equal(yield* store.stewardDelivery(`request:${i}`), "ready");
      yield* store.stewardHandled(11 + i, `request:${i}`);
    }
    assert.equal(yield* store.stewardDelivery("request:0"), "duplicate");
    assert.equal(yield* store.stewardDelivery("new"), "limited");
    const restored = yield* Effect.scoped(
      Effect.gen(function* () {
        const fresh = yield* Store.BotStore;
        return {
          cursor: yield* fresh.stewardCursor,
          status: yield* fresh.stewardDelivery("request:0"),
        };
      }).pipe(Effect.provide(Layer.fresh(Store.layer))),
    );
    assert.deepEqual(restored, { cursor: 30, status: "duplicate" });
    yield* TestClock.adjust("1 hour");
    assert.equal(yield* store.stewardDelivery("new"), "ready");
    assert.equal(yield* store.stewardDelivery("request:0"), "duplicate");
  }).pipe(Effect.provide(layer)),
);

it.effect("gives workers a worker note and forgets a removed bot with its workers and usage", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const news = bot("news");
    yield* store.put(news);
    const child = ThreadId.make("worker");
    yield* store.inherit({
      id: child,
      lineage: {
        parentThreadId: news.threadId,
        rootThreadId: news.threadId,
        relationshipToParent: "subagent",
      },
    });
    yield* store.charge(child, "turn-a", 40);
    const worker = (yield* store.persona(child))!;
    assert.include(worker, "worker for the bot news");
    assert.notInclude(worker, "Report news");
    yield* store.remove(news.threadId);
    assert.deepEqual(yield* store.list, []);
    assert.isUndefined(yield* store.owner(child));
    yield* store.put(news);
    assert.equal((yield* store.list)[0]?.tokensToday, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a bot's wakes per schedule and forgets all but the newest", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const news = bot("news");
    yield* store.put(news);
    const wake = (n: number, taskId = "watch") => ({
      threadId: ThreadId.make(`wake-${taskId}-${n}`),
      botThreadId: news.threadId,
      taskId,
      title: taskId,
    });
    yield* store.startWake(wake(0));
    yield* TestClock.adjust("1 minute");
    yield* store.startWake(wake(0, "digest"));
    yield* store.endWake(wake(0, "digest").threadId, "digest sent");
    yield* store.endWake(wake(0).threadId, "all ok");
    yield* TestClock.adjust("1 minute");
    yield* store.startWake(wake(1));
    assert.equal((yield* store.botFor(wake(1).threadId))?.name, "news");
    assert.include((yield* store.persona(wake(1).threadId))!, "Report news");
    assert.equal((yield* store.previousWake(wake(1).threadId))?.result, "all ok");
    assert.isDefined(yield* store.endWake(wake(1).threadId, "gpu-vm down"));
    assert.isUndefined(yield* store.endWake(wake(1).threadId, "again"));

    const pruned: ThreadId[] = [];
    for (let n = 2; n <= Store.WAKES_KEPT; n++) {
      yield* TestClock.adjust("1 minute");
      yield* store.startWake(wake(n));
      pruned.push(...((yield* store.endWake(wake(n).threadId, "ok"))?.pruned ?? []));
    }
    assert.deepEqual(pruned, [wake(0).threadId, wake(0, "digest").threadId]);
    assert.isUndefined(yield* store.botFor(wake(0).threadId));
    assert.lengthOf(yield* store.forgetWakes(news.threadId), Store.WAKES_KEPT);
    assert.isUndefined(yield* store.wake(wake(5).threadId));
  }).pipe(Effect.provide(layer)),
);

it.effect("the end of the first-run turn ends a pending tour, and no other turn does", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const main = bot("main");
    yield* store.put(main);
    yield* store.setMainBot(main.threadId);
    yield* store.updateOnboarding((current) => ({ ...current, tour: "pending" }));
    assert.include((yield* store.persona(main.threadId))!, "Your next reply starts it");
    yield* Store.endTourAfter(store, "message-from-the-user");
    assert.equal((yield* store.onboarding).tour, "pending");
    yield* Store.endTourAfter(store, `${BOT_KICKOFF_MESSAGE_PREFIX}${main.threadId}`);
    assert.equal((yield* store.onboarding).tour, "done");
    assert.notInclude((yield* store.persona(main.threadId))!, "Your next reply starts it");
  }).pipe(Effect.provide(layer)),
);

it.effect("loads memory lines saved before notes kept sources as the user's notes", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/bots.json`,
      JSON.stringify({
        bots: [{ ...bot("news"), memory: ["Short answers."] }],
        owners: {},
        usage: {},
        messages: {},
        userMemory: ["Metric units."],
      }),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store.BotStore;
      const legacy = yield* store.legacyMemory;
      const [note] = legacy.you;
      assert.include(note, { text: "Metric units.", status: "fresh" });
      assert.equal(note?.source.by, "user");
      assert.equal(legacy.bots[0]?.notes[0]?.text, "Short answers.");
    }).pipe(Effect.provide(Store.layer));
  }).pipe(
    Effect.provide(
      Config.layerTest(process.cwd(), { prefix: "bots-legacy-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a bot stored with a renamed tool loads holding the tool's new name", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/bots.json`,
      JSON.stringify({
        bots: [{ ...bot("news"), tools: ["web_search", "youtube_transcript"] }],
        owners: {},
        usage: {},
        messages: {},
      }),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store.BotStore;
      const [loaded] = yield* store.list;
      assert.deepEqual(loaded?.tools, ["web_search", "video_transcript"]);
    }).pipe(Effect.provide(Store.layer));
  }).pipe(
    Effect.provide(
      Config.layerTest(process.cwd(), { prefix: "bots-renamed-tool-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a notification from before the chat was cleared is not the bot's preview", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const clearedAt = "2026-11-09T21:10:02.000Z";
    const notified = (name: string, at: Partial<BotRecord>): BotRecord => ({
      ...bot(name),
      unread: true,
      lastNotification: `${name} report`,
      historyFrom: clearedAt,
      ...at,
    });
    yield* fs.writeFileString(
      `${config.stateDir}/bots.json`,
      JSON.stringify({
        bots: [
          notified("research", { notifiedAt: "2026-11-09T14:40:00.000Z" }),
          notified("main", { notifiedAt: null }),
          notified("homelab", {
            notifiedAt: "2026-11-09T23:07:00.000Z",
            previewAt: "2026-11-09T23:07:00.000Z",
          }),
        ],
        owners: {},
        usage: {},
        messages: {},
      }),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store.BotStore;
      for (const name of ["research", "main"])
        assert.include(yield* store.get(ThreadId.make(name)), {
          lastNotification: null,
          notifiedAt: null,
          unread: false,
        });
      assert.include(yield* store.get(ThreadId.make("homelab")), {
        lastNotification: "homelab report",
        unread: true,
      });
      yield* store.preview(ThreadId.make("homelab"), "on screen");
      const cleared = yield* store.edit(ThreadId.make("homelab"), (current) =>
        Store.withHistoryFrom(current, "2026-11-09T23:30:00.000Z"),
      );
      assert.include(cleared, {
        lastNotification: null,
        notifiedAt: null,
        unread: false,
        historyFrom: "2026-11-09T23:30:00.000Z",
      });
    }).pipe(Effect.provide(Store.layer));
  }).pipe(
    Effect.provide(
      Config.layerTest(process.cwd(), { prefix: "bots-cleared-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("keeps a day of usage per source and rolls it into 14 days of history", () =>
  Effect.gen(function* () {
    const store = yield* Store.BotStore;
    const news = { ...bot("news"), dailyTokenCap: 1_000_000 };
    yield* store.put(news);
    const child = ThreadId.make("worker");
    yield* store.inherit({
      id: child,
      lineage: {
        parentThreadId: news.threadId,
        rootThreadId: news.threadId,
        relationshipToParent: "subagent",
      },
    });
    const wake = ThreadId.make("wake-0");
    yield* store.startWake({
      threadId: wake,
      botThreadId: news.threadId,
      taskId: "w",
      title: "Watch",
    });
    yield* store.charge(news.threadId, "t1", 100);
    yield* store.charge(wake, "t2", 500);
    yield* store.charge(wake, "t2", 600);
    yield* store.charge(wake, "t3", 50);
    yield* store.charge(child, "t4", 10);
    yield* store.charge(news.threadId, "t6", 40, { source: "Keep-warm" });
    const [today] = (yield* store.list)[0]!.usage;
    assert.deepEqual(today, {
      day: "1970-01-01",
      tokens: 800,
      turns: 5,
      sources: [
        { source: "Watch", tokens: 650, turns: 2 },
        { source: "Chat", tokens: 100, turns: 1 },
        { source: "Keep-warm", tokens: 40, turns: 1 },
        { source: "Workers", tokens: 10, turns: 1 },
      ],
    });
    yield* TestClock.adjust("24 hours");
    assert.deepEqual(
      (yield* store.list)[0]!.usage.map((d) => [d.day, d.tokens]),
      [
        ["1970-01-02", 0],
        ["1970-01-01", 800],
      ],
    );
    yield* store.charge(news.threadId, "t5", 7);
    for (let n = 0; n < 20; n++) {
      yield* TestClock.adjust("24 hours");
      yield* store.charge(news.threadId, `d${n}`, n + 1);
    }
    const days = (yield* store.list)[0]!.usage;
    assert.lengthOf(days, Store.USAGE_DAYS_KEPT + 1);
    assert.deepEqual([days[0]?.day, days[0]?.tokens], ["1970-01-22", 20]);
    assert.equal(days.at(-1)?.day, "1970-01-08");
    const crowded = Store.summarizeUsage({
      day: "1970-02-01",
      turns: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, 10 + i])),
      sources: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, `s${i}`])),
    });
    assert.lengthOf(crowded.sources, 9);
    assert.deepEqual(crowded.sources.at(-1), { source: "Other", tokens: 21, turns: 2 });
    assert.equal(crowded.tokens, 145);
  }).pipe(Effect.provide(layer)),
);

it.effect("raises caps below the default once and keeps a cap the owner lowers later", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const stopped = {
      ...bot("research"),
      dailyTokenCap: 3_000_000,
      stopReason: "Daily token cap reached.",
    };
    yield* fs.writeFileString(
      `${config.stateDir}/bots.json`,
      JSON.stringify({
        bots: [
          stopped,
          { ...bot("inbox"), dailyTokenCap: 1_000_000 },
          { ...bot("big"), dailyTokenCap: 3 * DEFAULT_BOT_DAILY_TOKEN_CAP },
        ],
        owners: {},
        usage: { research: { day: "1970-01-01", turns: { a: 3_100_000 } } },
        messages: {},
      }),
    );
    const caps = Effect.gen(function* () {
      const store = yield* Store.BotStore;
      return (yield* store.list).map((b) => [b.name, b.dailyTokenCap, b.stopped, b.stopReason]);
    });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* caps, [
        ["research", DEFAULT_BOT_DAILY_TOKEN_CAP, false, undefined],
        ["inbox", DEFAULT_BOT_DAILY_TOKEN_CAP, false, undefined],
        ["big", 3 * DEFAULT_BOT_DAILY_TOKEN_CAP, false, undefined],
      ]);
      const store = yield* Store.BotStore;
      yield* store.edit(ThreadId.make("inbox"), (b) => ({ ...b, dailyTokenCap: 5_000_000 }));
    }).pipe(Effect.provide(Store.layer));
    yield* Effect.gen(function* () {
      assert.equal((yield* caps).find(([name]) => name === "inbox")?.[1], 5_000_000);
    }).pipe(Effect.provide(Store.layer));
  }).pipe(
    Effect.provide(
      Config.layerTest(process.cwd(), { prefix: "bots-caps-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

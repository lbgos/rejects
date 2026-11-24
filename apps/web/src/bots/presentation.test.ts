import { MessageId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../session-logic.ts";
import { botGlyph } from "./avatar.ts";
import {
  BOT_OFFER_TTL_MS,
  botActivityAt,
  botAwaitsAnswer,
  botNoticeKey,
  botReactions,
  botStatusLine,
  botToolActivity,
  botTurnHasText,
  botTurnOffers,
  botUiTips,
  messageLinks,
  formatListTime,
  timeSeparatorLabels,
  formatTokens,
  formatWakeIn,
  scheduleNamesItsNextRun,
  groupRepeatedRuns,
  runsRange,
  parseTokenCap,
  quoteReply,
  resolveBotState,
  searchBots,
  sortBotRows,
  swapStatus,
  visibleBotEntries,
} from "./presentation.ts";

const running = { stopped: false, stopReason: undefined };
const capped = { stopped: true, stopReason: "Daily token cap reached." };

describe("resolveBotState", () => {
  it("reads a cap stop as capped even when the interrupted run failed", () => {
    expect(resolveBotState("failed", capped)).toBe("capped");
  });
  it("keeps a real failure visible", () => {
    expect(resolveBotState("failed", running)).toBe("failed");
  });
  it("treats the failed run left by a raised cap as idle", () => {
    expect(
      resolveBotState("failed", { stopped: false, stopReason: "Daily token cap reached." }),
    ).toBe("idle");
  });
  it("maps thread activity", () => {
    expect(resolveBotState("working", running)).toBe("running");
    expect(resolveBotState("waiting", running)).toBe("waiting");
    expect(resolveBotState("ready", running)).toBe("idle");
  });
  it("is paused only when it has schedules and all are off", () => {
    expect(resolveBotState("ready", running, [{ enabled: false }])).toBe("paused");
    expect(resolveBotState("ready", running, [{ enabled: false }, { enabled: true }])).toBe("idle");
    expect(resolveBotState("working", running, [{ enabled: false }])).toBe("running");
  });
});

describe("botActivityAt", () => {
  const bot = { notifiedAt: "2026-11-06T09:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" };
  it("ignores the hidden memory flush the server sends as a user-role message", () => {
    const thread = {
      latestUserMessageAt: DateTime.makeUnsafe("2026-11-06T15:56:19.000Z"),
      latestUserAuthoredMessageAt: DateTime.makeUnsafe("2026-11-06T08:00:00.000Z"),
    };
    expect(botActivityAt(bot, thread)).toBe(Date.parse("2026-11-06T09:00:00.000Z"));
  });
  it("is the time of the shown preview, not of an older notification", () => {
    const later = {
      ...bot,
      notifiedAt: "2026-11-06T03:05:32.000Z",
      previewAt: "2026-11-06T06:30:04.000Z",
    };
    expect(botActivityAt(later, undefined)).toBe(Date.parse("2026-11-06T06:30:04.000Z"));
  });
  it("moves the bot up when the user writes", () => {
    const at = DateTime.makeUnsafe("2026-11-06T10:00:00.000Z");
    expect(botActivityAt(bot, { latestUserAuthoredMessageAt: at })).toBe(
      Date.parse("2026-11-06T10:00:00.000Z"),
    );
  });
  it("starts a cleared chat at its clear, ignoring what came before", () => {
    const at = DateTime.makeUnsafe("2026-11-06T10:00:00.000Z");
    const cleared = { ...bot, historyFrom: "2026-11-06T12:00:00.000Z" };
    expect(botActivityAt(cleared, { latestUserAuthoredMessageAt: at })).toBe(
      Date.parse("2026-11-06T12:00:00.000Z"),
    );
  });
});

describe("botNoticeKey", () => {
  it("changes when a muted notification sets only the preview", () => {
    const notified = {
      notifiedAt: "2026-11-06T09:00:00.000Z",
      previewAt: "2026-11-06T09:00:00.000Z",
    };
    const muted = { ...notified, previewAt: "2026-11-06T09:05:00.000Z" };
    expect(botNoticeKey(muted)).not.toBe(botNoticeKey(notified));
    expect(botNoticeKey({ notifiedAt: "2026-11-06T09:00:00.000Z" })).toBe(
      "2026-11-06T09:00:00.000Z",
    );
  });
});

describe("formatWakeIn", () => {
  const now = new Date(2026, 9, 27, 9, 0).getTime();
  it("counts minutes within the hour, then names the clock time", () => {
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(
      [at(20_000), at(12 * 60_000), at(3 * 3_600_000), at(23.5 * 3_600_000)].map((t) =>
        formatWakeIn(t, now),
      ),
    ).toEqual(["<1m", "12m", "12:00", "08:30"]);
    expect(formatWakeIn(at(50 * 3_600_000), now)).toMatch(/^\S+ 11:00$/);
  });
});

describe("scheduleNamesItsNextRun", () => {
  it("is true only for a rule that names a single moment", () => {
    expect(scheduleNamesItsNextRun({ type: "fixed_time", timeOfDay: "09:00", weekdays: [6] })).toBe(
      true,
    );
    expect(
      scheduleNamesItsNextRun({
        type: "fixed_time",
        timeOfDay: "07:30",
        weekdays: [1, 2, 3, 4, 5],
      }),
    ).toBe(false);
    expect(scheduleNamesItsNextRun({ type: "fixed_time", timeOfDay: "16:00" })).toBe(false);
    expect(scheduleNamesItsNextRun({ type: "interval", everyMs: 3_600_000 })).toBe(false);
  });
});

describe("nightly check rows", () => {
  it("folds nights that say the same and changed nothing", () => {
    const night = (result: string, outcome: "changed" | "skipped" | "failed") => ({
      result,
      outcome,
    });
    const groups = groupRepeatedRuns([
      night("2 merged", "changed"),
      night("2 merged", "changed"),
      night("No changes", "skipped"),
      night("No changes", "skipped"),
      night("Model did not answer", "failed"),
      night("No changes", "skipped"),
    ]);
    expect(groups.map((group) => [group[0].result, group.length])).toEqual([
      ["2 merged", 1],
      ["2 merged", 1],
      ["No changes", 2],
      ["Model did not answer", 1],
      ["No changes", 1],
    ]);
  });

  it("gives a group's range oldest first, though the server lists runs newest first", () => {
    const nights = [
      "2026-11-14T03:30:00.000Z",
      "2026-11-12T03:30:00.000Z",
      "2026-11-09T03:30:00.000Z",
    ];
    expect(runsRange(nights.map((at) => ({ at })))).toEqual([
      Date.parse("2026-11-09T03:30:00.000Z"),
      Date.parse("2026-11-14T03:30:00.000Z"),
    ]);
  });
});

describe("token cap text", () => {
  it("formats compactly", () => {
    expect([950, 54_000, 1_250_000, 2_000_000, 12_345_678].map(formatTokens)).toEqual([
      "950",
      "54k",
      "1.25M",
      "2M",
      "12M",
    ]);
  });
  it("parses human input", () => {
    expect(["2M", "500k", "1.5m", "2,000,000", "2000000", " 2 M "].map(parseTokenCap)).toEqual([
      2_000_000, 500_000, 1_500_000, 2_000_000, 2_000_000, 2_000_000,
    ]);
  });
  it("rejects junk and zero", () => {
    expect(["", "abc", "0", "-5", "1e6", "2G"].map(parseTokenCap)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("messenger text", () => {
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();
  const now = at(27, 12, 0);

  it("formats the list time", () => {
    expect(formatListTime(at(27, 10, 59), now)).toBe("10:59");
    expect(formatListTime(at(26, 22, 0), now)).toBe("Yesterday");
    expect(formatListTime(at(1, 8, 0), now)).toMatch(/1/);
  });

  it("labels the first message and pauses of 30 minutes or more", () => {
    const labels = timeSeparatorLabels(
      [
        { id: "a", at: at(27, 10, 0) },
        { id: "b", at: at(27, 10, 10) },
        { id: "c", at: at(27, 11, 0) },
      ],
      now,
    );
    expect([...labels.keys()]).toEqual(["a", "c"]);
    expect(labels.get("a")).toBe("Today 10:00");
  });

  it("starts a new group on a day change even without a long pause", () => {
    const labels = timeSeparatorLabels(
      [
        { id: "a", at: at(26, 23, 50) },
        { id: "b", at: at(27, 0, 5) },
      ],
      now,
    );
    expect(labels.get("b")).toBe("Today 00:05");
    expect(labels.get("a")).toBe("Yesterday 23:50");
  });
});

describe("botGlyph", () => {
  it("picks the glyph from the kind, then the first word that matches the name", () => {
    expect(botGlyph("Tunes", "music")).toBe("music");
    expect(botGlyph("Bots Manager")).toBe("manager");
    expect(botGlyph(" homelab ")).toBe("server");
    expect(botGlyph("Agents")).toBe("terminal");
    expect(botGlyph("Chief")).toBe("bot");
  });
});

describe("quoteReply", () => {
  it("quotes each line, then a blank line and the reply", () => {
    expect(quoteReply(" Done.\r\n\nTwo items ", "Thanks")).toBe(
      "> Done.\n>\n> Two items\n\nThanks",
    );
  });
  it("cuts a long quote to 280 characters", () => {
    expect(quoteReply("x".repeat(400), "ok")).toBe(`> ${"x".repeat(279)}…\n\nok`);
  });
});

describe("visibleBotEntries", () => {
  const message = (id: string, runId: string | null, createdAt: string): TimelineEntry => ({
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: id,
      runId: runId === null ? null : RunId.make(runId),
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  });

  const plan = (id: string, runId: string, createdAt: string): TimelineEntry => ({
    id,
    kind: "work",
    createdAt,
    entry: {
      runId: RunId.make(runId),
      projectedItem: { item: { type: "todo_list", runId: RunId.make(runId) } },
    } as never,
  });

  it("hides upkeep runs, compactions, context handoffs, the first-run prompt, earlier plan updates and what came before the chat was cleared", () => {
    const entries: TimelineEntry[] = [
      message("old", "run:1", "2026-11-05T10:00:00.000Z"),
      message("bots:flush:run:1", "run:2", "2026-11-05T11:00:00.000Z"),
      message("saved", "run:2", "2026-11-05T11:00:01.000Z"),
      message("bots:compact:run:2", "run:4", "2026-11-05T11:10:00.000Z"),
      {
        id: "auto-compaction",
        kind: "work",
        createdAt: "2026-11-05T11:20:00.000Z",
        entry: { runId: RunId.make("run:3"), sourceActivityKind: "context-compaction" } as never,
      },
      message("bots:wake-result:w", null, "2026-11-05T12:00:00.000Z"),
      {
        id: "handoff",
        kind: "event",
        createdAt: "2026-11-05T12:30:00.000Z",
        projectedItem: { item: { type: "handoff", runId: RunId.make("run:3") } } as never,
      },
      message("new", "run:3", "2026-11-05T13:00:00.000Z"),
      message("bots:kickoff:main", "run:5", "2026-11-05T14:00:00.000Z"),
      message("greeting", "run:5", "2026-11-05T14:00:01.000Z"),
      plan("plan:first", "run:6", "2026-11-05T15:00:00.000Z"),
      {
        id: "plan-tool",
        kind: "work",
        createdAt: "2026-11-05T15:00:01.000Z",
        entry: {
          runId: RunId.make("run:6"),
          structuredPayload: { type: "dynamic_tool", toolName: "TodoWrite" },
        } as never,
      },
      plan("plan:latest", "run:6", "2026-11-05T15:00:02.000Z"),
    ];
    expect(visibleBotEntries(entries, undefined).map((e) => e.id)).toEqual([
      "old",
      "bots:wake-result:w",
      "new",
      "greeting",
      "plan:latest",
    ]);
    expect(visibleBotEntries(entries, "2026-11-05T11:30:00.000Z").map((e) => e.id)).toEqual([
      "bots:wake-result:w",
      "new",
      "greeting",
      "plan:latest",
    ]);
  });

  it("shows a stopped turn as its stop line, without the thinking it never finished", () => {
    const asked: TimelineEntry = {
      id: "asked",
      kind: "message",
      createdAt: "2026-11-05T16:00:00.000Z",
      message: {
        id: MessageId.make("asked"),
        role: "user",
        text: "asked",
        runId: RunId.make("run:7"),
        streaming: false,
        createdAt: "2026-11-05T16:00:00.000Z",
        updatedAt: "2026-11-05T16:00:00.000Z",
      },
    };
    const thought = (id: string, createdAt: string): TimelineEntry => ({
      id,
      kind: "work",
      createdAt,
      entry: { runId: RunId.make("run:7"), itemType: "reasoning", tone: "thinking" } as never,
    });
    const stopped: TimelineEntry = {
      id: "stopped",
      kind: "event",
      createdAt: "2026-11-05T16:00:05.000Z",
      projectedItem: {
        item: { type: "run_interrupt_result", runId: RunId.make("run:7") },
      } as never,
    };
    const first = thought("thought", "2026-11-05T16:00:01.000Z");
    expect(visibleBotEntries([asked, first, stopped], undefined).map((e) => e.id)).toEqual([
      "asked",
      "stopped",
    ]);
    expect(visibleBotEntries([asked, first], undefined).map((e) => e.id)).toEqual([
      "asked",
      "thought",
    ]);
  });

  it("leaves a chat empty when its own first turn failed for want of a model", () => {
    const failed: TimelineEntry = {
      id: "failed",
      kind: "work",
      createdAt: "2026-11-05T14:00:02.000Z",
      entry: {
        runId: RunId.make("run:5"),
        projectedItem: { item: { type: "error", status: "failed" } },
      } as never,
    };
    const kickoff = message("bots:kickoff:main", "run:5", "2026-11-05T14:00:00.000Z");
    const ids = (entries: TimelineEntry[], providerDown: boolean) =>
      visibleBotEntries(entries, undefined, providerDown).map((e) => e.id);
    expect(ids([kickoff, failed], true)).toEqual([]);
    expect(ids([kickoff, failed], false)).toEqual(["failed"]);
    const asked = message("asked", "run:6", "2026-11-05T15:00:00.000Z");
    expect(ids([asked, failed], true)).toEqual(["asked", "failed"]);
  });
});

describe("botTurnOffers", () => {
  const at = "2026-11-06T18:00:00.000Z";
  const user = (id: string): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role: "user",
      text: id,
      runId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  const now = Date.parse(at);
  const reply = (id: string, text: string, runId: string | null = null): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      runId: runId === null ? null : RunId.make(runId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  const call = (
    id: string,
    toolName: string,
    input: unknown,
    status = "completed",
    output?: unknown,
    runId?: string,
  ) =>
    ({
      id,
      kind: "work",
      createdAt: at,
      entry: {
        id,
        createdAt: at,
        ...(runId === undefined ? {} : { runId: RunId.make(runId) }),
        label: "Used t3 code integration",
        tone: "tool",
        structuredPayload: { type: "dynamic_tool", toolName, input, status, output } as never,
      },
    }) satisfies TimelineEntry;

  it("reads the replies and hand-off the bot offered after the user's last message", () => {
    const entries = [
      user("first"),
      call("old", "mcp__t3-code__offer_replies", { replies: ["Old"] }),
      user("second"),
      call("hand", "t3-code.hand_off", { bot: "Music", draft: "something calm" }),
      call("replies", "mcp__t3-code__offer_replies", { replies: ["Yes", "No"] }),
    ];
    expect(botTurnOffers(entries, now)).toEqual({
      replies: ["Yes", "No"],
      proposal: null,
      handOff: { bot: "Music", draft: "something calm" },
      expiresAt: now + BOT_OFFER_TTL_MS,
    });
    const proposed = call(
      "propose",
      "mcp__t3-code__propose_bots",
      { templates: ["mail"] },
      "completed",
      {
        proposalId: "p1",
      },
    );
    expect(botTurnOffers([...entries, proposed], now)).toEqual({
      replies: [],
      proposal: "p1",
      handOff: { bot: "Music", draft: "something calm" },
      expiresAt: now + BOT_OFFER_TTL_MS,
    });
  });

  it("reads the places the bot pointed at since the user's last message, in order, until they expire", () => {
    const entries = [
      call("old", "mcp__t3-code__show_ui", { target: "bots", text: "Old" }),
      user("hi"),
      call("mic", "mcp__t3-code__show_ui", { target: "dictation", text: "Speak" }),
      call("bad", "mcp__t3-code__show_ui", { target: "#composer", text: "Selector" }),
      call("busy", "mcp__t3-code__show_ui", { target: "accounts", text: "Busy" }, "inProgress"),
      reply("answer", "Hello"),
      call("you", "t3-code.show_ui", { target: "accounts", text: "Accounts" }),
    ];
    expect(botUiTips(entries, now)).toEqual([
      { id: "mic", target: "dictation", text: "Speak" },
      { id: "you", target: "accounts", text: "Accounts" },
    ]);
    expect(botUiTips(entries, now + BOT_OFFER_TTL_MS)).toEqual([]);
    expect(botUiTips([...entries, user("thanks")], now)).toEqual([]);
  });

  it("puts the bot's newest reaction on the user's message it answers, and hides the calls", () => {
    const entries = [
      user("thanks"),
      call("r1", "mcp__t3-code__react", { emoji: "👀" }),
      call("r2", "t3-code.react", { emoji: "👍" }),
      reply("echo", "👍 "),
      user("ok"),
      reply("🙂", "🙂"),
      call("r3", "t3-code-thread_1_react", { emoji: "❤️" }, "failed"),
      call("s", "mcp__t3-code__status", { text: "checking" }),
      reply("done", "Done ✅"),
      user("thx"),
      {
        id: "think",
        kind: "work",
        createdAt: at,
        entry: { id: "think", createdAt: at, label: "Thinking", tone: "thinking" },
      },
      call("r4", "t3-code-thread_1_react", { emoji: "❤️" }),
      user("hm"),
      call("s2", "mcp__t3-code__status", { text: "checking" }),
      reply("🙏", " 🙏 "),
      user("long"),
      reply("🙂 hi", "🙂 hi"),
    ] satisfies ReadonlyArray<TimelineEntry>;
    expect(botReactions(entries)).toEqual(
      new Map([
        ["thanks", "👍"],
        ["thx", "❤️"],
        ["hm", "🙏"],
      ]),
    );
    expect(visibleBotEntries(entries, undefined).map((e) => e.id)).toEqual([
      "thanks",
      "ok",
      "🙂",
      "s",
      "done",
      "thx",
      "hm",
      "s2",
      "long",
      "🙂 hi",
    ]);
  });

  it("reads the newest status line since the user's last message", () => {
    const turn = [
      user("first"),
      call("s0", "t3-code-thread_1_status", { text: "old task" }),
      user("second"),
      call("s1", "mcp__t3-code__status", { text: "reading 12 invoices" }),
      call("w", "web_search", { query: "x" }),
      call("s2", "t3-code.status", { text: "checking the statement" }),
      call("b", "web_browse", { url: "https://a.example" }),
    ];
    expect(botStatusLine(turn)).toBe("checking the statement");
    expect(botStatusLine(turn.slice(0, 4))).toBe("reading 12 invoices");
    expect(botStatusLine(turn.slice(0, 3))).toBeNull();
  });

  it("offers nothing once the user writes, or for failed and malformed calls", () => {
    const none = { replies: [], proposal: null, handOff: null, expiresAt: null };
    expect(
      botTurnOffers([call("r", "mcp__t3-code__offer_replies", { replies: ["A"] }), user("u")], now),
    ).toEqual(none);
    expect(
      botTurnOffers(
        [
          user("u"),
          call("h", "t3-code.hand_off", { bot: "Music" }),
          call("r", "t3-code-thread_1_offer_replies", { replies: ["A"] }, "failed"),
          call("p", "mcp__t3-code__propose_bots", { templates: ["mail"] }, "completed", {
            isError: true,
          }),
        ],
        now,
      ),
    ).toEqual(none);
  });

  it("ends the replies at a later run's message or after 30 minutes, not at its own run's text", () => {
    const offer = call(
      "r",
      "mcp__t3-code__offer_replies",
      { replies: ["A"] },
      "completed",
      undefined,
      "run:1",
    );
    expect(botTurnOffers([offer, reply("same", "pick one", "run:1")], now).replies).toEqual(["A"]);
    expect(botTurnOffers([offer, reply("wake", "good morning", "run:2")], now)).toMatchObject({
      replies: [],
      expiresAt: null,
    });
    expect(botTurnOffers([offer], now + BOT_OFFER_TTL_MS - 1).replies).toEqual(["A"]);
    expect(botTurnOffers([offer], now + BOT_OFFER_TTL_MS).replies).toEqual([]);
  });
});

describe("botToolActivity", () => {
  const entry = (toolName: string | null, input: unknown, label = "Used t3 code integration") => ({
    id: "w",
    createdAt: "2026-11-06T18:00:00.000Z",
    label,
    tone: "tool" as const,
    ...(toolName === null
      ? {}
      : { structuredPayload: { type: "dynamic_tool", toolName, input } as never }),
  });

  it.each([
    [
      entry("mcp__t3-code__web_search", { query: "proxmox  9.2\nkernel" }),
      "Searching the web: proxmox 9.2 kernel",
    ],
    [entry("t3-code.web_search", { query: "pve" }), "Searching the web: pve"],
    [
      entry("web_browse", { url: "https://pve.proxmox.com/wiki/Roadmap" }),
      "Reading a page: pve.proxmox.com/wiki/Roadmap",
    ],
    [entry("notify_user", { text: "Done" }), "Sending a notification"],
    [entry("some_new_tool", { id: "x" }), "Working"],
    [entry(null, undefined, "Running vp"), "Running vp"],
  ])("%#: says what the tool is doing in plain words", (work, label) => {
    expect(botToolActivity(work)).toBe(label);
  });
});

describe("messageLinks", () => {
  it("takes the first two web links of a message, Markdown or bare, once each", () => {
    const text = [
      "Proxmox [VE 9.2](https://www.proxmox.com/en/news/pve-9-2) is out.",
      "Roadmap: https://pve.proxmox.com/wiki/Roadmap.",
      "Again (https://www.proxmox.com/en/news/pve-9-2), [notes](./notes.md), https://third.example/x",
    ].join("\n");
    expect(messageLinks(text)).toEqual([
      "https://www.proxmox.com/en/news/pve-9-2",
      "https://pve.proxmox.com/wiki/Roadmap",
    ]);
  });
});

describe("sortBotRows", () => {
  it("lists the main bot first whatever its activity, then the rest newest first", () => {
    const row = (name: string, at: number, main?: true) => ({ bot: { name, main }, at });
    const rows = [row("Old", 1), row("Main", 0, true), row("New", 9)];
    expect(sortBotRows(rows).map((r) => r.bot.name)).toEqual(["Main", "New", "Old"]);
  });
});

describe("searchBots", () => {
  const now = Date.parse("2026-11-08T03:00:00Z");
  const row = (threadId: string, name: string, description: string, at: number) => ({
    bot: { threadId, name, description },
    at,
  });
  const homelab = row("t1", "Homelab", "Watches hosts and services", now - 60_000);
  const music = row("t2", "Music", "Finds and plays music", now - 3_600_000);
  const research = row("t3", "Research", "Looks things up, music charts too", now);
  const rows = [research, homelab, music];

  it("ranks names over purposes, folds case and accents, then adds bots found by their messages", () => {
    expect(searchBots(rows, "MUSIC", [], now)).toEqual([music, research]);
    expect(searchBots(rows, "hömelab", [], now)).toEqual([homelab]);
    expect(searchBots(rows, "proxmox", ["t1", "t3", "t1", "gone"], now)).toEqual([
      homelab,
      research,
    ]);
    expect(searchBots(rows, "music", ["t2", "t1"], now)).toEqual([music, research, homelab]);
  });
  it("tolerates a typo in a name", () => {
    expect(searchBots(rows, "reserch", [], now)).toEqual([research]);
  });
});

describe("botAwaitsAnswer", () => {
  const working = { kind: "working" } as const;
  // The timeline's trailing "Thinking" placeholder while nothing else is active.
  const placeholder = { kind: "thinking" } as const;
  const tool = { kind: "work-live" } as const;
  const reasoning = { kind: "work" } as const;
  const said = (role: "user" | "assistant", streaming = false) =>
    ({ kind: "message", message: { role, streaming } }) as const;

  it("waits through thinking and tools, stops once answer text streams, and waits again only for the next tool", () => {
    expect(botAwaitsAnswer([said("user"), working])).toBe(true);
    expect(botAwaitsAnswer([said("user"), reasoning, tool, placeholder, working])).toBe(true);
    expect(botAwaitsAnswer([said("user"), tool, said("assistant", true), working])).toBe(false);
    expect(
      botAwaitsAnswer([said("user"), reasoning, said("assistant", true), placeholder, working]),
    ).toBe(false);
    expect(botAwaitsAnswer([said("user"), said("assistant"), tool, working])).toBe(true);
  });
  it("keeps the dots for a turn with nothing to read yet, per turn", () => {
    expect(botTurnHasText([said("user"), reasoning, tool, working])).toBe(false);
    expect(botTurnHasText([said("user"), said("assistant"), tool, working])).toBe(true);
    expect(botTurnHasText([said("user"), said("assistant"), said("user"), tool, working])).toBe(
      false,
    );
  });
  it("stays gone after a text-only ending while the run settles", () => {
    expect(
      botAwaitsAnswer([said("user"), reasoning, tool, said("assistant"), placeholder, working]),
    ).toBe(false);
  });
  it("is false once the bot is no longer working", () => {
    expect(botAwaitsAnswer([said("user"), tool])).toBe(false);
  });
});

describe("swapStatus", () => {
  const start = { text: "Searching", leaving: null, swaps: 0 };
  it("swaps once per new line, keeps only the latest leaving line, and updates growing text in place", () => {
    const grown = swapStatus(start, "Searching the web");
    expect(grown).toEqual({ text: "Searching the web", leaving: null, swaps: 0 });
    expect(swapStatus(grown, "Searching the web")).toBe(grown);
    const read = swapStatus(grown, "Reading a.example");
    expect(read).toEqual({ text: "Reading a.example", leaving: "Searching the web", swaps: 1 });
    expect(swapStatus(read, "Ran command")).toEqual({
      text: "Ran command",
      leaving: "Reading a.example",
      swaps: 2,
    });
  });
});

import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  type ContextStep,
  nextContextStep,
  reactedMessages,
  unseenMessages,
  wakeAnswer,
  wakeSummary,
} from "./segments.ts";

const thread = ThreadId.make("bot");
const t0 = Date.parse("2026-11-05T12:00:00Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const MIN = 60_000;
const oldContext = ProviderThreadId.make("provider-thread:old");
const freshContext = ProviderThreadId.make("provider-thread:fresh");

const run = (
  ordinal: number,
  providerThreadId: ProviderThreadId,
  options: {
    readonly message?: string;
    readonly status?: OrchestrationV2Run["status"];
    readonly ms?: number;
    readonly model?: string | undefined;
  } = {},
): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId: thread,
  ordinal,
  providerInstanceId: ProviderInstanceId.make("i"),
  modelSelection: { instanceId: ProviderInstanceId.make("i"), model: options.model ?? "m" },
  providerThreadId,
  userMessageId: MessageId.make(options.message ?? `user:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: options.status ?? "completed",
  requestedAt: at(options.ms ?? t0 + ordinal * MIN),
  startedAt: at(options.ms ?? t0 + ordinal * MIN),
  completedAt: options.status === "running" ? null : at((options.ms ?? t0 + ordinal * MIN) + 1000),
  checkpointId: null,
  contextHandoffId: null,
});

type Usage = NonNullable<OrchestrationV2ProviderTurn["tokenUsage"]>;
const usage = (usedTokens: number, extra: Partial<Usage> = {}): Usage => ({
  usedTokens,
  updatedAt: DateTime.formatIso(at(t0 + MIN + 1000)),
  ...extra,
});

const records = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  usages: ReadonlyArray<Usage> = [],
  active = oldContext,
) => ({
  thread: { activeProviderThreadId: active },
  runs,
  runtimeRequests: [],
  providerTurns: usages.map((tokenUsage) => ({ providerThreadId: oldContext, tokenUsage })),
});

describe("nextContextStep", () => {
  const last = t0 + MIN + 1000;
  const expiresAt = DateTime.formatIso(at(last + 60 * MIN));
  const step = (model: string, idle: number, usages: ReadonlyArray<Usage>) =>
    nextContextStep(records([run(1, oldContext, { model })], usages), last + idle)?.type;

  it.each([
    { model: "claude-opus-5-5", tokens: 399_000, idle: 0, want: "wait" },
    { model: "claude-opus-5-5", tokens: 400_000, idle: 0, want: "compact" },
    { model: "deepseek-v4.1-flash", tokens: 399_000, idle: 0, want: undefined },
    { model: "deepseek-v4.1-flash", tokens: 400_000, idle: 0, want: "compact" },
    { model: "gpt-6.1-sol", tokens: 240_000, idle: 0, want: undefined },
    { model: "gpt-6.1-sol", tokens: 245_000, idle: 0, want: "compact" },
    { model: "zai-glm-5-3-flash", tokens: 89_000, idle: 0, want: undefined },
    { model: "zai-glm-5-3-flash", tokens: 90_000, idle: 0, want: "compact" },
    { model: "mimo-2", tokens: 179_000, maxTokens: 200_000, idle: 0, want: undefined },
    { model: "mimo-2", tokens: 180_000, maxTokens: 200_000, idle: 0, want: "compact" },
    { model: "mimo-2", tokens: 900_000, idle: 0, want: undefined },
    { model: "claude-sonnet-5-5", tokens: 180_000, maxTokens: 200_000, idle: 0, want: "compact" },
  ])("$model at $tokens tokens: $want", ({ model, tokens, maxTokens, idle, want }) => {
    const reported = usage(tokens, {
      promptCacheExpiresAt: expiresAt,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    assert.equal(step(model, idle, [reported]), want);
  });

  it.each([
    { idle: 54 * MIN, tokens: 150_000, want: "wait" },
    { idle: 56 * MIN, tokens: 150_000, want: "nudge" },
    { idle: 56 * MIN, tokens: 20_000, want: "nudge" },
    { idle: 59 * MIN + 30_000, tokens: 150_000, want: undefined },
    { idle: 3 * 60 * MIN, tokens: 450_000, want: undefined },
  ])("Claude idle $idle ms at $tokens tokens: $want", ({ idle, tokens, want }) => {
    const reported = [usage(tokens, { promptCacheExpiresAt: expiresAt })];
    assert.equal(step("claude-opus-5-5", idle, reported), want);
  });

  it.each(["deepseek-v4.1-flash", "gpt-6.1-sol", "zai-glm-5-3-flash", "mimo-2"])(
    "never nudges or compacts %s on an idle timer, even with Claude Code's 5m cache tag",
    (model) => {
      const tagged = [
        usage(80_000, { promptCacheTtlMs: 5 * MIN, promptCacheExpiresAt: expiresAt }),
      ];
      assert.equal(step(model, 56 * MIN, tagged), undefined);
      assert.equal(step(model, 4 * MIN + 40_000, tagged), undefined);
    },
  );

  it("times a Claude cache from the run's end and its reported TTL when the last request wrote none", () => {
    const fiveMinutes = [usage(150_000), usage(120_000, { promptCacheTtlMs: 5 * MIN })];
    assert.deepEqual(
      nextContextStep(
        records([run(1, oldContext, { model: "claude-opus-5-5" })], fiveMinutes),
        last,
      ),
      { type: "wait", untilMs: last + 5 * MIN - 25_000 },
    );
    assert.deepEqual(
      nextContextStep(
        records([run(1, oldContext, { model: "claude-opus-5-5" })], [usage(150_000)]),
        last,
      ),
      { type: "wait", untilMs: last + 55 * MIN },
    );
    assert.equal(
      nextContextStep(
        records(
          [run(1, oldContext, { model: "claude-opus-5-5" })],
          [usage(80_000, { promptCacheTtlMs: 5 * MIN })],
        ),
        last,
      ),
      null,
    );
  });

  describe("keep-warm nudges", () => {
    const claude = "claude-opus-5-5";
    const anchor = RunId.make("run:1");
    const nudgedAt = (n: number) => last + n * 55 * MIN;
    const spell = (
      nudges: number,
      tokens: number,
      options: { readonly failed?: number; readonly cached?: number } = {},
    ) =>
      records(
        [
          run(1, oldContext, { model: claude }),
          ...Array.from({ length: nudges }, (_, index) =>
            run(index + 2, oldContext, {
              model: claude,
              message: `bots:keepwarm:run:1:${index + 1}`,
              ms: nudgedAt(index + 1),
              status: options.failed === index + 1 ? "failed" : "completed",
            }),
          ),
        ],
        [
          usage(tokens, { promptCacheExpiresAt: expiresAt, promptCacheTtlMs: 60 * MIN }),
          ...Array.from({ length: nudges }, (_, index) => index + 1)
            .filter((n) => n !== options.failed)
            .map((n) =>
              usage(tokens, {
                updatedAt: DateTime.formatIso(at(nudgedAt(n) + 1000)),
                inputTokens: tokens,
                cachedInputTokens: options.cached ?? tokens - 50,
                promptCacheTtlMs: 60 * MIN,
                promptCacheExpiresAt: DateTime.formatIso(at(nudgedAt(n) + 60 * MIN)),
              }),
            ),
        ],
      );

    it.each([
      { nudges: 0, idle: 55 * MIN, want: { type: "nudge", runId: anchor, nudge: 1 } },
      { nudges: 1, idle: 109 * MIN, want: { type: "wait", untilMs: nudgedAt(2) } },
      { nudges: 1, idle: 110 * MIN, want: { type: "nudge", runId: anchor, nudge: 2 } },
      { nudges: 2, idle: 165 * MIN, want: { type: "nudge", runId: anchor, nudge: 3 } },
      { nudges: 3, idle: 200 * MIN, want: { type: "wait", untilMs: nudgedAt(4) } },
      { nudges: 3, idle: 220 * MIN, want: { type: "compact", runId: anchor } },
    ] satisfies ReadonlyArray<{ nudges: number; idle: number; want: ContextStep }>)(
      "after $nudges nudges at $idle ms idle: $want.type",
      ({ nudges, idle, want }) => {
        assert.deepEqual(nextContextStep(spell(nudges, 150_000), last + idle), want);
      },
    );

    it("lets a small context expire after the third nudge", () => {
      assert.equal(nextContextStep(spell(3, 99_000), last + 220 * MIN), null);
    });

    it("compacts without nudging near the bot's daily cap", () => {
      assert.deepEqual(nextContextStep(spell(0, 150_000), last + 55 * MIN, false), {
        type: "compact",
        runId: anchor,
      });
    });

    it("never nudges a cache that is already dead", () => {
      assert.equal(nextContextStep(spell(1, 150_000), nudgedAt(1) + 60 * MIN), null);
      assert.equal(nextContextStep(spell(0, 150_000), last + 61 * MIN), null);
    });

    it("stops nudging after a failed nudge or one that missed the cache", () => {
      const failed = spell(1, 150_000, { failed: 1 });
      assert.deepEqual(nextContextStep(failed, nudgedAt(1) + 1000), {
        type: "compact",
        runId: anchor,
      });
      assert.equal(nextContextStep(spell(1, 90_000, { failed: 1 }), nudgedAt(1) + 1000), null);
      const missed = spell(1, 150_000, { cached: 30_000 });
      assert.deepEqual(nextContextStep(missed, nudgedAt(2)), { type: "compact", runId: anchor });
    });

    it("starts a new spell after the user's next turn", () => {
      const afterNudges = spell(3, 150_000);
      const resumed = {
        ...afterNudges,
        runs: [...afterNudges.runs, run(5, oldContext, { model: claude, ms: last + 200 * MIN })],
        providerTurns: [
          ...afterNudges.providerTurns,
          {
            providerThreadId: oldContext,
            tokenUsage: usage(150_000, {
              updatedAt: DateTime.formatIso(at(last + 200 * MIN + 2000)),
              promptCacheTtlMs: 60 * MIN,
              promptCacheExpiresAt: DateTime.formatIso(at(last + 260 * MIN)),
            }),
          },
        ],
      };
      assert.deepEqual(nextContextStep(resumed, last + 255 * MIN), {
        type: "nudge",
        runId: RunId.make("run:5"),
        nudge: 1,
      });
    });
  });

  it.each(["completed", "failed"] as const)(
    "compacts once per idle spell: never after a %s compaction",
    (status) => {
      const compacted = [
        run(1, oldContext, { model: "claude-opus-5-5" }),
        run(2, oldContext, { model: "claude-opus-5-5", message: "bots:compact:run:1", status }),
      ];
      const big = [usage(450_000, { promptCacheExpiresAt: expiresAt })];
      assert.equal(nextContextStep(records(compacted, big), last + 56 * MIN), null);
    },
  );

  it("does nothing while a run is active or on a fresh provider thread", () => {
    const big = [usage(950_000)];
    const busy = [run(1, oldContext), run(2, oldContext, { status: "running" })];
    assert.equal(nextContextStep(records(busy, big), t0 + 9e9), null);
    assert.equal(nextContextStep(records([run(1, oldContext)], big, freshContext), t0), null);
  });
});

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  ms: number,
  runId: string | null,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: thread,
  runId: runId === null ? null : RunId.make(runId),
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: at(ms),
  updatedAt: at(ms),
  createdBy: role === "user" ? "user" : "agent",
  creationSource: "web",
});

describe("unseenMessages", () => {
  const runs = [
    run(1, oldContext, { ms: t0 }),
    run(2, oldContext, { ms: t0 + 10 * MIN }),
    run(3, oldContext, { ms: t0 + 70 * MIN, message: "bots:flush:run:2" }),
    run(4, freshContext, { ms: t0 + 400 * MIN }),
  ];
  const messages = [
    message("user:1", "user", "is media-vm up?", t0, "run:1"),
    message("a:1", "assistant", "No, down since 15:06.", t0 + 1000, "run:1"),
    message("user:2", "user", "remind me tomorrow", t0 + 10 * MIN, "run:2"),
    message("a:2", "assistant", "Will do.", t0 + 10 * MIN + 1000, "run:2"),
    message("bots:wake-result:w1", "assistant", "no change", t0 + 60 * MIN, null),
    message("bots:flush:run:2", "user", "[Context flush] …", t0 + 70 * MIN, "run:3"),
    message("a:3", "assistant", "Saved.", t0 + 70 * MIN + 1000, "run:3"),
    message("user:4", "user", "and now?", t0 + 400 * MIN, "run:4"),
  ];

  it("gives a fresh context the chat across the boundary without the flush", () => {
    const unseen = unseenMessages({
      runs,
      messages,
      run: runs[3]!,
      providerThreadId: freshContext,
    });
    assert.deepEqual(
      unseen.map((m) => `${m.role}: ${m.text}`),
      [
        "user: is media-vm up?",
        "you: No, down since 15:06.",
        "user: remind me tomorrow",
        "you: Will do.",
        "you: no change",
      ],
    );
  });

  it("drops what came before the user cleared the chat", () => {
    const unseen = unseenMessages({
      runs,
      messages,
      run: runs[3]!,
      providerThreadId: freshContext,
      historyFromMs: t0 + 5 * MIN,
    });
    assert.deepEqual(
      unseen.map((m) => m.text),
      ["remind me tomorrow", "Will do.", "no change"],
    );
  });

  it("gives a continuing context only the results posted since its last turn", () => {
    const unseen = unseenMessages({ runs, messages, run: runs[2]!, providerThreadId: oldContext });
    assert.deepEqual(
      unseen.map((m) => m.text),
      ["no change"],
    );
    const keepWarm = run(5, oldContext, { ms: t0 + 65 * MIN, message: "bots:keepwarm:run:2:1" });
    const next = run(6, oldContext, { ms: t0 + 90 * MIN });
    assert.deepEqual(
      unseenMessages({
        runs: [runs[0]!, runs[1]!, keepWarm, next],
        messages,
        run: next,
        providerThreadId: oldContext,
      }).map((m) => m.text),
      ["no change"],
    );
  });

  it("gives the user's newest reactions on the bot's messages since the chat was cleared", () => {
    const reactions = { "a:1": "👍", "user:2": "❤️", gone: "😂", "a:3": "‼️", "a:2": "❓" };
    assert.deepEqual(reactedMessages({ reactions, messages, max: 2 }), [
      { emoji: "‼️", text: "Saved." },
      { emoji: "❓", text: "Will do." },
    ]);
    assert.deepEqual(
      reactedMessages({ reactions, messages, historyFromMs: t0 + 5 * MIN, max: 5 }),
      [
        { emoji: "‼️", text: "Saved." },
        { emoji: "❓", text: "Will do." },
      ],
    );
    assert.deepEqual(reactedMessages({ reactions: undefined, messages, max: 5 }), []);
  });
});

describe("wakeSummary", () => {
  it("keeps the first two lines of a reply", () => {
    assert.equal(
      wakeSummary("DOWN gpu-vm since 12:00\n\nRECOVERED nas1 after 5 min\nmore detail"),
      "DOWN gpu-vm since 12:00 / RECOVERED nas1 after 5 min",
    );
  });
});

describe("wakeAnswer", () => {
  const said = (text: string) => ({
    type: "assistant_message" as const,
    messageId: MessageId.make(text),
  });
  const call = (toolName: string, pushed?: string) => ({
    type: "dynamic_tool" as const,
    toolName,
    input: pushed === undefined ? {} : { text: pushed },
  });
  const edited = { type: "file_change" as const };
  const answer = (
    steps: ReadonlyArray<ReturnType<typeof said> | ReturnType<typeof call> | typeof edited>,
  ) =>
    wakeAnswer(
      steps.map((step, ordinal) => ({ ...step, ordinal })),
      steps.flatMap((step) =>
        step.type === "assistant_message"
          ? [
              {
                id: step.messageId,
                role: "assistant" as const,
                text: step.messageId,
                streaming: false,
              },
            ]
          : [],
      ),
    );
  const digest = "1. XSS в uBlock Origin: обнови.\n2. Qwen4-Max вышел.";
  const pushed = "Дайджест: XSS в uBlock, Qwen4-Max.";

  it.each([
    {
      name: "the digest written before its push, not the line reporting the push",
      steps: [
        said("Ищу новости."),
        call("mcp__t3-code__computer_shell"),
        said(digest),
        call("mcp__t3-code__notify_user", pushed),
        said("Дайджест отправлен."),
      ],
      want: digest,
    },
    {
      // The 06:33 digest of 2026-11-16 with its bookkeeping moved before the push.
      name: "the digest when a call ran between it and a short push",
      steps: [
        call("mcp__t3-code__web_browse"),
        said(digest),
        call("mcp__t3-code__computer_shell"),
        call("mcp__t3-code__notify_user", pushed),
        said("Дайджест отправлен."),
      ],
      want: digest,
    },
    {
      name: "the digest over a short line written between bookkeeping and the push",
      steps: [
        call("mcp__t3-code__web_browse"),
        said(digest),
        call("mcp__t3-code__computer_shell"),
        said("Отправляю."),
        call("mcp__t3-code__notify_user", pushed),
        said("Дайджест отправлен."),
      ],
      want: digest,
    },
    {
      name: "the digest when bookkeeping follows its push",
      steps: [
        call("mcp__t3-code__web_browse"),
        said(digest),
        call("mcp__t3-code__notify_user", pushed),
        call("mcp__t3-code__computer_shell"),
        said("Записал в sent.txt."),
      ],
      want: digest,
    },
    {
      // A real watch wake (2026-11-17): narration first, the work, the push, then the reply.
      name: "one answer, never the narration written before the work",
      steps: [
        said("I'll start by loading the tools I need and checking the current state file."),
        call("ToolSearch"),
        call("Read"),
        call("mcp__t3-code__web_browse"),
        edited,
        call(
          "mcp__t3-code__notify_user",
          "Из мини-ПК новое: slim ПК i5-6400, 32 ГБ, 8 000 грн, Львов.\nhttps://www.olx.ua/d/uk/obyavlenie/x\n3090 до 45k пусто, DarStar и MaxPlay без рабочих карт.",
        ),
        said(
          "Один новый подходящий лот: slim ПК i5-6400, 8 000 грн. Следующая проверка около 11:53.",
        ),
      ],
      want: "Из мини-ПК новое: slim ПК i5-6400, 32 ГБ, 8 000 грн, Львов.\nhttps://www.olx.ua/d/uk/obyavlenie/x\n3090 до 45k пусто, DarStar и MaxPlay без рабочих карт.",
    },
    {
      name: "both pushes, in order, when a wake sends two",
      steps: [
        call("mcp__t3-code__web_browse"),
        call("mcp__t3-code__notify_user", "Новый лот: slim ПК i5-6400, 8 000 грн, Львов."),
        call("mcp__t3-code__web_browse"),
        call("mcp__t3-code__notify_user", "DarStar: RTX 3090 за 44 000 грн."),
        said("Готово."),
      ],
      want: "Новый лот: slim ПК i5-6400, 8 000 грн, Львов.\n\nDarStar: RTX 3090 за 44 000 грн.",
    },
    {
      name: "one copy of a text sent both to Telegram and as a push",
      steps: [
        call("mcp__t3-code__list_scheduled_tasks"),
        call("mcp__t3-code__send_telegram", "Полить цветы в 9:00, забрать посылку."),
        call("mcp__t3-code__notify_user", "Полить цветы в 9:00, забрать посылку."),
      ],
      want: "Полить цветы в 9:00, забрать посылку.",
    },
    {
      name: "the reply after the push when nothing came before it",
      steps: [
        call("mcp__t3-code__web_browse"),
        call("mcp__t3-code__notify_user"),
        said("Снега не будет."),
      ],
      want: "Снега не будет.",
    },
    {
      name: "every line after the last work",
      steps: [
        said("HDD: нового нет."),
        call("mcp__t3-code__web_browse"),
        said("Свитч: два лота."),
        said("Остальное без изменений."),
      ],
      want: "Свитч: два лота.\n\nОстальное без изменений.",
    },
  ])("takes $name", ({ steps, want }) => {
    assert.equal(answer(steps), want);
  });
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_KICKOFF_MESSAGE_PREFIX,
  type BotInput,
  type BotPreferences,
  type BotRecord,
  BOT_TEMPLATES,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  botTemplate,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type SetupTemplateId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { BotFilesToolkit } from "../mcp/toolkits/botFiles/tools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "./BotService.ts";
import * as BotSetup from "./BotSetup.ts";
import * as BotStore from "./BotStore.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";

const model = { instanceId: ProviderInstanceId.make("deepseek"), model: "deepseek-v4.1-flash" };
const record = (input: BotInput, threadId: string): BotRecord => ({
  ...input,
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-09T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
});
const MAIN = record(
  { name: "Помічник", persona: "Front door", modelSelection: model, dailyTokenCap: 100 },
  "main",
);
const OTHER = record(
  { name: "Research", persona: "Research", modelSelection: model, dailyTokenCap: 100 },
  "research",
);
const STEWARD = record(
  { name: "Steward", persona: "Steward", modelSelection: model, dailyTokenCap: 100 },
  STEWARD_THREAD_ID,
);

const scope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  botThreadId: threadId,
  client: undefined,
  thread: { threadId, providerSessionId: "session", providerInstanceId: model.instanceId },
});

interface ChatMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdBy: "user" | "agent";
  readonly createdAt: DateTime.Utc;
}
const chatMessage = (
  id: string,
  role: ChatMessage["role"],
  text: string,
  createdBy: ChatMessage["createdBy"] = role === "user" ? "user" : "agent",
): ChatMessage => ({
  id: MessageId.make(id),
  role,
  text,
  createdBy,
  createdAt: DateTime.makeUnsafe(0),
});

const setup = ({
  asked = "user",
  text = "Так, створи їх",
  main = MAIN,
  others = [STEWARD, OTHER],
  onboarding = {},
  mainChat,
  failedSends = 0,
}: {
  readonly asked?: "user" | "agent";
  readonly text?: string;
  readonly main?: BotRecord | null;
  readonly others?: ReadonlyArray<BotRecord>;
  readonly onboarding?: BotStore.Onboarding;
  /** The main bot's chat; by default the one message `asked` sent with `text`. */
  readonly mainChat?: ReadonlyArray<ChatMessage>;
  /** How many sends fail before they start working. */
  readonly failedSends?: number;
} = {}) => {
  const created: Array<BotInput> = [];
  const launched: Array<{ threadId: ThreadId; messageId: MessageId; text: string }> = [];
  const chats = new Map<string, Array<ChatMessage>>();
  if (main)
    chats.set(main.threadId, [...(mainChat ?? [chatMessage("asked", "user", text, asked)])]);
  let failsLeft = failedSends;
  const state: {
    main: ThreadId | undefined;
    preferences: BotPreferences;
    onboarding: BotStore.Onboarding;
  } = { main: main?.threadId ?? undefined, preferences: {}, onboarding };
  const bots = new Map([...others, ...(main ? [main] : [])].map((bot) => [bot.threadId, bot]));
  const layer = BotSetup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BotStore.BotStore)({
          mainBot: Effect.sync(() => state.main),
          list: Effect.sync(() =>
            [...bots.values()].map((bot) => ({
              ...bot,
              tokensToday: 0,
              usage: [],
              stopped: false,
              resumesAt: null,
            })),
          ),
          get: (id) => Effect.succeed(bots.get(id)),
          named: (name) => Effect.succeed([...bots.values()].find((bot) => bot.name === name)),
          wake: () => Effect.undefined,
          startWake: () => Effect.void,
          setMainBot: (id) =>
            Effect.sync(() => {
              state.main = id ?? undefined;
            }),
          setPreferences: (change) =>
            Effect.sync(() => (state.preferences = { ...state.preferences, ...change })),
          onboarding: Effect.sync(() => state.onboarding),
          updateOnboarding: (change) =>
            Effect.sync(() => (state.onboarding = change(state.onboarding))),
        }),
        Layer.mock(BotService.BotService)({
          create: (input) =>
            Effect.sync(() => {
              created.push(input);
              const bot = record(input, `bot-${created.length}`);
              bots.set(bot.threadId, bot);
              return bot;
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          sendToThread: (input) =>
            failsLeft-- > 0
              ? Effect.fail(new Error("provider instance disabled") as never)
              : Effect.sync(() => {
                  launched.push({
                    threadId: input.threadId,
                    messageId: input.messageId,
                    text: input.text,
                  });
                  return {} as never;
                }),
          getThreadShell: () => Effect.succeed({ activeRunId: RunId.make("run") } as never),
          getThreadRecords: (threadId, fields) =>
            Effect.succeed(
              ((fields as ReadonlyArray<string>).includes("runs")
                ? { runs: [{ id: RunId.make("run"), userMessageId: MessageId.make("asked") }] }
                : { messages: chats.get(threadId) ?? [] }) as never,
            ),
        }),
      ),
    ),
    Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, created, launched, state, chats };
};

const tap = (setupBots: BotSetup.BotSetup["Service"], proposalId: string) =>
  setupBots.proposal.pipe(
    Effect.flatMap((pending) =>
      setupBots.approve(
        proposalId,
        pending?.id === proposalId ? pending.nonce : "",
        MessageId.make("create"),
      ),
    ),
  );

const approved = (
  setupBots: BotSetup.BotSetup["Service"],
  templates: ReadonlyArray<SetupTemplateId>,
) =>
  setupBots
    .propose(scope(MAIN.threadId), templates)
    .pipe(Effect.tap(({ proposalId }) => tap(setupBots, proposalId)));

it.effect(
  "the main bot makes a bot the user approved, in the chat's language, and shows it",
  () => {
    const { layer, created, launched, state } = setup();
    return Effect.gen(function* () {
      const setupBots = yield* BotSetup.BotSetup;
      const proposed = yield* approved(setupBots, ["bookkeeping"]);
      assert.deepEqual(proposed.bots, ["Бухгалтерія"]);
      const result = yield* setupBots.create(scope(MAIN.threadId), "bookkeeping");
      const template = botTemplate("bookkeeping");
      assert.deepEqual(created, [
        {
          name: "Бухгалтерія",
          persona: template.persona,
          description: template.text.uk.purpose,
          modelSelection: model,
          dailyTokenCap: DEFAULT_BOT_DAILY_TOKEN_CAP,
          starters: [...template.text.uk.examples],
          tools: [...template.tools],
        },
      ]);
      const [task, ...more] = launched;
      assert.deepEqual(more, []);
      assert.equal(task?.threadId, ThreadId.make("bot-1"));
      assert.equal(
        result.example,
        "Це приклад рахунків, invoices.csv. Що з них треба оплатити цього тижня і скільки всього?",
      );
      assert.match(
        task?.text ?? "",
        /^\[Task from the user, through .+\]\nЦе приклад рахунків.*\n\ninvoices\.csv:\n```\nДата,Контрагент/,
      );
      assert.include(task?.text ?? "", "не сплачено");
      assert.deepEqual(state.onboarding, {});
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { who: "a typed yes without the Create tap", tapped: false },
  { who: "a yes another bot sent the main bot", asked: "agent", tapped: false },
  { who: "an unrelated message", text: "Яка завтра погода?", tapped: false },
  { who: "the main bot before it proposed, in the same turn", proposed: [] },
  { who: "the main bot for a bot it did not propose", proposed: ["bookkeeping"] },
  { who: "the main bot once a new proposal replaced the approved one", reproposed: true },
  { who: "a bot that is not the main bot", caller: OTHER.threadId },
] as const satisfies ReadonlyArray<{
  who: string;
  asked?: "user" | "agent";
  text?: string;
  tapped?: boolean;
  proposed?: ReadonlyArray<SetupTemplateId>;
  reproposed?: boolean;
  caller?: ThreadId;
}>)("$who cannot create bots", (row) => {
  const { layer, created, launched } = setup({
    ...("asked" in row ? { asked: row.asked } : {}),
    ...("text" in row ? { text: row.text } : {}),
  });
  return Effect.gen(function* () {
    const setupBots = yield* BotSetup.BotSetup;
    const proposed = "proposed" in row ? row.proposed : (["mail"] as const);
    if (proposed.length > 0) {
      const { proposalId } = yield* setupBots.propose(scope(MAIN.threadId), proposed);
      if (!("tapped" in row)) yield* tap(setupBots, proposalId);
    }
    if ("reproposed" in row) yield* setupBots.propose(scope(MAIN.threadId), ["mail"]);
    const caller = "caller" in row ? row.caller : MAIN.threadId;
    const error = yield* Effect.flip(setupBots.create(scope(caller), "mail"));
    assert.equal(error.code, "capability_denied");
    assert.deepEqual(created, []);
    assert.deepEqual(launched, []);
  }).pipe(Effect.provide(layer));
});

it.effect("what the main bot sees cannot approve its own proposal", () => {
  const { layer, created, state } = setup();
  return Effect.gen(function* () {
    const setupBots = yield* BotSetup.BotSetup;
    const proposal = yield* setupBots.propose(scope(MAIN.threadId), ["mail"]);
    assert.deepEqual(Object.keys(proposal).sort(), ["bots", "next", "proposalId"]);
    yield* Effect.flip(
      setupBots.approve(proposal.proposalId, proposal.proposalId, MessageId.make("create")),
    );
    yield* Effect.flip(setupBots.approve(proposal.proposalId, "", MessageId.make("create")));
    yield* Effect.flip(setupBots.create(scope(MAIN.threadId), "mail"));
    assert.deepEqual(created, []);
    assert.isUndefined(state.onboarding.proposal?.approved);
    yield* tap(setupBots, proposal.proposalId);
    yield* setupBots.create(scope(MAIN.threadId), "mail");
    assert.lengthOf(created, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("one Create tap approves each proposed bot once, all six templates", () => {
  const { layer, created, state } = setup();
  const decode = Schema.decodeUnknownSync(BotFilesToolkit.tools.bot_create.parametersSchema);
  const ids = BOT_TEMPLATES.flatMap((template) => (template.id === "main" ? [] : [template.id]));
  return Effect.gen(function* () {
    const setupBots = yield* BotSetup.BotSetup;
    const templates = ids.map((id) => decode({ template: id }).template);
    const stale = yield* setupBots.propose(scope(MAIN.threadId), ["mail"]);
    const { proposalId } = yield* setupBots.propose(scope(MAIN.threadId), templates);
    yield* Effect.flip(tap(setupBots, stale.proposalId));
    yield* tap(setupBots, proposalId);
    for (const id of templates) yield* setupBots.create(scope(MAIN.threadId), id);
    assert.deepEqual(
      created.map((bot) => bot.name),
      ids.map((id) => botTemplate(id).text.uk.name),
    );
    const again = yield* Effect.flip(setupBots.create(scope(MAIN.threadId), "mail"));
    assert.equal(again.code, "capability_denied");
    yield* Effect.flip(tap(setupBots, proposalId));
    assert.deepEqual(state.onboarding, {});
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    who: "someone new on a new instance",
    experience: "new",
    main: null,
    others: [STEWARD],
    greets: 1,
  },
  {
    who: "someone experienced on a new instance",
    experience: "experienced",
    main: null,
    others: [STEWARD],
    greets: 1,
  },
  {
    who: "someone new who has bots",
    experience: "new",
    main: null,
    others: [STEWARD, OTHER],
    greets: 0,
  },
  {
    who: "someone new who has a main bot",
    experience: "new",
    main: MAIN,
    others: [STEWARD],
    greets: 0,
  },
] as const)(
  "setup makes one main bot and greets and tours $who $greets times",
  ({ experience, main, others, greets }) => {
    const { layer, created, launched, state } = setup({ main, others });
    return Effect.gen(function* () {
      const setupBots = yield* BotSetup.BotSetup;
      const made = yield* setupBots.setup({ language: "ru", experience });
      if (main === null) {
        assert.equal(made.name, "Помощник");
        assert.deepEqual(created[0]?.tools, [...botTemplate("main").tools]);
      }
      assert.equal(state.main, made.threadId);
      assert.deepEqual(state.preferences, { language: "ru", experience });
      assert.lengthOf(launched, greets);
      if (greets) {
        assert.match(launched[0]?.text ?? "", /^\[First run\] /);
        assert.deepEqual(
          [launched[0]?.threadId, launched[0]?.messageId],
          [made.threadId, `${BOT_KICKOFF_MESSAGE_PREFIX}${made.threadId}`],
        );
      }
      assert.equal(
        (yield* setupBots.setup({ language: "uk", experience })).threadId,
        made.threadId,
      );
      assert.lengthOf(created, main === null ? 1 : 0);
      assert.lengthOf(launched, greets);
      assert.equal(state.preferences.language, "uk");
      assert.deepEqual(state.onboarding, greets ? { kickoff: "done", tour: "pending" } : {});
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([{ via: "restart" }, { via: "retry" }] as const)(
  "a first run cut off before its greeting greets once on a $via",
  ({ via }) => {
    const { layer, created, launched, state } = setup({
      onboarding: { kickoff: "pending" },
      mainChat: [],
    });
    return Effect.gen(function* () {
      const setupBots = yield* BotSetup.BotSetup;
      const resume =
        via === "restart"
          ? setupBots.start()
          : setupBots.setup({ language: "uk", experience: "new" }).pipe(Effect.asVoid);
      yield* resume;
      yield* resume;
      assert.deepEqual(created, []);
      assert.lengthOf(launched, 1);
      assert.match(launched[0]?.text ?? "", /^\[First run\] /);
      assert.deepEqual(state.onboarding, { kickoff: "done" });
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { after: "the chat stays empty", message: null, greets: 1 },
  { after: "the user writes", message: chatMessage("u1", "user", "привет"), greets: 0 },
  { after: "the bot replies", message: chatMessage("a1", "assistant", "Привет!"), greets: 0 },
] as const)(
  "a greeting that failed is retried $greets times after $after, and never posts into history",
  ({ message, greets }) => {
    const { layer, launched, state, chats } = setup({
      main: null,
      others: [STEWARD],
      failedSends: 1,
    });
    return Effect.gen(function* () {
      const setupBots = yield* BotSetup.BotSetup;
      const made = yield* setupBots.setup({ language: "ru", experience: "new" });
      assert.lengthOf(launched, 0);
      assert.deepEqual(state.onboarding, { kickoff: "pending", tour: "pending" });
      if (message) chats.set(made.threadId, [message]);
      yield* setupBots.start();
      yield* setupBots.setup({ language: "ru", experience: "new" });
      assert.lengthOf(launched, greets);
      assert.deepEqual(
        state.onboarding,
        greets ? { kickoff: "done", tour: "pending" } : { kickoff: "done", tour: "done" },
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("the main bot's first show_ui ends a pending tour, and only the main bot points", () => {
  const { layer, state } = setup({ onboarding: { kickoff: "done", tour: "pending" } });
  return Effect.gen(function* () {
    const setupBots = yield* BotSetup.BotSetup;
    const refused = yield* Effect.flip(
      setupBots.showUi(scope(OTHER.threadId), { target: "dictation", text: "Tap" }),
    );
    assert.equal(refused.code, "capability_denied");
    assert.equal(state.onboarding.tour, "pending");
    const shown = yield* setupBots.showUi(scope(MAIN.threadId), {
      target: "dictation",
      text: "Tap",
    });
    assert.deepEqual(shown, { shown: "dictation", next: BotSetup.SHOWN_NEXT });
    assert.deepEqual(state.onboarding, { kickoff: "done", tour: "done" });
    yield* setupBots.showUi(scope(MAIN.threadId), { target: "accounts", text: "Tap" });
    assert.deepEqual(state.onboarding, { kickoff: "done", tour: "done" });
  }).pipe(Effect.provide(layer));
});

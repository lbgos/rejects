/** Only the user's Create tap approves a proposal (`approve`, from the client, never a message). */
import {
  BOT_EXAMPLE_MESSAGE_PREFIX,
  BOT_KICKOFF_MESSAGE_PREFIX,
  BOTS_ENDPOINTS,
  isBotKickoffMessage,
  type BotInput,
  type BotRecord,
  type BotTemplate,
  type BotTextLanguage,
  CommandId,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  MessageId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type SetupTemplateId,
  type ShowUiInput,
  type UiTarget,
  botTemplate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { BotToolName } from "../mcp/BotTools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";
import { userTaskPrefix, wakeLanguageLine } from "./instructions.ts";
import { chatLanguageOf } from "./language.ts";
import { STEWARD_MODEL, STEWARD_THREAD_ID } from "./steward.ts";

const templateBot = (
  template: BotTemplate,
  language: BotTextLanguage,
  modelSelection: ModelSelection,
): BotInput => {
  const text = template.text[language];
  // Fails typecheck when a template names a tool bots do not have.
  const tools: ReadonlyArray<BotToolName> = template.tools;
  return {
    name: text.name,
    persona: template.persona,
    description: text.purpose,
    modelSelection,
    dailyTokenCap: DEFAULT_BOT_DAILY_TOKEN_CAP,
    starters: [...text.examples],
    tools: [...tools],
  };
};

const dayOffset = (today: DateTime.Utc, days: number) =>
  DateTime.formatIsoDate(DateTime.add(today, { days }));

const invoices = (today: DateTime.Utc) =>
  [
    "Дата,Контрагент,Рахунок,Сума грн,Сплатити до,Статус",
    `${dayOffset(today, -9)},ТОВ «Альфа-Сервіс»,А-118,4200.00,${dayOffset(today, 2)},не сплачено`,
    `${dayOffset(today, -6)},ФОП Коваленко О. В.,47,1850.00,${dayOffset(today, 4)},не сплачено`,
    `${dayOffset(today, -20)},ТОВ «Київ Енерго Збут»,Е-2025,3120.40,${dayOffset(today, -1)},не сплачено`,
    `${dayOffset(today, -15)},ТОВ «Нова Пошта»,НП-5531,640.00,${dayOffset(today, -5)},сплачено`,
    `${dayOffset(today, -2)},ТОВ «Бета Софт»,Б-903,12000.00,${dayOffset(today, 18)},не сплачено`,
    "",
  ].join("\n");

const contract = (today: DateTime.Utc) =>
  [
    "ДОГОВІР № 12/11 про надання послуг",
    `м. Київ, ${dayOffset(today, -30)}`,
    "",
    "ТОВ «Бета Софт» (Виконавець) і ФОП Мельник Ірина Петрівна (Замовник) уклали цей договір.",
    "",
    "1. Виконавець щомісяця веде бухгалтерський облік Замовника.",
    "2. Вартість послуг: 4 000,00 грн на місяць, без ПДВ.",
    "3. Замовник оплачує послуги до 5 числа наступного місяця на підставі акта.",
    "4. За прострочення оплати Замовник сплачує пеню 0,1% від суми боргу за кожен день, але не більше подвійної облікової ставки НБУ.",
    "5. Виконавець подає звітність Замовника не пізніше ніж за 3 робочі дні до кінцевого строку.",
    `6. Договір діє до 31 грудня ${DateTime.getPartUtc(today, "year")} року і продовжується на рік, якщо жодна сторона не повідомила про розірвання за 30 днів.`,
    "7. Сторона, що розриває договір достроково, письмово повідомляє іншу за 30 днів.",
    "",
    "Виконавець: ТОВ «Бета Софт», код ЄДРПОУ 12345678",
    "Замовник: ФОП Мельник І. П., РНОКПП 1234567890",
    "",
  ].join("\n");

const article = [
  "Як підготуватися до кінця кварталу",
  "",
  "Перше: звірте всі рахунки з виписками банку до 25 числа, щоб не шукати платежі в останній день.",
  "Друге: попросіть клієнтів підписати акти за квартал, поки вони пам’ятають роботу.",
  "Третє: відкладіть суму податку на окремий рахунок одразу, а не в день сплати.",
  "Наостанок: заплануйте годину на перевірку звітності за три робочі дні до строку.",
  "",
].join("\n");

const demoOf = (id: SetupTemplateId, language: BotTextLanguage, today: DateTime.Utc) => {
  switch (id) {
    case "bookkeeping":
      return {
        question: {
          en: "This is a sample of invoices, invoices.csv. What is due this week, and how much in total?",
          uk: "Це приклад рахунків, invoices.csv. Що з них треба оплатити цього тижня і скільки всього?",
          ru: "Это пример счетов, invoices.csv. Что из них нужно оплатить на этой неделе и сколько всего?",
        }[language],
        sample: { name: "invoices.csv", text: invoices(today) },
      };
    case "documents":
      return {
        question: {
          en: "This is a sample contract, contract.txt. What are its deadlines, sums and penalties?",
          uk: "Це приклад договору, contract.txt. Які в ньому строки, суми й штрафи?",
          ru: "Это пример договора, contract.txt. Какие в нём сроки, суммы и штрафы?",
        }[language],
        sample: { name: "contract.txt", text: contract(today) },
      };
    case "digest":
      return {
        question: {
          en: "This is a sample text, article.txt. Sum it up in at most three bullets.",
          uk: "Це приклад тексту, article.txt. Підсумуй його щонайбільше трьома пунктами.",
          ru: "Это пример текста, article.txt. Подытожь его максимум тремя пунктами.",
        }[language],
        sample: { name: "article.txt", text: article },
      };
    case "mail":
    case "morning":
      return { question: botTemplate(id).text[language].examples[0], sample: null };
    case "watch":
      return null;
  }
};

/** The sample rides in the task text: a sandboxed bot cannot open a file the server attaches. */
const demoTask = ({ question, sample }: NonNullable<ReturnType<typeof demoOf>>) =>
  sample === null ? question : `${question}\n\n${sample.name}:\n\`\`\`\n${sample.text}\`\`\``;

/** @public */
export const PROPOSED_NEXT =
  "The user now sees Create and Not now buttons under your message. Do not call offer_replies; end your turn. A tap on Create arrives as that button's text: then call bot_create once for each proposed bot.";

/** @public */
export const CREATE_REFUSED =
  "Only the user's tap on Create under your proposal approves bots, and the buttons go away once the user writes. Call propose_bots again with the bots they want, so the buttons show under your reply, and end your turn.";

export class StaleProposalError extends Schema.TaggedError<StaleProposalError>()(
  "StaleProposalError",
  {},
) {
  override get message() {
    return "This proposal is out of date. Ask the main bot again.";
  }
}

const KICKOFF =
  "The user has just set up rejects and opened it for the first time; they have no bots yet. Start the app tour now: read skill app-tour and follow it.";

export const SHOWN_NEXT =
  "The user sees that place highlighted with your text until they dismiss it; another show_ui call shows after this one. Do not repeat the tip in your reply.";

export class BotSetup extends Context.Service<
  BotSetup,
  {
    readonly propose: (
      scope: McpInvocationContext.McpInvocationScope,
      templates: ReadonlyArray<SetupTemplateId>,
    ) => Effect.Effect<
      {
        readonly proposalId: string;
        readonly bots: ReadonlyArray<string>;
        readonly next: string;
      },
      OrchestratorMcpFailure
    >;
    readonly proposal: Effect.Effect<{ readonly id: string; readonly nonce: string } | null>;
    readonly approve: (
      proposalId: string,
      nonce: string,
      messageId: string,
    ) => Effect.Effect<void, StaleProposalError | BotStore.BotStoreError>;
    readonly release: (proposalId: string) => Effect.Effect<void, BotStore.BotStoreError>;
    readonly create: (
      scope: McpInvocationContext.McpInvocationScope,
      template: SetupTemplateId,
    ) => Effect.Effect<
      { readonly bot: string; readonly example: string | null; readonly next: string },
      OrchestratorMcpFailure
    >;
    readonly setup: (
      preferences: typeof BOTS_ENDPOINTS.setup.payload.Type,
    ) => Effect.Effect<BotRecord, BotService.BotServiceError | BotStore.BotStoreError>;
    /** `show_ui`: the main bot points at a place in the app; its first call ends a pending tour. */
    readonly showUi: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ShowUiInput,
    ) => Effect.Effect<{ readonly shown: UiTarget; readonly next: string }, OrchestratorMcpFailure>;
    readonly start: () => Effect.Effect<void>;
  }
>()("t3/bots/BotSetup") {}

const make = Effect.gen(function* () {
  const bots = yield* BotStore.BotStore;
  const service = yield* BotService.BotService;
  const threads = yield* Threads.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;
  const refuse = (message: string) =>
    new OrchestratorMcpFailure({ code: "capability_denied", message });
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  const updateOnboarding = (change: (current: BotStore.Onboarding) => BotStore.Onboarding) =>
    bots.updateOnboarding(change).pipe(Effect.mapError((error) => invalid(error.message)));

  const callerMain = Effect.fn("BotSetup.callerMain")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    refusal = "Only the main bot proposes and creates bots.",
  ) {
    const mainId = yield* bots.mainBot;
    const main = mainId === undefined ? undefined : yield* bots.get(mainId);
    const caller = scope.botThreadId ?? scope.thread?.threadId;
    if (main === undefined || caller !== main.threadId) return yield* refuse(refusal);
    return main;
  });

  // The greeting is a turn in the main bot's own chat, so its show_ui calls reach the client.
  // The prompt is hidden there; the id is stable, so a retry starts no second turn.
  const greet = Effect.fn("BotSetup.greet")(function* (main: BotRecord) {
    if ((yield* bots.onboarding).kickoff !== "pending") return;
    // A greeting that failed earlier must not land after the chat has started.
    const { messages } = yield* threads.getThreadRecords(main.threadId, ["messages"]);
    if (messages.some((message) => !isBotKickoffMessage(message.id))) {
      yield* bots.updateOnboarding((current) => ({ ...current, kickoff: "done", tour: "done" }));
      return;
    }
    const id = `${BOT_KICKOFF_MESSAGE_PREFIX}${main.threadId}`;
    yield* threads.sendToThread({
      projectId: main.projectId,
      commandId: CommandId.make(id),
      threadId: main.threadId,
      messageId: MessageId.make(id),
      text: `[First run] ${KICKOFF}\n${wakeLanguageLine(yield* chatLanguageOf(threads, main.threadId))}`,
      attachments: [],
      mode: "auto",
      createdBy: "agent",
      creationSource: "server",
    });
    yield* bots.updateOnboarding((current) => ({ ...current, kickoff: "done" }));
  });

  const createMain = Effect.fn("BotSetup.createMain")(function* (
    language: BotTextLanguage,
    picked: ModelSelection | undefined,
  ) {
    const model = picked ?? (yield* BotStore.standingBot(bots))?.modelSelection ?? STEWARD_MODEL;
    const input = templateBot(botTemplate("main"), language, model);
    const main = yield* service.create(input).pipe(
      Effect.catchIf(
        (error) => error._tag === "BotStoreError" && error.operation === "duplicate",
        (error) =>
          bots.named(input.name).pipe(Effect.filterOrFail(Predicate.isNotUndefined, () => error)),
      ),
    );
    yield* bots.setMainBot(main.threadId);
    return main;
  });

  return BotSetup.of({
    propose: Effect.fn("BotSetup.propose")(function* (scope, templates) {
      const main = yield* callerMain(scope);
      const language = yield* chatLanguageOf(threads, main.threadId);
      const proposed = [...new Set(templates)].map((template) => ({
        template,
        name: botTemplate(template).text[language].name,
      }));
      const proposalId = yield* crypto.uuidV4().pipe(Effect.orDie);
      const nonce = yield* crypto.uuidV4().pipe(Effect.orDie);
      yield* updateOnboarding((current) => ({
        ...current,
        proposal: { id: proposalId, nonce, botThreadId: main.threadId, bots: proposed },
      }));
      return { proposalId, bots: proposed.map((bot) => bot.name), next: PROPOSED_NEXT };
    }),

    proposal: bots.onboarding.pipe(
      Effect.map(({ proposal }) =>
        proposal?.nonce === undefined ? null : { id: proposal.id, nonce: proposal.nonce },
      ),
    ),

    approve: Effect.fn("BotSetup.approve")(function* (proposalId, nonce, messageId) {
      if (!(yield* BotStore.approveProposal(bots, proposalId, nonce, messageId)))
        return yield* new StaleProposalError();
    }),

    release: Effect.fn("BotSetup.release")(function* (proposalId) {
      yield* BotStore.releaseProposal(bots, proposalId);
    }),

    create: Effect.fn("BotSetup.create")(function* (scope, id) {
      const main = yield* callerMain(scope);
      const { proposal } = yield* bots.onboarding;
      if (
        proposal?.botThreadId !== main.threadId ||
        proposal.approved !== true ||
        !proposal.bots.some((bot) => bot.template === id)
      )
        return yield* refuse(CREATE_REFUSED);
      const language = yield* chatLanguageOf(threads, main.threadId);
      const record = yield* service
        .create(templateBot(botTemplate(id), language, main.modelSelection))
        .pipe(
          Effect.mapError((error) =>
            error._tag === "BotStoreError" && error.operation === "duplicate"
              ? invalid(`${botTemplate(id).text[language].name} already exists.`)
              : invalid(error.message),
          ),
        );
      yield* updateOnboarding(({ proposal: current, ...rest }) => {
        const left = current?.bots.filter((bot) => bot.template !== id) ?? [];
        return current === undefined || left.length === 0
          ? rest
          : { ...rest, proposal: { ...current, bots: left } };
      });
      const demo = demoOf(id, language, yield* DateTime.now);
      if (demo === null)
        return {
          bot: record.name,
          example: null,
          next: `${record.name} is created and waits for the user's first request in its own chat. Create the other bots the user agreed to, then name them in one line and end your turn.`,
        };
      const exampleId = `${BOT_EXAMPLE_MESSAGE_PREFIX}${record.threadId}`;
      const started = yield* threads
        .sendToThread({
          projectId: record.projectId,
          commandId: CommandId.make(exampleId),
          threadId: record.threadId,
          senderThreadId: main.threadId,
          messageId: MessageId.make(exampleId),
          text: `${userTaskPrefix(main.name)}\n${demoTask(demo)}`,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("a new bot's example did not start", { error }).pipe(
              Effect.as(false),
            ),
          ),
        );
      return {
        bot: record.name,
        example: started ? demo.question : null,
        next: started
          ? `${record.name} is running this example now and answers in its own chat. Create the other bots the user agreed to, then name them in one line and end your turn.`
          : `${record.name} is created, but its example did not start. Tell the user it is in their bot list.`,
      };
    }),

    setup: Effect.fn("BotSetup.setup")(function* ({ language, experience, modelSelection }) {
      yield* bots.setPreferences({ language, experience });
      const current = yield* bots.mainBot;
      const existing = current === undefined ? undefined : yield* bots.get(current);
      const firstRun =
        existing === undefined &&
        (yield* bots.list).every((bot) => bot.threadId === STEWARD_THREAD_ID);
      // Only a fresh instance's first run greets and tours; one that already had a main bot never
      // does. The greeting stays due until its wake starts, so a cut-off first run resumes it.
      yield* bots.updateOnboarding((onboarding) =>
        firstRun && onboarding.kickoff === undefined
          ? { ...onboarding, kickoff: "pending", tour: "pending" }
          : onboarding,
      );
      // The first run's pick also moves Steward off its default model, which a new machine lacks.
      if (firstRun && modelSelection !== undefined && (yield* bots.get(STEWARD_THREAD_ID)))
        yield* bots.edit(STEWARD_THREAD_ID, (steward) => ({ ...steward, modelSelection }));
      const main = existing ?? (yield* createMain(language, modelSelection));
      // A greeting that did not start stays due; the next start or first run tries again.
      yield* greet(main).pipe(Effect.ignore({ log: true }));
      return main;
    }),

    showUi: Effect.fn("BotSetup.showUi")(function* (scope, input) {
      yield* callerMain(scope, "Only the main bot points at the app.");
      if ((yield* bots.onboarding).tour === "pending")
        yield* updateOnboarding((current) => ({ ...current, tour: "done" }));
      return { shown: input.target, next: SHOWN_NEXT };
    }),

    start: Effect.fn("BotSetup.start")(
      function* () {
        const mainId = yield* bots.mainBot;
        const main = mainId === undefined ? undefined : yield* bots.get(mainId);
        if (main !== undefined) yield* greet(main);
      },
      Effect.ignore({ log: true }),
    ),
  });
});

export const layer = Layer.effect(BotSetup, make);

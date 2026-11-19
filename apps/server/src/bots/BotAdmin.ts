import {
  BOT_CHEAP_MODELS,
  BOT_ICON_GROUPS,
  BOT_OPUS_MODEL,
  BotModelTemplate,
  type BotRecord,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  type ModelSelection,
  OrchestratorMcpFailure,
  ScheduledTaskSchedule,
  type ServerProvider,
  type ThreadId,
  findBotModel,
  isBotIconName,
  similarBotIcons,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";

const ModelRef = Schema.Struct({
  instanceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
}).annotate({ description: "A provider instance and model from bot_admin_skill's models." });
const ScheduleInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  schedule: ScheduledTaskSchedule,
  enabled: Schema.optional(Schema.Boolean),
});
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60));
const Job = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000));
const Description = Schema.String.check(Schema.isMaxLength(200));
const Icon = Schema.String.check(Schema.isMaxLength(40)).annotate({
  description:
    "The bot's avatar: a lucide icon name from bot_admin_skill's icons that fits its job, such as clapperboard for a movie bot.",
});
const Cap = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Schedules = Schema.Array(ScheduleInput).check(Schema.isMaxLength(10));
const AllowCodex = Schema.Boolean.annotate({
  description: "True only when the user's request names Codex.",
});

export const BotAdminCreateInput = Schema.Struct({
  name: Name,
  job: Job,
  description: Schema.optional(Description),
  icon: Schema.optional(Icon),
  template: BotModelTemplate,
  model: Schema.optional(ModelRef),
  workerModel: Schema.optional(ModelRef),
  allowCodex: Schema.optional(AllowCodex),
  dailyTokenCap: Schema.optional(Cap),
  schedules: Schema.optional(Schedules),
});
export type BotAdminCreateInput = typeof BotAdminCreateInput.Type;
export const BotAdminUpdateInput = Schema.Struct({
  bot: Name.annotate({ description: "The bot's current name or thread id." }),
  name: Schema.optional(Name),
  job: Schema.optional(Job),
  description: Schema.optional(Description),
  icon: Schema.optional(Icon),
  template: Schema.optional(BotModelTemplate),
  model: Schema.optional(ModelRef),
  workerModel: Schema.optional(ModelRef),
  allowCodex: Schema.optional(AllowCodex),
  dailyTokenCap: Schema.optional(Cap),
  schedules: Schema.optional(Schedules),
  removeSchedules: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(20)),
  ),
});
export type BotAdminUpdateInput = typeof BotAdminUpdateInput.Type;

export const BotAdminSaved = Schema.Struct({
  bot: Schema.String,
  template: Schema.NullOr(Schema.String),
  model: Schema.String,
  workerModel: Schema.NullOr(Schema.String),
  dailyTokenCap: Schema.Number,
  schedules: Schema.Array(Schema.String),
  next: Schema.String,
});
export type BotAdminSaved = typeof BotAdminSaved.Type;
export const BotAdminSkill = Schema.Struct({
  models: Schema.Array(Schema.String),
  icons: Schema.Array(Schema.String),
  bots: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      icon: Schema.NullOr(Schema.String),
      template: Schema.NullOr(Schema.String),
      model: Schema.String,
      workerModel: Schema.NullOr(Schema.String),
      dailyTokenCap: Schema.Number,
      schedules: Schema.Array(Schema.String),
    }),
  ),
});
export type BotAdminSkill = typeof BotAdminSkill.Type;

const offered = (provider: ServerProvider) => {
  const own = provider.models.filter((m) => m.isCustom);
  return (own.length ? own : provider.models).map((m) => m.slug);
};
const usable = (provider: ServerProvider) =>
  provider.enabled &&
  (provider.supportedRuntimeModes === undefined ||
    provider.supportedRuntimeModes.includes("full-access"));
const label = (selection: ModelSelection) => `${selection.instanceId}/${selection.model}`;

export class BotAdmin extends Context.Service<
  BotAdmin,
  {
    readonly skill: (caller: ThreadId) => Effect.Effect<BotAdminSkill, OrchestratorMcpFailure>;
    readonly create: (
      caller: ThreadId,
      input: BotAdminCreateInput,
    ) => Effect.Effect<BotAdminSaved, OrchestratorMcpFailure>;
    readonly update: (
      caller: ThreadId,
      input: BotAdminUpdateInput,
    ) => Effect.Effect<BotAdminSaved, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotAdmin") {}

const make = Effect.gen(function* () {
  const bots = yield* BotStore.BotStore;
  const service = yield* BotService.BotService;
  const registry = yield* Providers.ProviderRegistry;
  const tasks = yield* Tasks.ScheduledTaskService;
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });

  const callerMain = Effect.fn("BotAdmin.callerMain")(function* (caller: ThreadId) {
    const mainId = yield* bots.mainBot;
    if (mainId === undefined || mainId !== caller)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Only the main bot creates and changes bots.",
      });
  });

  const configured = Effect.map(registry.getProviders, (all) => all.filter(usable));
  const modelsLine = (providers: ReadonlyArray<ServerProvider>) =>
    providers.map(
      (p) =>
        `${p.instanceId}${p.driver === "codex" ? " (Codex: only when the user names it)" : ""}: ${offered(p).slice(0, 12).join(", ")}`,
    );

  const check = Effect.fn("BotAdmin.check")(function* (
    providers: ReadonlyArray<ServerProvider>,
    ref: { readonly instanceId: string; readonly model: string },
    allowCodex: boolean,
  ) {
    const provider = providers.find((p) => p.instanceId === ref.instanceId);
    if (!provider)
      return yield* invalid(
        `No provider "${ref.instanceId}" here. Models: ${modelsLine(providers).join("; ")}.`,
      );
    if (provider.driver === "codex" && !allowCodex)
      return yield* invalid(
        "Codex is the user's work quota: use it only when their request names Codex.",
      );
    if (!provider.models.some((m) => m.slug === ref.model))
      return yield* invalid(
        `"${ref.instanceId}" has no model "${ref.model}". It has: ${offered(provider).join(", ")}.`,
      );
    return { instanceId: provider.instanceId, model: ref.model } satisfies ModelSelection;
  });

  const resolveModels = Effect.fn("BotAdmin.resolveModels")(function* (input: {
    readonly template: BotModelTemplate | undefined;
    readonly model: ModelSelection | { readonly instanceId: string; readonly model: string };
    readonly workerModel:
      | ModelSelection
      | { readonly instanceId: string; readonly model: string }
      | undefined;
    readonly allowCodex: boolean;
  }) {
    const providers = yield* configured;
    const modelSelection = yield* check(providers, input.model, input.allowCodex);
    if (input.template !== "lead") return { modelSelection };
    if (!input.workerModel)
      return yield* invalid(
        `The lead template needs a DeepSeek or GLM worker, and none is configured here. Models: ${modelsLine(providers).join("; ")}.`,
      );
    return {
      modelSelection,
      workerModel: yield* check(providers, input.workerModel, input.allowCodex),
    };
  });

  const templateModel = Effect.fn("BotAdmin.templateModel")(function* (
    template: BotModelTemplate,
    role: "main" | "worker",
  ) {
    const providers = yield* configured;
    const cheap = role === "worker" || template === "light";
    const found = findBotModel(providers, cheap ? BOT_CHEAP_MODELS : [BOT_OPUS_MODEL]);
    if (found) return found;
    return yield* invalid(
      `The ${template} template needs ${cheap ? "DeepSeek V4.1 Flash or GLM" : "Claude Opus 5.5"}, and none is configured here. Models: ${modelsLine(providers).join("; ")}.`,
    );
  });

  const iconOf = Effect.fn("BotAdmin.iconOf")(function* (name: string) {
    if (isBotIconName(name)) return name;
    const close = similarBotIcons(name);
    return yield* invalid(
      `No icon "${name}".${close.length ? ` Close: ${close.join(", ")}.` : ""} All names are in bot_admin_skill's icons.`,
    );
  });

  const schedulesOf = Effect.fn("BotAdmin.schedulesOf")(function* (bot: BotRecord) {
    const { tasks: all } = yield* tasks
      .list()
      .pipe(Effect.mapError((e) => invalid(`Could not read schedules: ${e.message}`)));
    return all.filter((task) => task.threadId === bot.threadId);
  });

  const applySchedules = Effect.fn("BotAdmin.applySchedules")(function* (
    bot: BotRecord,
    schedules: ReadonlyArray<typeof ScheduleInput.Type>,
    remove: ReadonlyArray<string>,
  ) {
    for (const entry of schedules)
      if (entry.schedule.type === "interval" && entry.schedule.everyMs < 300_000)
        return yield* invalid("Bot schedules must be at least five minutes apart.");
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const existing = yield* schedulesOf(bot);
    for (const title of remove) {
      const task = existing.find((t) => same(t.title, title));
      if (!task) return yield* invalid(`${bot.name} has no schedule "${title}".`);
      yield* tasks
        .delete({ id: task.id })
        .pipe(Effect.mapError((e) => invalid(`Could not delete "${title}": ${e.message}`)));
    }
    for (const entry of schedules) {
      const id = existing.find((t) => same(t.title, entry.title))?.id;
      yield* tasks
        .upsert({
          ...(id === undefined ? {} : { id }),
          title: entry.title.trim(),
          prompt: entry.prompt.trim(),
          enabled: entry.enabled ?? true,
          schedule: entry.schedule,
          projectId: bot.projectId,
          threadId: bot.threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: bot.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((e) => invalid(`Could not save schedule "${entry.title}": ${e.message}`)),
        );
    }
    return (yield* schedulesOf(bot)).map((task) => task.title);
  });

  const saved = (bot: BotRecord, schedules: ReadonlyArray<string>, next: string) => ({
    bot: bot.name,
    template: bot.modelTemplate ?? null,
    model: label(bot.modelSelection),
    workerModel: bot.workerModel ? label(bot.workerModel) : null,
    dailyTokenCap: bot.dailyTokenCap,
    schedules,
    next,
  });
  const serviceError =
    (name: string) => (error: BotService.BotServiceError | BotStore.BotStoreError) =>
      error._tag === "BotStoreError" && error.operation === "duplicate"
        ? invalid(
            `A bot named ${name} already exists. Pick another name, or change it with bot_admin_update.`,
          )
        : invalid(error.message);

  return BotAdmin.of({
    skill: Effect.fn("BotAdmin.skill")(function* (caller) {
      yield* callerMain(caller);
      const providers = yield* configured;
      const list = (yield* bots.list.pipe(Effect.mapError((e) => invalid(e.message)))).filter(
        (bot) => !bot.standalone,
      );
      return {
        models: modelsLine(providers),
        icons: Object.entries(BOT_ICON_GROUPS).map(
          ([topic, names]) => `${topic}: ${names.join(", ")}`,
        ),
        bots: yield* Effect.forEach(list, (bot) =>
          Effect.map(schedulesOf(bot), (own) => ({
            name: bot.name,
            icon: bot.icon ?? null,
            template: bot.modelTemplate ?? null,
            model: label(bot.modelSelection),
            workerModel: bot.workerModel ? label(bot.workerModel) : null,
            dailyTokenCap: bot.dailyTokenCap,
            schedules: own.map(
              (task) =>
                `${task.title}${task.enabled ? "" : " (paused)"}: ${JSON.stringify(task.schedule)}`,
            ),
          })),
        ),
      };
    }),

    create: Effect.fn("BotAdmin.create")(function* (caller, input) {
      yield* callerMain(caller);
      const icon = input.icon === undefined ? undefined : yield* iconOf(input.icon);
      const models = yield* resolveModels({
        template: input.template,
        model: input.model ?? (yield* templateModel(input.template, "main")),
        workerModel:
          input.template !== "lead"
            ? undefined
            : (input.workerModel ?? (yield* templateModel(input.template, "worker"))),
        allowCodex: input.allowCodex === true,
      });
      const bot = yield* service
        .create({
          name: input.name,
          persona: input.job,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(icon === undefined ? {} : { icon }),
          ...models,
          modelTemplate: input.template,
          dailyTokenCap: input.dailyTokenCap ?? DEFAULT_BOT_DAILY_TOKEN_CAP,
        })
        .pipe(Effect.mapError(serviceError(input.name)));
      const schedules = yield* applySchedules(bot, input.schedules ?? [], []);
      return saved(
        bot,
        schedules,
        `Created. Say in one line what you made and its template (${input.template}).`,
      );
    }),

    update: Effect.fn("BotAdmin.update")(function* (caller, input) {
      yield* callerMain(caller);
      const wanted = input.bot.trim().toLowerCase();
      // Main never changes a standalone bot: its job is the user's alone.
      const list = (yield* bots.list.pipe(Effect.mapError((e) => invalid(e.message)))).filter(
        (bot) => !bot.standalone,
      );
      const bot = list.find(
        (b) => b.name.toLowerCase() === wanted || b.threadId === input.bot.trim(),
      );
      if (!bot)
        return yield* invalid(
          `No bot named ${input.bot}. Bots: ${list.map((b) => b.name).join(", ")}.`,
        );
      const modelsChange =
        input.template !== undefined ||
        input.model !== undefined ||
        input.workerModel !== undefined;
      // A template given sets its models again; a model named alone drops the template, except
      // a lead's, which keeps its worker.
      const template =
        input.template ??
        (input.model !== undefined && bot.modelTemplate !== "lead" ? undefined : bot.modelTemplate);
      const fromTemplate = input.template !== undefined;
      const resolved = modelsChange
        ? yield* resolveModels({
            template,
            model:
              input.model ??
              (fromTemplate ? yield* templateModel(input.template, "main") : bot.modelSelection),
            workerModel:
              template !== "lead"
                ? undefined
                : (input.workerModel ??
                  (fromTemplate ? undefined : bot.workerModel) ??
                  (yield* templateModel(template, "worker"))),
            allowCodex: input.allowCodex === true,
          })
        : {
            modelSelection: bot.modelSelection,
            ...(bot.workerModel ? { workerModel: bot.workerModel } : {}),
          };
      // The model the bot already runs keeps its options, such as Opus effort.
      const keep = (picked: ModelSelection) =>
        [bot.modelSelection, bot.workerModel].find(
          (own) => own?.instanceId === picked.instanceId && own.model === picked.model,
        ) ?? picked;
      const models = {
        modelSelection: keep(resolved.modelSelection),
        ...(resolved.workerModel ? { workerModel: keep(resolved.workerModel) } : {}),
      };
      const description = input.description ?? bot.description;
      const icon = input.icon === undefined ? bot.icon : yield* iconOf(input.icon);
      const next = yield* service
        .update({
          threadId: bot.threadId,
          name: input.name ?? bot.name,
          persona: input.job ?? bot.persona,
          ...(description === undefined ? {} : { description }),
          ...(icon === undefined ? {} : { icon }),
          ...models,
          ...(template === undefined ? {} : { modelTemplate: template }),
          dailyTokenCap: input.dailyTokenCap ?? bot.dailyTokenCap,
          ...(bot.starters === undefined ? {} : { starters: bot.starters }),
          ...(bot.kind === undefined ? {} : { kind: bot.kind }),
          ...(bot.skills === undefined ? {} : { skills: bot.skills }),
          ...(bot.tools === undefined ? {} : { tools: bot.tools }),
        })
        .pipe(Effect.mapError(serviceError(input.name ?? bot.name)));
      const schedules = yield* applySchedules(
        next,
        input.schedules ?? [],
        input.removeSchedules ?? [],
      );
      return saved(next, schedules, "Saved. Say in one line what changed.");
    }),
  });
});

export const layer = Layer.effect(BotAdmin, make);

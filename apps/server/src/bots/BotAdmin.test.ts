import { assert, it } from "@effect/vitest";
import {
  type BotInput,
  type BotRecord,
  type BotSummary,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotAdmin from "./BotAdmin.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";

const MAIN = ThreadId.make("main");
const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];

const provider = (
  id: string,
  driver: string,
  catalog: ReadonlyArray<string>,
  own: ReadonlyArray<string> = [],
) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver,
    enabled: true,
    models: [
      ...catalog.map((slug) => ({ slug, isCustom: false })),
      ...own.map((slug) => ({ slug, isCustom: true })),
    ],
  }) as unknown as ServerProvider;

const PROD = [
  provider("codex", "codex", ["gpt-6.1-sol"]),
  provider("claudeDeepseek", "claudeAgent", CATALOG, ["deepseek-v4.1-flash"]),
  provider("claudeGlm", "claudeAgent", CATALOG, ["zai-glm-5-3-flash"]),
  provider("claudeAgent", "claudeAgent", CATALOG),
];

const summary = (record: BotRecord): BotSummary => ({
  ...record,
  tokensToday: 0,
  usage: [],
  stopped: false,
  resumesAt: null,
});

const setup = (providers: ReadonlyArray<ServerProvider> = PROD) => {
  const world = {
    bots: [] as Array<BotRecord>,
    created: [] as Array<BotInput>,
    updated: [] as Array<BotInput>,
    tasks: [] as Array<ScheduledTask>,
    upserts: [] as Array<ScheduledTaskUpsertInput>,
  };
  const record = (input: BotInput, threadId: ThreadId): BotRecord => ({
    ...input,
    threadId,
    projectId: ProjectId.make("bots"),
    createdAt: "2026-11-11T00:00:00Z",
    unread: false,
    lastNotification: null,
    notifiedAt: null,
  });
  const layer = BotAdmin.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(BotStore.BotStore)({
          mainBot: Effect.succeed(MAIN),
          list: Effect.sync(() => world.bots.map(summary)),
        }),
        Layer.mock(BotService.BotService)({
          create: (input) =>
            Effect.sync(() => {
              world.created.push(input);
              const bot = record(input, ThreadId.make(`bot-${world.bots.length}`));
              world.bots.push(bot);
              return bot;
            }),
          update: ({ threadId, ...input }) =>
            Effect.sync(() => {
              world.updated.push(input);
              const bot = record(input, threadId);
              world.bots = world.bots.map((b) => (b.threadId === threadId ? bot : b));
              return bot;
            }),
        }),
        Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        Layer.mock(Tasks.ScheduledTaskService)({
          list: () => Effect.sync(() => ({ tasks: world.tasks })),
          upsert: (input) =>
            Effect.sync(() => {
              world.upserts.push(input);
              const task = {
                ...input,
                id: input.id ?? ScheduledTaskId.make(`task-${world.upserts.length}`),
                threadId: input.threadId ?? null,
              } as unknown as ScheduledTask;
              world.tasks = [...world.tasks.filter((t) => t.id !== task.id), task];
              return { task } as never;
            }),
          delete: ({ id }) =>
            Effect.sync(() => {
              world.tasks = world.tasks.filter((t) => t.id !== id);
              return { id } as never;
            }),
        }),
      ),
    ),
  );
  return {
    world,
    run: <A, E>(effect: Effect.Effect<A, E, BotAdmin.BotAdmin>) =>
      effect.pipe(Effect.provide(layer)),
  };
};

const admin = BotAdmin.BotAdmin;
const failure = <A>(effect: Effect.Effect<A, { readonly message: string }, BotAdmin.BotAdmin>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

it.effect("creates each template on the models this server serves", () => {
  const { world, run } = setup();
  return run(
    Effect.gen(function* () {
      const service = yield* admin;
      for (const template of ["light", "opus", "lead"] as const)
        yield* service.create(MAIN, { name: template, job: "Do the job.", template });
      assert.deepEqual(
        world.created.map((input) => ({
          template: input.modelTemplate,
          model: `${input.modelSelection.instanceId}/${input.modelSelection.model}`,
          worker: input.workerModel && `${input.workerModel.instanceId}/${input.workerModel.model}`,
          cap: input.dailyTokenCap,
        })),
        [
          {
            template: "light",
            model: "claudeDeepseek/deepseek-v4.1-flash",
            worker: undefined,
            cap: DEFAULT_BOT_DAILY_TOKEN_CAP,
          },
          {
            template: "opus",
            model: "claudeAgent/claude-opus-5-5",
            worker: undefined,
            cap: DEFAULT_BOT_DAILY_TOKEN_CAP,
          },
          {
            template: "lead",
            model: "claudeAgent/claude-opus-5-5",
            worker: "claudeDeepseek/deepseek-v4.1-flash",
            cap: DEFAULT_BOT_DAILY_TOKEN_CAP,
          },
        ],
      );
    }),
  );
});

it.effect("refuses other bots, unknown models, Codex unasked and missing templates readably", () =>
  Effect.gen(function* () {
    const { run } = setup();
    const opusOnly = setup([provider("claudeAgent", "claudeAgent", CATALOG)]);
    const create = (input: Partial<BotAdmin.BotAdminCreateInput>, caller = MAIN) =>
      Effect.flatMap(admin, (service) =>
        service.create(caller, { name: "New", job: "Job.", template: "light", ...input }),
      );
    assert.match(yield* run(failure(create({}, ThreadId.make("other")))), /Only the main bot/);
    assert.match(
      yield* run(failure(create({ model: { instanceId: "nope", model: "x" } }))),
      /No provider "nope" here\. Models: .*claudeDeepseek: deepseek-v4\.1-flash/,
    );
    assert.match(
      yield* run(failure(create({ model: { instanceId: "claudeAgent", model: "gpt-9" } }))),
      /"claudeAgent" has no model "gpt-9"\. It has: claude-opus-5-5/,
    );
    assert.match(
      yield* run(failure(create({ model: { instanceId: "codex", model: "gpt-6.1-sol" } }))),
      /names Codex/,
    );
    assert.match(
      yield* run(failure(create({ icon: "clapper" }))),
      /No icon "clapper"\. Close: clapperboard\. .*bot_admin_skill/,
    );
    yield* run(create({ model: { instanceId: "codex", model: "gpt-6.1-sol" }, allowCodex: true }));
    assert.match(
      yield* opusOnly.run(failure(create({ template: "lead" }))),
      /needs DeepSeek V4\.1 Flash or GLM/,
    );
  }),
);

it.effect("updates only what is given, by the bot's name", () => {
  const { world, run } = setup();
  return run(
    Effect.gen(function* () {
      const service = yield* admin;
      yield* service.create(MAIN, {
        name: "Digest",
        job: "Old job.",
        icon: "film",
        template: "light",
        schedules: [
          {
            title: "Morning",
            prompt: "Send the digest.",
            schedule: { type: "fixed_time", timeOfDay: "08:00" },
          },
        ],
      });
      yield* service.update(MAIN, { bot: "digest", job: "New job.", icon: "newspaper" });
      yield* service.update(MAIN, {
        bot: "Digest",
        template: "lead",
        schedules: [
          {
            title: "morning",
            prompt: "Send it.",
            schedule: { type: "fixed_time", timeOfDay: "09:00" },
          },
        ],
      });
      yield* service.update(MAIN, {
        bot: "Digest",
        model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      });
      const [kept, lead, sonnet] = world.updated;
      assert.deepEqual(
        [kept?.persona, kept?.modelTemplate, kept?.modelSelection.model, kept?.workerModel],
        ["New job.", "light", "deepseek-v4.1-flash", undefined],
      );
      assert.deepEqual(
        [world.created[0]?.icon, kept?.icon, sonnet?.icon],
        ["film", "newspaper", "newspaper"],
      );
      assert.deepEqual(
        [lead?.modelTemplate, lead?.modelSelection.model, lead?.workerModel?.model],
        ["lead", "claude-opus-5-5", "deepseek-v4.1-flash"],
      );
      assert.deepEqual(
        [sonnet?.modelTemplate, sonnet?.modelSelection.model, sonnet?.workerModel?.model],
        ["lead", "claude-sonnet-5-5", "deepseek-v4.1-flash"],
      );
      assert.deepEqual(
        world.tasks.map((task) => [task.title, task.prompt]),
        [["morning", "Send it."]],
      );
      assert.match(
        yield* failure(service.update(MAIN, { bot: "Digest", removeSchedules: ["Evening"] })),
        /no schedule "Evening"/,
      );
      assert.match(
        yield* failure(service.update(MAIN, { bot: "Ghost", job: "x" })),
        /No bot named Ghost\. Bots: Digest/,
      );
    }),
  );
});

it.effect("a template switch keeps the options of the model the bot already runs", () => {
  const { world, run } = setup();
  const opus = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  world.bots.push({
    name: "Deep",
    persona: "Books.",
    modelSelection: opus,
    dailyTokenCap: 1_000_000,
    threadId: ThreadId.make("deep"),
    projectId: ProjectId.make("bots"),
    createdAt: "2026-11-11T00:00:00Z",
    unread: false,
    lastNotification: null,
    notifiedAt: null,
  });
  return run(
    Effect.gen(function* () {
      const service = yield* admin;
      yield* service.update(MAIN, { bot: "Deep", template: "lead" });
      yield* service.update(MAIN, {
        bot: "Deep",
        model: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      });
      const [lead, sonnet] = world.updated;
      assert.deepEqual(
        [lead?.modelTemplate, lead?.modelSelection, lead?.workerModel?.model],
        ["lead", opus, "deepseek-v4.1-flash"],
      );
      assert.deepEqual(sonnet?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5-5",
      });
    }),
  );
});

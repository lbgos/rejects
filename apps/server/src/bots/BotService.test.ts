import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthEnvironmentScope,
  type BotInput,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Computer from "./BotComputer.ts";
import * as Memory from "./BotMemoryStore.ts";
import * as Sandbox from "./BotSandbox.ts";
import * as Service from "./BotService.ts";
import * as Store from "./BotStore.ts";
import { STEWARD_THREAD_ID } from "./steward.ts";

const provider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: "claudeAgent",
  enabled: true,
  models: [{ slug: "claude-sonnet-5-5", isCustom: false }],
} as unknown as ServerProvider;

const setup = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<ThreadId | undefined> = [];
  const layer = Service.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Memory.BotMemoryStore)({}),
        Layer.mock(Projects.ProjectService)({
          bootstrap: () => Effect.succeed({ project: { id: ProjectId.make("bots") } } as never),
        }),
        Layer.mock(Launch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input.threadId);
              return { threadId: input.threadId } as never;
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return {} as never;
            }),
        }),
        Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(Tasks.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] } as never),
          upsert: () => Effect.succeed({} as never),
        }),
        Layer.mock(Computer.BotComputer)({}),
        Layer.mock(Sandbox.BotSandbox)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
      ),
    ),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "bot-service-" })),
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, dispatched, launched };
};

const input: BotInput = {
  name: "Research",
  persona: "Look things up.",
  description: "Looks things up.",
  starters: ["What changed today?"],
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  },
  dailyTokenCap: 1000,
};

it.effect("create ignores extra arguments and creates a new user bot", () => {
  const { layer, dispatched, launched } = setup();
  return Effect.gen(function* () {
    const service = yield* Service.BotService;
    const store = yield* Store.BotStore;
    // A point-free caller can pass more arguments, as `routeWithScopes` passes scopes.
    const create: (
      input: BotInput,
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => ReturnType<typeof service.create> = service.create;

    const bot = yield* create(input, ["orchestration:read", "orchestration:operate"]);

    assert.notStrictEqual(bot.threadId, STEWARD_THREAD_ID);
    assert.deepStrictEqual(launched, [bot.threadId]);
    assert.deepStrictEqual(
      dispatched.filter((command) => command.type === "thread.create").map((c) => c.threadId),
      [STEWARD_THREAD_ID],
    );
    assert.strictEqual((yield* store.get(bot.threadId))?.name, "Research");
    assert.notStrictEqual((yield* store.get(STEWARD_THREAD_ID))?.name, "Research");
  }).pipe(Effect.provide(layer));
});

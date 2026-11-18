import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { CallPolicy, type CallPolicyShape } from "../policy/CallPolicy.ts";
import * as Guard from "./BotLinkGuard.ts";
import * as Store from "./BotStore.ts";

const bot: BotRecord = {
  name: "Agents",
  persona: "Run models on the user's T3 Code",
  dailyTokenCap: 1_000_000,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  threadId: ThreadId.make("bot:agents"),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-05T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
};
const worker = ThreadId.make("bot:agents:worker");
const plain = ThreadId.make("thread:plain");

const withBots = Layer.mock(Store.BotStore)({
  owner: (id) => Effect.succeed(id === bot.threadId || id === worker ? bot : undefined),
});
const noBots = Layer.mock(Store.BotStore)({ owner: () => Effect.undefined });
const policyOn: CallPolicyShape = {
  ...CallPolicy.defaultValue(),
  outside: (service) => Effect.succeedSome(`Refused by policy: ${service}.`),
};

const check = (caller: ThreadId | undefined) =>
  Effect.gen(function* () {
    const guard = yield* PeerForwarding.ForwardedCallGuard;
    return yield* guard
      .check(
        {
          environmentId: EnvironmentId.make("environment:rejects"),
          requestNamespace: "test",
          issuedAt: 0,
          capabilities: new Set(["orchestration"]),
          client: undefined,
          thread:
            caller === undefined
              ? undefined
              : {
                  threadId: caller,
                  providerSessionId: "session",
                  providerInstanceId: bot.modelSelection.instanceId,
                },
        },
        "t3_thread_read",
      )
      .pipe(
        Effect.as("allowed"),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
  });

const REFUSAL = "Refused by policy: linked-environment.";

it.effect.each([
  { name: "a thread that is not a bot", caller: plain, refusing: false, expected: "allowed" },
  { name: "a bot", caller: bot.threadId, refusing: false, expected: Guard.BOTS_USE_THE_BRIDGE },
  { name: "a bot's worker", caller: worker, refusing: false, expected: Guard.BOTS_USE_THE_BRIDGE },
  {
    name: "a thread that is not a bot, policy refusing",
    caller: plain,
    refusing: true,
    expected: REFUSAL,
  },
  { name: "a bot, policy refusing", caller: bot.threadId, refusing: true, expected: REFUSAL },
])("generic link calls from $name", ({ caller, refusing, expected }) =>
  check(caller).pipe(
    Effect.map((outcome) => assert.equal(outcome, expected)),
    Effect.provideService(CallPolicy, refusing ? policyOn : CallPolicy.defaultValue()),
    Effect.provide(Guard.layer.pipe(Layer.provide(withBots))),
  ),
);

it.effect.each([
  { name: "a thread", caller: plain },
  { name: "a client outside any thread", caller: undefined },
])("the policy refuses link calls from $name on an instance with no bots", ({ caller }) =>
  check(caller).pipe(
    Effect.map((outcome) => assert.equal(outcome, REFUSAL)),
    Effect.provideService(CallPolicy, policyOn),
    Effect.provide(Guard.layer.pipe(Layer.provide(noBots))),
  ),
);

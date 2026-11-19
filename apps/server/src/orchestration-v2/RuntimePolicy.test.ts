import * as BotStore from "../bots/BotStore.ts";
import * as ConnectionStore from "../connections/ConnectionStore.ts";
import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { AgentSandbox } from "@t3tools/shared/AgentScope";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [antigravityInstanceId, ["approval-required", "auto-accept-edits", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: ProviderDriverKind.make(instanceId),
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            hasCustomTitle: false,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

/** Every bot thread is in a sandbox, as on a Linux server with bwrap and the network rule. */
const sandboxed = Layer.succeed(AgentSandbox, {
  ...AgentSandbox.defaultValue(),
  identity: (threadId) => Effect.succeedSome(threadId),
});

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("asks for Antigravity command approval when a stored Auto thread falls back", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, runtimeMode }),
          modelSelection: { instanceId: antigravityInstanceId, model: "test-model" },
        });
      const request = {
        sessionId: "session-1",
        toolCall: { toolCallId: "command-1", title: "Run command", kind: "execute" as const },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const auto = yield* resolve("auto");
      assert.equal(auto.runtimeMode, "approval-required");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.effect("inherits bot ownership before resolving worker policy and forces full access", () => {
  let inherited = false;
  let main: ThreadId | undefined;
  const botLayer = Layer.mock(BotStore.BotStore)({
    bridged: (id) => Effect.succeed(id === ThreadId.make("bot:news")),
    mainBot: Effect.sync(() => main),
    inherit: () =>
      Effect.sync(() => {
        inherited = true;
      }),
    owner: () =>
      Effect.sync(() =>
        inherited
          ? {
              name: "news",
              persona: "Report news",
              modelSelection,
              dailyTokenCap: 100,
              threadId: ThreadId.make("bot:news"),
              projectId,
              createdAt: "2026-10-27T00:00:00Z",
              unread: false,
              notifiedAt: null,
              lastNotification: null,
            }
          : undefined,
      ),
  });
  return Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    const thread = makeThread({ now, worktreePath: null, runtimeMode: "approval-required" });
    const worker = {
      ...thread,
      interactionMode: "plan" as const,
      lineage: {
        parentThreadId: ThreadId.make("bot:news"),
        rootThreadId: ThreadId.make("bot:news"),
        relationshipToParent: "subagent" as const,
      },
    };
    const resolved = yield* policy.resolve({
      thread: worker,
      modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" },
    });
    assert.isTrue(inherited);
    assert.equal(resolved.runtimeMode, "full-access");
    assert.equal(resolved.interactionMode, "default");
    assert.equal(resolved.builtinTools, "none");
    assert.isUndefined(resolved.idleTimeoutMs);
    const onClaude = yield* policy.resolve({
      thread: worker,
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "test-model" },
    });
    assert.equal(onClaude.idleTimeoutMs, RuntimePolicy.BOT_IDLE_TIMEOUT_MS);
    assert.isTrue(onClaude.compactionManaged);
    const refused = yield* policy.resolve({ thread: worker, modelSelection }).pipe(Effect.flip);
    assert.include(String(refused.cause), "runs only on Claude or OpenCode");
    // The main bot keeps its own tools while bridged.
    main = ThreadId.make("bot:news");
    const asMain = yield* policy.resolve({
      thread: worker,
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "test-model" },
    });
    assert.notEqual(asMain.builtinTools, "none");
  }).pipe(Effect.provide(Layer.merge(layerTest.pipe(Layer.provide(botLayer)), sandboxed)));
});

it.effect(
  "runs a bot that reads accounts without provider tools, and only where they turn off",
  () => {
    const inbox = ThreadId.make("bot:inbox");
    const research = ThreadId.make("bot:research");
    const fable = ThreadId.make("bot:fable");
    const botLayer = Layer.mock(BotStore.BotStore)({
      bridged: () => Effect.succeed(false),
      inherit: () => Effect.void,
      owner: (id) =>
        Effect.succeed(
          id === inbox || id === research || id === fable
            ? {
                ...(id === fable ? { standalone: true as const } : {}),
                name: "Inbox",
                persona: "Watch mail",
                modelSelection,
                dailyTokenCap: 100,
                threadId: id,
                projectId,
                createdAt: "2026-11-06T00:00:00Z",
                unread: false,
                notifiedAt: null,
                lastNotification: null,
              }
            : undefined,
        ),
    });
    const connectionLayer = Layer.mock(ConnectionStore.ConnectionStore)({
      held: (id) => Effect.succeed(id === inbox),
    });
    return Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const thread = { ...makeThread({ now: yield* DateTime.now, worktreePath: null }), id: inbox };
      const resolved = yield* policy.resolve({
        thread,
        modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" },
      });
      assert.equal(resolved.runtimeMode, "full-access");
      assert.equal(resolved.builtinTools, "none");
      const refused = yield* policy.resolve({ thread, modelSelection }).pipe(Effect.flip);
      assert.include(String(refused.cause), "account access runs only on Claude or OpenCode");
      const onClaude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "glm" };
      const tools = (id: ThreadId, selection = onClaude) =>
        policy
          .resolve({ thread: { ...thread, id }, modelSelection: selection })
          .pipe(Effect.map((resolved) => resolved.builtinTools));
      assert.equal(yield* tools(research), "noWeb");
      assert.equal(yield* tools(inbox), "none");
      // A standalone bot has no shell or files either.
      assert.equal(yield* tools(fable), "none");
      assert.isUndefined(yield* tools(ThreadId.make("chat")));
      assert.isUndefined(
        yield* tools(research, {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "test-model",
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerTest.pipe(Layer.provide(Layer.merge(botLayer, connectionLayer))),
          sandboxed,
        ),
      ),
    );
  },
);

it.effect(
  "runs a bot without a sandbox with its provider's tools off, and only where they turn off",
  () => {
    const news = ThreadId.make("bot:news");
    const botLayer = Layer.mock(BotStore.BotStore)({
      bridged: () => Effect.succeed(false),
      mainBot: Effect.undefined,
      inherit: () => Effect.void,
      owner: (id) =>
        Effect.succeed(
          id === news
            ? {
                name: "News",
                persona: "Report news",
                modelSelection,
                dailyTokenCap: 100,
                threadId: id,
                projectId,
                createdAt: "2026-11-17T00:00:00Z",
                unread: false,
                notifiedAt: null,
                lastNotification: null,
              }
            : undefined,
        ),
    });
    return Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const thread = { ...makeThread({ now: yield* DateTime.now, worktreePath: null }), id: news };
      const tools = (instance: string, id = news) =>
        policy
          .resolve({
            thread: { ...thread, id },
            modelSelection: { instanceId: ProviderInstanceId.make(instance), model: "m" },
          })
          .pipe(Effect.map((resolved) => resolved.builtinTools));
      assert.equal(yield* tools("claudeAgent"), "none");
      assert.equal(yield* tools("opencode"), "none");
      const refused = yield* tools("codex").pipe(Effect.flip);
      assert.include(String(refused.cause), "Without the bot sandbox, a bot runs only on Claude");
      // A user's own coding thread keeps its tools.
      assert.isUndefined(yield* tools("codex", ThreadId.make("chat")));
      assert.equal(yield* tools("claudeAgent").pipe(Effect.provide(sandboxed)), "noWeb");
    }).pipe(Effect.provide(layerTest.pipe(Layer.provide(botLayer))));
  },
);
it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});

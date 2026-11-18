import * as BotStore from "../bots/BotStore.ts";
import * as ConnectionStore from "../connections/ConnectionStore.ts";
import { sealedBy } from "../bots/sealed.ts";
import { AgentSandbox } from "@t3tools/shared/AgentScope";
import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

const BUILTIN_TOOLS_OFF_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "opencode"]);

/** Every bot, wake and worker thread has its own process, and warm ones filled the service's memory. OpenCode sessions borrow one shared server, so they keep the default. */
export const BOT_IDLE_TIMEOUT_MS = 30_000;

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const bots = yield* Effect.serviceOption(BotStore.BotStore);
    const connections = yield* Effect.serviceOption(ConnectionStore.ConnectionStore);
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        if (Option.isSome(bots))
          yield* bots.value.inherit(input.thread).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
          );
        const bot = Option.isSome(bots) ? yield* bots.value.owner(input.thread.id) : undefined;
        if (
          bot &&
          supportedRuntimeModes !== undefined &&
          !supportedRuntimeModes.includes("full-access")
        )
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: "Bots require full-access support.",
          });
        const sealed =
          bot === undefined || Option.isNone(bots)
            ? undefined
            : yield* sealedBy(bot, bots.value, connections);
        // No sandbox means no shell: a bot outside one keeps only T3's MCP tools.
        const unsandboxed =
          bot !== undefined &&
          Option.isNone(yield* (yield* AgentSandbox).identity(input.thread.id));
        const toolsOff = sealed !== undefined || unsandboxed;
        if (toolsOff && !BUILTIN_TOOLS_OFF_DRIVERS.has(instance?.driverKind ?? ""))
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause: `${sealed === undefined ? "Without the bot sandbox, a bot" : `A bot with ${sealed}`} runs only on Claude or OpenCode, which can turn their own tools off.`,
          });
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: bot
            ? "full-access"
            : providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: bot ? "default" : input.thread.interactionMode,
          cwd,
          // Claude Code's own web search comes back empty through a proxied model; bots search with
          // web_search and web_browse.
          ...(toolsOff
            ? { builtinTools: "none" as const }
            : bot && instance?.driverKind === "claudeAgent"
              ? { builtinTools: "noWeb" as const }
              : {}),
          ...(bot && instance?.driverKind !== "opencode"
            ? { idleTimeoutMs: BOT_IDLE_TIMEOUT_MS }
            : {}),
          ...(bot ? { compactionManaged: true } : {}),
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}

import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AgentSandbox } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for recorded messages"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "bot-commands" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.layer(layerTest)("bot commands", (it) => {
  it.effect("records a message outside any run once; resetting a fresh context is a no-op", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:bot-chat");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:bots"),
        title: "Homelab",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const record = {
        type: "message.record",
        commandId: CommandId.make("bots:wake-result:w1"),
        threadId,
        messageId: MessageId.make("bots:wake-result:w1"),
        text: "DOWN gpu-vm since 12:00",
        attachments: [
          {
            type: "file",
            id: ChatAttachmentId.make("report"),
            name: "report.csv",
            mimeType: "text/csv",
            sizeBytes: 28,
          },
        ],
      } as const;
      yield* orchestrator.dispatch(record);
      yield* orchestrator.dispatch({ ...record, commandId: CommandId.make("again") });
      yield* orchestrator.dispatch({
        type: "thread.context.reset",
        commandId: CommandId.make("reset"),
        threadId,
      });
      const records = yield* projections.getThreadRecords(threadId, [
        "messages",
        "turnItems",
        "providerThreads",
      ]);
      assert.deepEqual(records.providerThreads, []);
      assert.deepEqual(
        records.messages.map((m) => [m.role, m.runId, m.text]),
        [["assistant", null, "DOWN gpu-vm since 12:00"]],
      );
      assert.deepEqual(
        records.turnItems.map((item) => [
          item.type,
          item.runId,
          item.status,
          item.type === "assistant_message" ? item.attachments?.map((file) => file.name) : null,
        ]),
        [["assistant_message", null, "completed", ["report.csv"]]],
      );
    }),
  );

  it.effect("starts each bot sandbox's Codex threads in a session of their own", () => {
    const sandboxOf: Record<string, string> = {
      "thread:news-1": "news",
      "thread:news-2": "news",
      "thread:weather": "weather",
    };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sessions: Record<string, string | null | undefined> = {};
      for (const name of ["thread:host", ...Object.keys(sandboxOf)]) {
        const threadId = ThreadId.make(name);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${name}`),
          threadId,
          projectId: ProjectId.make("project:bots"),
          title: name,
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${name}`),
          threadId,
          messageId: MessageId.make(`message:${name}`),
          text: "uname -s",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const records = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
        sessions[name] = records.providerThreads[0]?.providerSessionId;
      }
      const shared = (sandbox?: string) =>
        IdAllocator.derive.providerSession({ providerInstanceId: instanceId, sandbox });
      assert.deepEqual(sessions, {
        "thread:host": shared(),
        "thread:news-1": shared("news"),
        "thread:news-2": shared("news"),
        "thread:weather": shared("weather"),
      });
    }).pipe(
      Effect.provideService(AgentSandbox, {
        ...AgentSandbox.defaultValue(),
        identity: (threadId) => Effect.succeed(Option.fromUndefinedOr(sandboxOf[threadId])),
      }),
    );
  });
});

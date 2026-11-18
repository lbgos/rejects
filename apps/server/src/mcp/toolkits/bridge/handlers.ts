import type { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BotBridge from "../../../bots/BotBridge.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { BridgeOperateToolkit, BridgeReadToolkit } from "./tools.ts";

const withBridge = Effect.fn("BridgeTools.call")(function* <A>(
  use: (
    bridge: BotBridge.BotBridge["Service"],
    scope: Invocation.McpInvocationScope,
  ) => Effect.Effect<A, OrchestratorMcpFailure>,
) {
  return yield* use(yield* BotBridge.BotBridge, yield* Invocation.McpInvocationContext);
});

export const layerRead = Access.toLayer(BridgeReadToolkit, {
  bridge_list: Access.readsAsCaller((input) => withBridge((b, scope) => b.list(scope, input))),
  bridge_read: Access.readsAsCaller((input) => withBridge((b, scope) => b.read(scope, input))),
  bridge_models: Access.readsAsCaller((input) => withBridge((b, scope) => b.models(scope, input))),
  bridge_watch: Access.actsAsCaller((input) => withBridge((b, scope) => b.watch(scope, input))),
  bridge_unwatch: Access.actsAsCaller((input) => withBridge((b, scope) => b.unwatch(scope, input))),
});

export const layerOperate = Access.toLayer(BridgeOperateToolkit, {
  bridge_start: Access.actsAsCaller((input) =>
    withBridge((b, scope) => b.propose(scope, { kind: "start", ...input })),
  ),
  bridge_send: Access.actsAsCaller((input) =>
    withBridge((b, scope) => b.propose(scope, { kind: "send", ...input })),
  ),
  bridge_cancel: Access.actsAsCaller((input) => withBridge((b, scope) => b.cancel(scope, input))),
});

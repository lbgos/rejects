import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { CallPolicy } from "../policy/CallPolicy.ts";
import * as Store from "./BotStore.ts";

export const BOTS_USE_THE_BRIDGE =
  "Bots reach other machines only through the bridge_* tools, which the user grants per bot.";

/**
 * Every `t3_*` call that names a linked environment passes here before it leaves. The call
 * policy may refuse all of them, whoever calls. Bots and their workers never use this environment's
 * links through the generic T3 tools; their only way there is `BotBridge`, which checks the
 * per-bot grant, holds writes for approval and audits every call.
 */
export const layer = Layer.effect(
  PeerForwarding.ForwardedCallGuard,
  Effect.gen(function* () {
    const bots = yield* Store.BotStore;
    return PeerForwarding.ForwardedCallGuard.of({
      check: Effect.fn("BotLinkGuard.check")(function* (scope) {
        const refused = yield* (yield* CallPolicy).outside("linked-environment");
        if (Option.isSome(refused))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: refused.value,
          });
        if (scope.thread === undefined) return;
        if ((yield* bots.owner(scope.thread.threadId)) === undefined) return;
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: BOTS_USE_THE_BRIDGE,
        });
      }),
    });
  }),
);

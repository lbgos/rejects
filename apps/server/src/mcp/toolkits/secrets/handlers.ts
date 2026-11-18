import * as Effect from "effect/Effect";
import * as BotSecrets from "../../../secrets/BotSecrets.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { SecretsToolkit } from "./tools.ts";

export const layer = Access.toLayer(SecretsToolkit, {
  ask_secret: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* BotSecrets.BotSecrets).ask(scope, input);
    }),
  ),
});

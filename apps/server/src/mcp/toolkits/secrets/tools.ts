import { BotSecretAskKind, BotSecretName, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as BotSecrets from "../../../secrets/BotSecrets.ts";
import * as Invocation from "../../McpInvocationContext.ts";

export const SecretsToolkit = Toolkit.make(
  Tool.make("ask_secret", {
    description:
      "Ask the user for a sign-in, one-time code, API key or other secret in a private card with a push. You never see the value; never ask for one in chat. For a site's sign-in call once with site and kind login: one card asks for the sign-in name and the password, which the vault keeps until the user removes them. Any other single value typed on a site (a two-step code, PIN, API key or invite code) is kind code, typed once and then deleted. Leave site out for a secret your shell commands use. End your turn after calling; you are woken once they save it, then type it with web_browse, account and secretRef.",
    parameters: Schema.Struct({
      name: BotSecretName.annotate({
        description: "Your name for it, lowercase, such as olx-password or openai-key.",
      }),
      label: Schema.String.check(Schema.isMaxLength(80)).annotate({
        description: "What the user is asked for, such as OLX password.",
      }),
      reason: Schema.String.check(Schema.isMaxLength(300)).annotate({
        description: "What you need it for, in one short line the user reads.",
      }),
      site: Schema.optional(
        Schema.String.annotate({
          description:
            "The exact host of the sign-in page where it is typed, such as olx.ua or accounts.google.com.",
        }),
      ),
      kind: Schema.optional(
        BotSecretAskKind.annotate({
          description:
            "With site: login (name and password in one card), code (one value typed once: a two-step code, PIN or key), or username or password alone when you hold the other. Default password.",
        }),
      ),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies: [
      BotSecrets.BotSecrets,
      Threads.ThreadManagementService,
      Invocation.McpInvocationContext,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);

import { BotOwnSkill, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BotStore from "../../../bots/BotStore.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  BotStore.BotStore,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40));

export const SKILL_SAVED_NEXT =
  "Saved. Say in one line which skill you saved. Do not also put these steps in memory.";

export const BotSkillsToolkit = Toolkit.make(
  Tool.make("read_skill", {
    description:
      "Load one of your skills by name before you do what its line in your instructions names. Follow what it returns.",
    parameters: Schema.Struct({ name: Name }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Read a skill")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("write_skill", {
    description:
      "Save one of your own skills, or rewrite it under the same name: a trigger line starting with When, and the steps.",
    parameters: Schema.Struct({
      name: BotOwnSkill.fields.name,
      description: BotOwnSkill.fields.description.annotate({
        description:
          'One English line starting with "When", such as "When asked for the weekly backup report".',
      }),
      body: BotOwnSkill.fields.body.annotate({
        description:
          "Numbered steps in English: only what the user said and what you did with your tools.",
      }),
    }),
    success: Schema.Struct({ saved: Schema.String, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Write a skill")
    .annotate(Tool.Destructive, false),
  Tool.make("delete_skill", {
    description: "Delete one of your own skills by name.",
    parameters: Schema.Struct({ name: Name }),
    success: Schema.Struct({ deleted: Schema.String }),
    failure: OrchestratorMcpFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Delete a skill")
    .annotate(Tool.Destructive, true),
);

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Cortex from "../../../bots/Cortex.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const dependencies = [
  Cortex.Cortex,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
const query = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
export const CortexToolkit = Toolkit.make(
  Tool.make("cortex_search", {
    description: "Search the user's Cortex memory before asking for information.",
    parameters: Schema.Struct({ query, k: Schema.optional(Schema.Number) }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_read", {
    description: "Read a Cortex source passage.",
    parameters: Schema.Struct({
      sourceId: Schema.String,
      from: Schema.optional(Schema.Number),
      to: Schema.optional(Schema.Number),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_beliefs", {
    description: "Search recorded beliefs and evidence, including supersession history.",
    parameters: Schema.Struct({ query }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("cortex_add_source", {
    description:
      "Import text into Cortex as study material. Cortex stores only the text you pass: for a web page, fetch its readable text first; url only records where it came from. An error means nothing was stored.",
    parameters: Schema.Struct({
      text: Schema.String.check(Schema.isMinLength(1)),
      kind: Schema.Literals(["note", "book", "course", "lecture", "video"]),
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
      url: Schema.optional(Schema.String),
      language: Schema.optional(Schema.String),
      concepts: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(8))),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Destructive, false),
  Tool.make("cortex_record", {
    description:
      "Record a useful observation with explicit confidence and evidence. An error means nothing was recorded.",
    parameters: Schema.Struct({
      type: Schema.Literals(["belief", "exposure", "understanding", "endorsement", "confidence"]),
      statement: query,
      stance: Schema.optional(Schema.Literals(["affirm", "reject", "uncertain", "unspecified"])),
      confidence: Schema.NullOr(Schema.Number),
      sourceRef: Schema.optional(Schema.Unknown),
      supersedes: Schema.optional(Schema.String),
    }),
    success: Schema.String,
    failure: OrchestratorMcpFailure,
    dependencies,
  }).annotate(Tool.Destructive, false),
);

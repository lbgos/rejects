import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";

export const BotBridgeAccess = Schema.Literals(["read", "operate"]);
export type BotBridgeAccess = typeof BotBridgeAccess.Type;

export const BotBridgeGrant = Schema.Struct({
  botThreadId: ThreadId,
  environmentId: EnvironmentId,
  access: BotBridgeAccess,
});
export type BotBridgeGrant = typeof BotBridgeGrant.Type;

const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000));

/** The exact work a bot proposes. Approving runs this payload and nothing else. */
export const BotBridgeProposal = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    environmentId: EnvironmentId,
    projectId: ProjectId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    modelSelection: ModelSelection,
    prompt: Prompt,
  }),
  Schema.Struct({
    kind: Schema.Literal("send"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    prompt: Prompt,
  }),
]);
export type BotBridgeProposal = typeof BotBridgeProposal.Type;

export const BotBridgeRequestStatus = Schema.Literals(["pending", "approved", "denied", "failed"]);
export type BotBridgeRequestStatus = typeof BotBridgeRequestStatus.Type;

export const BotBridgeRequest = Schema.Struct({
  id: Schema.String,
  botThreadId: ThreadId,
  proposal: BotBridgeProposal,
  status: BotBridgeRequestStatus,
  targetTitle: Schema.optional(Schema.String),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  error: Schema.NullOr(Schema.String),
});
export type BotBridgeRequest = typeof BotBridgeRequest.Type;

/** One bridge call. Names what was touched, never prompts, replies or credentials. */
export const BotBridgeAuditEntry = Schema.Struct({
  at: Schema.String,
  botThreadId: ThreadId,
  bot: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  op: Schema.String,
  target: Schema.NullOr(Schema.String),
  status: Schema.Literals(["ok", "refused", "failed", "pending", "approved", "denied"]),
  detail: Schema.NullOr(Schema.String),
});
export type BotBridgeAuditEntry = typeof BotBridgeAuditEntry.Type;

export const BotBridgeEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The link this environment reads through; anything above read-only is refused. */
  linkAccess: Schema.String,
  writes: Schema.Boolean,
});
export type BotBridgeEnvironment = typeof BotBridgeEnvironment.Type;

export const BotBridgeState = Schema.Struct({
  environments: Schema.Array(BotBridgeEnvironment),
  grants: Schema.Array(BotBridgeGrant),
  requests: Schema.Array(BotBridgeRequest),
  audit: Schema.Array(BotBridgeAuditEntry),
});
export type BotBridgeState = typeof BotBridgeState.Type;

export const BOT_BRIDGE_ENDPOINTS = {
  state: {
    path: "/api/bots/bridge/state",
    payload: Schema.Struct({}),
    success: BotBridgeState,
    scope: AuthOrchestrationReadScope,
  },
  grant: {
    path: "/api/bots/bridge/grant",
    payload: Schema.Struct({
      botThreadId: ThreadId,
      environmentId: EnvironmentId,
      access: Schema.NullOr(BotBridgeAccess),
    }),
    success: Schema.Struct({}),
    scope: AuthOrchestrationOperateScope,
  },
  decide: {
    path: "/api/bots/bridge/decide",
    payload: Schema.Struct({ requestId: Schema.String, approve: Schema.Boolean }),
    success: BotBridgeRequest,
    scope: AuthOrchestrationOperateScope,
  },
} as const;

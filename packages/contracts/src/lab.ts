import * as Schema from "effect/Schema";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

/** Longest script a lab change card may carry; the card shows all of it. */
export const LAB_SCRIPT_MAX = 20_000;

/**
 * A change a bot proposed for a lab host. Approving runs `script` on `host` as root, exactly
 * once; any edit is a new request.
 */
export const LabChangeRequest = Schema.Struct({
  id: Schema.String,
  botThreadId: ThreadId,
  host: Schema.String,
  script: Schema.String,
  why: Schema.String,
  status: Schema.Literals(["pending", "running", "done", "failed", "denied"]),
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
export type LabChangeRequest = typeof LabChangeRequest.Type;

export const LAB_ENDPOINTS = {
  /** Every bot's lab change requests. */
  state: {
    path: "/api/lab/state",
    payload: Schema.Struct({}),
    success: Schema.Struct({ requests: Schema.Array(LabChangeRequest) }),
    scope: AuthOrchestrationReadScope,
  },
  /** The user's answer on a change card. Approve starts that exact script once. */
  decide: {
    path: "/api/lab/decide",
    payload: Schema.Struct({ id: Schema.String, approve: Schema.Boolean }),
    success: LabChangeRequest,
    scope: AuthOrchestrationOperateScope,
  },
} as const;

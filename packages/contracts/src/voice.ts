import * as Schema from "effect/Schema";
import { AuthOrchestrationOperateScope } from "./auth.ts";

/** The client posts its recording as the raw body, typed with the recorder's container; the server converts it for the backend. */
export const VOICE_TRANSCRIBE = {
  path: "/api/voice/dictate",
  success: Schema.Struct({ text: Schema.String }),
  scope: AuthOrchestrationOperateScope,
  /** The client stops recording here; the body cap leaves room for iOS's AAC bitrate. */
  maxSeconds: 300,
  maxBytes: 16 * 1024 * 1024,
} as const;

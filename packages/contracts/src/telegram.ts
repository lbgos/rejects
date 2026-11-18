import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";

/**
 * The Telegram channel as Settings shows it. The bot token stays in the server's secret store and
 * never reaches a client; the claim code is shown once, when it is made.
 */
export const TelegramState = Schema.Struct({
  connected: Schema.Boolean,
  botUsername: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Schema.Struct({ chatId: Schema.Number, name: Schema.String })),
  claimExpiresAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  mainBot: Schema.NullOr(ThreadId),
  filesNow: Schema.Boolean,
  voiceQueued: Schema.Int,
  /** A paid cloud API transcribes voice when Nemotron is down. Never on for a ZDR instance. */
  cloudVoice: Schema.Boolean,
  cloudVoiceKey: Schema.Boolean,
});
export type TelegramState = typeof TelegramState.Type;

export const TelegramClaim = Schema.Struct({
  state: TelegramState,
  code: Schema.String,
  link: Schema.String,
});
export type TelegramClaim = typeof TelegramClaim.Type;

export const TELEGRAM_ENDPOINTS = {
  state: {
    path: "/api/telegram/state",
    payload: Schema.Struct({}),
    success: TelegramState,
    scope: AuthOrchestrationReadScope,
  },
  connect: {
    path: "/api/telegram/connect",
    payload: Schema.Struct({
      token: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(200)),
    }),
    success: TelegramClaim,
    scope: AuthOrchestrationOperateScope,
  },
  code: {
    path: "/api/telegram/code",
    payload: Schema.Struct({}),
    success: TelegramClaim,
    scope: AuthOrchestrationOperateScope,
  },
  settings: {
    path: "/api/telegram/settings",
    payload: Schema.Struct({
      mainBot: Schema.optional(Schema.NullOr(ThreadId)),
      filesNow: Schema.optional(Schema.Boolean),
      cloudVoice: Schema.optional(Schema.Boolean),
      cloudVoiceKey: Schema.optional(Schema.String.check(Schema.isMaxLength(400))),
    }),
    success: TelegramState,
    scope: AuthOrchestrationOperateScope,
  },
  disconnect: {
    path: "/api/telegram/disconnect",
    payload: Schema.Struct({}),
    success: TelegramState,
    scope: AuthOrchestrationOperateScope,
  },
} as const;

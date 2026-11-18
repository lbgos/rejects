// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
import * as Schema from "effect/Schema";

export class CodexAuthCallbackError extends Schema.TaggedError<CodexAuthCallbackError>()(
  "CodexAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** Receive an authorization code locally. Credentials and PKCE stay on the target environment. */

import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * `ready`: bots run in bubblewrap with a shell. `off` and `absent`: bots run on the host with their
 * provider's own tools off. `broken`: set up but failing, so bots refuse to run.
 */
export const BotSandboxKind = Schema.Literals(["ready", "off", "absent", "broken"]);
export type BotSandboxKind = typeof BotSandboxKind.Type;

export const ReadinessCheckId = Schema.Literals([
  "sandbox",
  "providers",
  "browser",
  "ytdlp",
  "telegram",
  "cortex",
  "embedder",
]);
export type ReadinessCheckId = typeof ReadinessCheckId.Type;

/** `off`: optional and not set up. `missing`: needs something installed. `error`: set up but failing. */
export const ReadinessState = Schema.Literals(["ok", "off", "missing", "error"]);
export type ReadinessState = typeof ReadinessState.Type;

export const ReadinessCheck = Schema.Struct({
  id: ReadinessCheckId,
  label: Schema.String,
  state: ReadinessState,
  detail: Schema.String,
});
export type ReadinessCheck = typeof ReadinessCheck.Type;

/** What `doctor` prints and the first run reads. */
export const BotReadiness = Schema.Struct({
  sandbox: BotSandboxKind,
  /** Claude instances with an API key or token, the only ones a sandboxed bot can use. */
  keyedInstances: Schema.Array(ProviderInstanceId),
  checks: Schema.Array(ReadinessCheck),
});
export type BotReadiness = typeof BotReadiness.Type;

/**
 * Whether a provider driver can run bots on this machine:
 * - `needsKey`: Claude in the sandbox, which holds no login, only a key the server routes;
 * - `sandboxed`: the sandbox gives only Claude a model route;
 * - `toolsOn`: without the sandbox a bot needs a harness that turns its own tools off.
 */
export type BotDriverFit = "ok" | "needsKey" | "sandboxed" | "toolsOn";

export const botDriverFit = (
  driver: string,
  sandbox: BotSandboxKind,
  keyed: boolean,
): BotDriverFit => {
  if (sandbox === "ready" || sandbox === "broken") {
    if (driver !== "claudeAgent") return "sandboxed";
    return keyed ? "ok" : "needsKey";
  }
  return driver === "claudeAgent" || driver === "opencode" ? "ok" : "toolsOn";
};

import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

const BOT_PROCESS_ENVIRONMENT = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  "GROK_HOME",
  "MUSE_NO_AUTO_UPDATE",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DATA_DIR",
  "T3_ACP_MCP_ENDPOINT",
  "T3_ACP_MCP_AUTHORIZATION",
  "T3_ACP_MCP_NODE",
  "T3_ACP_MCP_ENTRYPOINT",
  "T3_ACP_CGROUP_WRAPPER",
  "T3_ACP_ANTIGRAVITY",
  "T3_ACP_REQUEST_LOG_PATH",
  "ELECTRON_RUN_AS_NODE",
] as const;

// Any key that names a secret, so `clientSecret`, `privateKey` and `x-goog-api-key` go too.
const CREDENTIAL_KEY = /secret|token|key|password|auth|credential/i;
// Greedy up to the last `@` before the path, since a password may hold an unescaped `@`.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi;

const withoutCredentials = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(URL_USERINFO, "$1");
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        CREDENTIAL_KEY.test(key) ? [] : [[key, withoutCredentials(entry)]],
      ),
    );
  return value;
};

const botConfigContent = (content: string) => {
  try {
    const parsed: unknown = JSON.parse(content);
    const cleaned = JSON.stringify(withoutCredentials(parsed));
    return cleaned === JSON.stringify(parsed) ? content : cleaned;
  } catch {
    return undefined;
  }
};

const botEnvironmentValue = (name: string, value: string) =>
  name === "OPENCODE_CONFIG_CONTENT"
    ? botConfigContent(value)
    : name === "ANTHROPIC_BASE_URL" || name === "OPENAI_BASE_URL"
      ? value.replace(URL_USERINFO, "$1")
      : value;

/**
 * Host variables are filtered first; sandbox-owned ones are appended. No provider credential
 * reaches a bot, so the OpenCode config and base URLs lose API keys, tokens and URL userinfo.
 */
export const buildBotProviderEnvironment = (
  environment: NodeJS.ProcessEnv,
  internalEnvironment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    BOT_PROCESS_ENVIRONMENT.flatMap((name) => {
      const value = environment[name];
      const safe = value === undefined ? undefined : botEnvironmentValue(name, value);
      return safe === undefined ? [] : [[name, safe]];
    }),
  ),
  ...internalEnvironment,
});

const BOT_TOOL_ENVIRONMENT = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
] as const;

export const buildBotToolEnvironment = (
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value !== undefined && (BOT_TOOL_ENVIRONMENT as ReadonlyArray<string>).includes(name)
        ? [[name, value]]
        : [],
    ),
  );

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});

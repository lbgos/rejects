import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { botProviderChoices, endpointInstance } from "./firstRun.logic";

const provider = (
  id: string,
  driver: string,
  patch: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-17T00:00:00.000Z",
  models: [{ slug: `${id}-model`, name: `${id} model`, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...patch,
});

const providers = [
  provider("codex", "codex"),
  provider("claudeAgent", "claudeAgent"),
  provider("opencode", "opencode", { status: "error", auth: { status: "unauthenticated" } }),
  provider("cursor", "cursor", { installed: false, status: "warning" }),
  provider("endpoint", "claudeAgent"),
];

const summary = (sandbox: "ready" | "absent", keyed: ReadonlyArray<string>) =>
  botProviderChoices(providers, {
    sandbox,
    keyedInstances: keyed.map((id) => ProviderInstanceId.make(id)),
  }).map((choice) => [choice.instanceId, choice.selection?.model ?? choice.blocker]);

describe("botProviderChoices", () => {
  it("without a sandbox offers signed-in Claude and OpenCode, never Codex", () => {
    expect(summary("absent", [])).toEqual([
      ["claudeAgent", "claudeAgent-model"],
      ["endpoint", "endpoint-model"],
      ["codex", "toolsOn"],
      ["opencode", "signIn"],
    ]);
  });

  it("in the sandbox offers only Claude instances with a key", () => {
    expect(summary("ready", ["endpoint"])).toEqual([
      ["endpoint", "endpoint-model"],
      ["codex", "sandboxed"],
      ["claudeAgent", "needsKey"],
      ["opencode", "sandboxed"],
    ]);
  });
});

describe("endpointInstance", () => {
  it("sends Anthropic a key and other endpoints a bearer token, both kept secret", () => {
    const names = (url: string) => {
      const mutation = endpointInstance({ url, key: " k ", model: "m" });
      return mutation.operation === "remove"
        ? []
        : (mutation.instance.environment ?? []).map((variable) => [
            variable.name,
            variable.sensitive,
          ]);
    };
    expect(names("")).toEqual([
      ["ANTHROPIC_BASE_URL", false],
      ["ANTHROPIC_API_KEY", true],
    ]);
    expect(names("https://api.deepseek.com/anthropic/")).toEqual([
      ["ANTHROPIC_BASE_URL", false],
      ["ANTHROPIC_AUTH_TOKEN", true],
    ]);
  });
});

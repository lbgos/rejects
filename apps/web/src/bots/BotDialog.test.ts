import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { DEFAULT_BOT_MODEL, parseStarters, resolveDefaultBotModel } from "./BotDialog";

function provider(
  driver: ServerProvider["driver"],
  models: string[],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    driver,
    instanceId: ProviderInstanceId.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    version: null,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-28T09:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const codex = provider(ProviderDriverKind.make("codex"), ["gpt-6-luna"]);
const opencode = provider(ProviderDriverKind.make("opencode"), [DEFAULT_BOT_MODEL.model]);

function choose(providers: ServerProvider[], unavailableModel = false) {
  return resolveDefaultBotModel(
    deriveProviderInstanceEntries(providers),
    new Map(
      providers.map((entry) => [
        entry.instanceId,
        entry.models.map((model) => ({
          ...model,
          isUnavailable: unavailableModel && model.slug === DEFAULT_BOT_MODEL.model,
        })),
      ]),
    ),
  );
}

describe("bot default model", () => {
  it("prefers DeepSeek V4.1 Flash on an available OpenCode instance", () => {
    expect(choose([codex, opencode])).toEqual(DEFAULT_BOT_MODEL);
    const instanceId = ProviderInstanceId.make("opencode_personal");
    expect(choose([codex, { ...opencode, instanceId }])).toEqual({
      ...DEFAULT_BOT_MODEL,
      instanceId,
    });
  });

  it.each([
    { availability: "unavailable" as const },
    { enabled: false },
    { status: "error" as const },
    { models: [] },
  ])("uses the first available model when OpenCode cannot supply Flash: %j", (override) => {
    expect(choose([{ ...opencode, ...override }, codex])).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6-luna",
    });
  });

  it("skips a model marked unavailable by the picker", () => {
    expect(choose([opencode, codex], true)).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6-luna",
    });
  });

  it("resolves the default as the provider catalog arrives", () => {
    expect(choose([])).toEqual(DEFAULT_BOT_MODEL);
    expect(choose([codex])).toEqual({ instanceId: codex.instanceId, model: "gpt-6-luna" });
    expect(choose([codex, opencode])).toEqual(DEFAULT_BOT_MODEL);
  });
});

describe("parseStarters", () => {
  it("keeps up to four trimmed, non-empty lines", () => {
    expect(parseStarters(" Quiz me now. \n\nAdd these words: \na\nb\nc")).toEqual([
      "Quiz me now.",
      "Add these words:",
      "a",
      "b",
    ]);
  });
});

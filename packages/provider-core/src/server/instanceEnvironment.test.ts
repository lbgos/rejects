import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildBotProviderEnvironment,
  buildBotToolEnvironment,
  mergeProviderInstanceEnvironment,
} from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("keeps only the bot process environment allowlist", () => {
    expect(
      buildBotProviderEnvironment({
        PATH: "/bin",
        HOME: "/host",
        LANG: "C.UTF-8",
        TERM: "xterm",
        XDG_CONFIG_HOME: "/bot/.config",
        XDG_DATA_HOME: "/bot/.local/share",
        CODEX_HOME: "/bot/.codex",
        CLAUDE_CONFIG_DIR: "/bot/.claude",
        CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
        CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
        GROK_HOME: "/bot/.grok",
        MUSE_NO_AUTO_UPDATE: "1",
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DATA_DIR: "/bot/opencode-data",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        UNRELATED_SECRET: "secret",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/host",
      LANG: "C.UTF-8",
      TERM: "xterm",
      XDG_CONFIG_HOME: "/bot/.config",
      XDG_DATA_HOME: "/bot/.local/share",
      CODEX_HOME: "/bot/.codex",
      CLAUDE_CONFIG_DIR: "/bot/.claude",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
      GROK_HOME: "/bot/.grok",
      MUSE_NO_AUTO_UPDATE: "1",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DATA_DIR: "/bot/opencode-data",
    });
  });
  it("strips credentials from the OpenCode config and the provider base URLs", () => {
    const env = buildBotProviderEnvironment({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        small_model: "opencode-go/flash",
        provider: {
          proxy: {
            name: "Proxy",
            options: {
              baseURL: "https://user:pw@proxy.example/v1",
              apiKey: "sk-secret",
              clientSecret: "s",
              privateKey: "k",
              accessKeyId: "id",
              headers: {
                Authorization: "Bearer sk-secret",
                "x-goog-api-key": "g",
                "X-Auth-Token": "t",
                "x-team": "a",
              },
              mirrors: [
                "https://u:p@mirror.example/a",
                "https://mirror.example/b",
                "https://user:p@ss@mirror.example/c",
                "https://user:p:w@d@@mirror.example:8443/d?next=a@b#x@y",
                "https://mirror.example/e@f",
              ],
            },
          },
        },
      }),
      ANTHROPIC_BASE_URL: "https://user:p@ss@gateway.example/anthropic",
      OPENAI_BASE_URL: "http://gateway.example/v1",
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      small_model: "opencode-go/flash",
      provider: {
        proxy: {
          name: "Proxy",
          options: {
            baseURL: "https://proxy.example/v1",
            headers: { "x-team": "a" },
            mirrors: [
              "https://mirror.example/a",
              "https://mirror.example/b",
              "https://mirror.example/c",
              "https://mirror.example:8443/d?next=a@b#x@y",
              "https://mirror.example/e@f",
            ],
          },
        },
      },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/anthropic");
    expect(env.OPENAI_BASE_URL).toBe("http://gateway.example/v1");
    expect(buildBotProviderEnvironment({ OPENCODE_CONFIG_CONTENT: "{not json" })).toEqual({});
  });
  it("passes shell and browser sandboxes locale, terminal, PATH and Playwright settings only", () => {
    expect(
      buildBotToolEnvironment({
        PATH: "/bin",
        LANG: "C.UTF-8",
        TERM: "xterm",
        PLAYWRIGHT_BROWSERS_PATH: "/browsers",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/x",
        PLAYWRIGHT_LAUNCH_OPTIONS: "{}",
        HOME: "/host",
        OPENCODE_CONFIG_CONTENT: "{}",
        ANTHROPIC_API_KEY: "secret",
      }),
    ).toEqual({
      PATH: "/bin",
      LANG: "C.UTF-8",
      TERM: "xterm",
      PLAYWRIGHT_BROWSERS_PATH: "/browsers",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    });
  });
  it("merges sandbox-owned environment after host filtering", () => {
    expect(
      buildBotProviderEnvironment(
        { PATH: "/bin", INTERNAL_ONLY: "host" },
        { INTERNAL_ONLY: "sandbox" },
      ),
    ).toEqual({ PATH: "/bin", INTERNAL_ONLY: "sandbox" });
  });
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "GROK_HOME", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        GROK_HOME: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
        GROK_HOME: "~/.inherited-grok",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // A home variable in another spelling is still expanded.
      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "Codex_Home", value: "~/corp", sensitive: false }],
          {},
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
        ),
      ).toEqual({ CODEX_HOME: "/home/ada/corp" });
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});

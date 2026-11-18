// @effect-diagnostics nodeBuiltinImport:off - lays out a fake home and PATH on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ReadinessCheckId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { SandboxState } from "./BotSandbox.ts";
import { collectReadiness } from "./readiness.ts";

const collect = (
  sandbox: SandboxState,
  files: Readonly<Record<string, string>>,
  commands: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "readiness-" });
    const write = (file: string, text: string, mode = 0o644) => {
      const full = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
      NodeFS.writeFileSync(full, text, { mode });
    };
    for (const [file, text] of Object.entries(files)) write(file, text);
    for (const command of commands) write(NodePath.join("bin", command), "#!/bin/sh\n", 0o755);
    const stateDir = NodePath.join(root, "state");
    const readiness = yield* collectReadiness(
      {
        stateDir,
        secretsDir: NodePath.join(stateDir, "secrets"),
        settingsPath: NodePath.join(stateDir, "settings.json"),
      },
      sandbox,
    ).pipe(
      Effect.provideService(HostProcess.Environment, {
        HOME: NodePath.join(root, "home"),
        PATH: NodePath.join(root, "bin"),
        T3CODE_MEMORY_EMBED_URL: "off",
      }),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
    const check = (id: ReadinessCheckId) => readiness.checks.find((entry) => entry.id === id)!;
    return { readiness, check };
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)));

it.effect("without a sandbox, a signed-in Claude Code runs bots and Codex does not", () =>
  Effect.gen(function* () {
    const { readiness, check } = yield* collect(
      { kind: "absent", reason: "no bwrap" },
      { "home/.claude/.credentials.json": "{}", "home/.codex/auth.json": "{}" },
      ["claude", "codex"],
    );
    assert.deepEqual(readiness.keyedInstances, []);
    assert.include(check("sandbox"), { state: "missing", detail: "no bwrap" });
    assert.strictEqual(check("providers").state, "ok");
    assert.include(check("providers").detail, "Claude Code signed in;");
    assert.include(check("providers").detail, "Codex signed in, not for bots without the sandbox");
    assert.include(check("providers").detail, "OpenCode not installed");
    assert.strictEqual(check("ytdlp").state, "missing");
    assert.include(check("telegram"), { state: "off" });
    assert.include(check("cortex"), { state: "off" });
  }),
);

it.effect("in the sandbox, bots need a Claude instance with a key, found by variable name", () =>
  Effect.gen(function* () {
    const signedIn = yield* collect({ kind: "ready" }, { "home/.claude/.credentials.json": "{}" }, [
      "claude",
    ]);
    assert.strictEqual(signedIn.check("providers").state, "missing");
    assert.include(signedIn.check("providers").detail, "bots need an API key in the sandbox");

    const keyed = yield* collect(
      { kind: "ready" },
      {
        "state/settings.json": JSON.stringify({
          providerInstances: {
            endpoint: {
              driver: "claudeAgent",
              environment: [{ name: "ANTHROPIC_API_KEY", value: "", sensitive: true }],
            },
            homed: { driver: "claudeAgent", config: { homePath: "~/.claude-b" } },
            plain: { driver: "claudeAgent" },
          },
        }),
        "home/.claude-b/settings.json": JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }),
        "state/secrets/telegram-bot-token.bin": "token",
        "state/cortex-mcp.json": JSON.stringify({
          url: "http://127.0.0.1:1/mcp",
          bearerToken: "read",
        }),
      },
      ["claude"],
    );
    assert.deepEqual(keyed.readiness.keyedInstances, ["endpoint", "homed"]);
    assert.include(keyed.check("providers"), { state: "ok" });
    assert.include(keyed.check("telegram"), { state: "ok" });
    assert.include(keyed.check("cortex"), { state: "error" });
  }),
);

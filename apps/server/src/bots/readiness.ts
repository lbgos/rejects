/**
 * What works on this machine for bots: `doctor` prints it and the first run reads it through
 * `BOTS_ENDPOINTS.readiness`. Only names, paths and reachability are read, never a secret's value.
 */
import {
  type BotReadiness,
  type BotSandboxKind,
  botDriverFit,
  ProviderInstanceId,
  type ReadinessCheck,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import type { SandboxState } from "./BotSandbox.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { sandboxAbsence, sandboxCgroupProcs, SandboxSettings } from "./sandbox.ts";

export interface ReadinessPaths {
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly settingsPath: string;
}

const KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

const StoredSettings = Schema.Struct({
  providerInstances: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        driver: Schema.String,
        environment: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
        config: Schema.optional(Schema.Struct({ homePath: Schema.optional(Schema.String) })),
      }),
    ),
  ),
});
const ClaudeHomeSettings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const CortexFile = Schema.Struct({ url: Schema.String, bearerToken: Schema.String });

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const sandboxCheck = (sandbox: SandboxState): ReadinessCheck => {
  const base = { id: "sandbox", label: "Sandbox" } as const;
  switch (sandbox.kind) {
    case "ready":
      return {
        ...base,
        state: "ok",
        detail: "Bots run in bubblewrap with a shell, files and a browser.",
      };
    case "off":
      return {
        ...base,
        state: "off",
        detail: "Off in bot-sandbox.json: bots run without a shell.",
      };
    case "absent":
      return { ...base, state: "missing", detail: sandbox.reason };
    case "broken":
      return { ...base, state: "error", detail: sandbox.reason };
  }
};

const HARNESSES = [
  { driver: "claudeAgent", name: "Claude Code", command: "claude" },
  { driver: "codex", name: "Codex", command: "codex" },
  { driver: "opencode", name: "OpenCode", command: "opencode" },
] as const;

type Credential = "key" | "signedIn" | "unknown" | "none";

/** One line for the provider CLIs: which are installed, signed in or keyed, and which can run bots. */
const providersCheck = (
  sandbox: BotSandboxKind,
  found: ReadonlyArray<{
    readonly driver: string;
    readonly name: string;
    readonly installed: boolean;
    readonly credential: Credential;
  }>,
): ReadinessCheck => {
  const usable = (harness: (typeof found)[number]) =>
    harness.installed &&
    harness.credential !== "none" &&
    botDriverFit(harness.driver, sandbox, harness.credential === "key") === "ok";
  const describe = (harness: (typeof found)[number]) => {
    if (!harness.installed) return `${harness.name} not installed`;
    const credential = {
      key: "API key",
      signedIn: "signed in",
      unknown: "installed",
      none: "not signed in",
    }[harness.credential];
    const fit = botDriverFit(harness.driver, sandbox, harness.credential === "key");
    const note =
      fit === "needsKey"
        ? ", bots need an API key in the sandbox"
        : fit === "sandboxed"
          ? ", not for sandboxed bots"
          : fit === "toolsOn"
            ? ", not for bots without the sandbox"
            : "";
    return `${harness.name} ${credential}${note}`;
  };
  return {
    id: "providers",
    label: "Providers",
    state: found.some(usable) ? "ok" : "missing",
    detail: found.map(describe).join("; "),
  };
};

export const collectReadiness = Effect.fn("BotReadiness.collect")(function* (
  paths: ReadinessPaths,
  sandbox: SandboxState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const http = yield* HttpClient.HttpClient;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const found = (command: string) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.map((resolved) => resolved !== null),
      Effect.orElseSucceed(() => false),
    );
  const home = env.HOME ?? "";
  const ready = sandbox.kind === "ready";

  const settings = yield* fs.readFileString(paths.settingsPath).pipe(
    Effect.flatMap(decodeJson(StoredSettings)),
    Effect.orElseSucceed((): typeof StoredSettings.Type => ({})),
  );
  const homeKeyed = (dir: string) =>
    fs.readFileString(path.join(dir, "settings.json")).pipe(
      Effect.flatMap(decodeJson(ClaudeHomeSettings)),
      Effect.map((value) => KEY_NAMES.some((name) => typeof value.env?.[name] === "string")),
      Effect.orElseSucceed(() => false),
    );
  const defaultClaudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const instances = Object.entries(settings.providerInstances ?? {});
  if (!instances.some(([id]) => id === "claudeAgent"))
    instances.push(["claudeAgent", { driver: "claudeAgent" }]);
  const keyedInstances: ProviderInstanceId[] = [];
  for (const [id, instance] of instances) {
    if (instance.driver !== "claudeAgent") continue;
    const homePath = instance.config?.homePath?.trim();
    const keyed =
      (instance.environment ?? []).some((variable) => KEY_NAMES.includes(variable.name)) ||
      (yield* homeKeyed(homePath ? homePath.replace(/^~(?=\/|$)/, home) : defaultClaudeHome)) ||
      (!homePath && KEY_NAMES.some((name) => Boolean(env[name]?.trim())));
    if (keyed) keyedInstances.push(ProviderInstanceId.make(id));
  }

  const credentialOf = Effect.fn("BotReadiness.credential")(function* (driver: string) {
    switch (driver) {
      case "claudeAgent":
        if (keyedInstances.length > 0) return "key" as const;
        if (yield* exists(path.join(defaultClaudeHome, ".credentials.json")))
          return "signedIn" as const;
        // macOS keeps the login in the Keychain.
        return platform === "darwin" ? ("unknown" as const) : ("none" as const);
      case "codex":
        return (yield* exists(
          path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "auth.json"),
        ))
          ? ("signedIn" as const)
          : ("none" as const);
      default:
        // OpenCode signs in per provider, and its config can name keys too.
        return (yield* exists(
          path.join(
            env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share"),
            "opencode",
            "auth.json",
          ),
        ))
          ? ("signedIn" as const)
          : ("unknown" as const);
    }
  });
  const harnesses = yield* Effect.forEach(HARNESSES, (harness) =>
    Effect.gen(function* () {
      const installed = yield* found(harness.command);
      return {
        ...harness,
        installed,
        credential: installed ? yield* credentialOf(harness.driver) : ("none" as const),
      };
    }),
  );

  const camofox = yield* exists(path.join(paths.stateDir, "camofox.json"));
  const chromium = yield* found("chromium");
  const browser: ReadinessCheck = {
    id: "browser",
    label: "Browser",
    state: camofox || (chromium && ready) ? "ok" : "off",
    detail: [
      camofox ? "web_browse uses Camoufox" : "web_browse off (no camofox.json)",
      !chromium
        ? "Chromium not installed"
        : ready
          ? "Chromium for the bot computer"
          : "Chromium needs the sandbox",
    ].join("; "),
  };

  const ffmpeg =
    (yield* exists(path.join(paths.stateDir, "tools", "ffmpeg"))) || (yield* found("ffmpeg"));
  const ytDlp = yield* exists(path.join(paths.stateDir, "tools", "yt-dlp"));
  const ytdlp: ReadinessCheck = {
    id: "ytdlp",
    label: "yt-dlp",
    state: ready && ffmpeg ? "ok" : "missing",
    detail: [
      ready ? "runs in the sandbox" : "needs the sandbox",
      ffmpeg ? "ffmpeg found" : "ffmpeg not installed",
      ytDlp ? "yt-dlp downloaded" : "yt-dlp downloads on first use",
    ].join("; "),
  };

  const telegram: ReadinessCheck = (yield* exists(
    path.join(paths.secretsDir, "telegram-bot-token.bin"),
  ))
    ? { id: "telegram", label: "Telegram", state: "ok", detail: "A bot token is set." }
    : {
        id: "telegram",
        label: "Telegram",
        state: "off",
        detail: "Optional: add a bot token in Connections, Telegram.",
      };

  const probe = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.timeout("3 seconds"),
      Effect.map((response) => response.status === 200),
      Effect.orElseSucceed(() => false),
    );
  const cortexFile = yield* fs
    .readFileString(path.join(paths.stateDir, "cortex-mcp.json"))
    .pipe(Effect.flatMap(decodeJson(CortexFile)), Effect.option);
  const cortex: ReadinessCheck =
    cortexFile._tag === "None"
      ? {
          id: "cortex",
          label: "Cortex",
          state: "off",
          detail: "Optional: no cortex-mcp.json, see docs/user/cortex.md.",
        }
      : (yield* HttpClientRequest.post(cortexFile.value.url).pipe(
            HttpClientRequest.bearerToken(cortexFile.value.bearerToken),
            HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
            HttpClientRequest.bodyJson({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            Effect.flatMap(probe),
            Effect.orElseSucceed(() => false),
          ))
        ? {
            id: "cortex",
            label: "Cortex",
            state: "ok",
            detail: `Answers at ${cortexFile.value.url}.`,
          }
        : {
            id: "cortex",
            label: "Cortex",
            state: "error",
            detail: `cortex-mcp.json names ${cortexFile.value.url}, which does not answer.`,
          };

  const embedUrl = (env.T3CODE_MEMORY_EMBED_URL?.trim() || "http://127.0.0.1:3982").replace(
    /\/+$/,
    "",
  );
  const embedder: ReadinessCheck =
    embedUrl === "off"
      ? {
          id: "embedder",
          label: "Embedder",
          state: "off",
          detail: "Off: memory search is lexical.",
        }
      : (yield* probe(HttpClientRequest.get(`${embedUrl}/health`)))
        ? { id: "embedder", label: "Embedder", state: "ok", detail: "Memory search is hybrid." }
        : {
            id: "embedder",
            label: "Embedder",
            state: "off",
            detail: `Nothing answers at ${embedUrl}: memory search is lexical, see docs/user/cortex.md.`,
          };

  return {
    sandbox: sandbox.kind,
    keyedInstances,
    checks: [
      sandboxCheck(sandbox),
      providersCheck(sandbox.kind, harnesses),
      browser,
      ytdlp,
      telegram,
      cortex,
      embedder,
    ],
  } satisfies BotReadiness;
});

/**
 * The sandbox as seen from outside the server, for `doctor`. The network rule counts as set up
 * when the running server's cgroup has its `sandbox` child; with no server running, once
 * `scripts/bot-sandbox-net.sh` has loaded it for some unit.
 */
export const outsideSandboxState = Effect.fn("BotReadiness.outsideSandbox")(function* (
  paths: ReadinessPaths & { readonly serverRuntimeStatePath: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const settings = yield* fs.readFileString(path.join(paths.stateDir, "bot-sandbox.json")).pipe(
    Effect.flatMap(decodeJson(SandboxSettings)),
    Effect.orElseSucceed(() => ({ enabled: true, network: undefined })),
  );
  if (!settings.enabled) return { kind: "off" } satisfies SandboxState;
  const bwrap = yield* resolveCommandPath("bwrap", { env }).pipe(Effect.orElseSucceed(() => null));
  const server = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath).pipe(
    Effect.map(Option.filter((state) => isProcessAlive(state.pid))),
    Effect.orElseSucceed(() => Option.none()),
  );
  const loaded = Option.isSome(server)
    ? yield* fs.readFileString(`/proc/${server.value.pid}/cgroup`).pipe(
        Effect.map(sandboxCgroupProcs),
        Effect.flatMap((procs) =>
          procs === undefined ? Effect.succeed(false) : fs.exists(path.dirname(procs)),
        ),
        Effect.orElseSucceed(() => false),
      )
    : yield* fs.readDirectory("/run/bot-sandbox-net").pipe(
        Effect.map((names) => names.some((name) => name.endsWith(".loaded"))),
        Effect.orElseSucceed(() => false),
      );
  const reason = sandboxAbsence({
    platform,
    bwrap: bwrap !== null,
    networkOpen: settings.network === "open",
    networkSetUp: loaded,
  });
  if (reason !== undefined) return { kind: "absent", reason } satisfies SandboxState;
  const works = yield* runner
    .run({
      command: bwrap!,
      args: ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"],
      timeout: "10 seconds",
    })
    .pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
    );
  return works
    ? ({ kind: "ready" } satisfies SandboxState)
    : ({
        kind: "broken",
        reason:
          "bubblewrap cannot create a sandbox here: unprivileged user namespaces must work, see docs/operations/bot-sandbox.md.",
      } satisfies SandboxState);
});

const MARK = { ok: "ok", off: "off", missing: "missing", error: "error" } as const;

/** `doctor`'s lines, one per check. */
export const formatReadiness = (readiness: BotReadiness) =>
  readiness.checks.map(
    (check) => `  ${MARK[check.state].padEnd(8)}${check.label.padEnd(11)}${check.detail}`,
  );

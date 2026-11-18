// @effect-diagnostics nodeBuiltinImport:off - runs real sandboxes and reads their output.
// @effect-diagnostics processEnvInEffect:off - sandboxes inherit the real PATH.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BotRecord,
  ChatAttachmentId,
  ChatFileAttachment,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AgentScope, AgentScopeThreadId, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Config from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ModelProxy from "./BotModelProxy.ts";
import * as Sandbox from "./BotSandbox.ts";
import { BotStore } from "./BotStore.ts";
import { makeLocal } from "./LocalComputer.ts";

/** Hosts without working user namespaces (some CI kernels) skip the tests that need bwrap. */
const bwrapWorks =
  NodeChildProcess.spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"]).status ===
  0;
const chromiumWorks = NodeChildProcess.spawnSync("chromium", ["--version"]).status === 0;
const ownCgroup = (() => {
  const line = NodeFS.readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("0::"));
  const dir = line === undefined ? undefined : `/sys/fs/cgroup${line.slice(3).trim()}`;
  return dir !== undefined && process.getuid?.() === 0 && NodeFS.existsSync(dir) ? dir : undefined;
})();
const unshareWorks = NodeChildProcess.spawnSync("unshare", ["-Ur", "true"]).status === 0;

const bot = (id: string): BotRecord => ({
  name: id,
  persona: "Test bot",
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-08T00:00:00Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
});
const owners = new Map([
  ["news", bot("news")],
  ["vocab", bot("vocab")],
  ["wake-news", bot("news")],
]);

const withServer = <A, E>(
  options: {
    readonly path?: string;
    readonly sandbox?: "on" | "off";
    /** `restricted` needs the root-loaded rule, which tests do not have; the default is open. */
    readonly network?: "open" | "restricted";
    readonly env?: NodeJS.ProcessEnv;
    readonly probes?: Array<number>;
    readonly loadedRule?: string;
    /** A restricted network's cgroup exists, as after the root script ran once; the default. */
    readonly networkSetUp?: boolean;
    /** PATH holds only a `bwrap` that exits 0, so the sandbox counts as present. */
    readonly fakeBwrap?: boolean;
  },
  body: (server: {
    readonly home: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Effect.Effect<A, E, Sandbox.BotSandbox | ModelProxy.BotModelProxy | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "bot-sandbox-" }));
    const home = NodePath.join(root, "rejects");
    const state = NodePath.join(home, "userdata");
    const write = (file: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, text);
    };
    write(NodePath.join(state, "statev2.sqlite"), "server state");
    write(NodePath.join(state, "secrets", "server-signing.bin"), "server secret");
    write(NodePath.join(root, "rejects-vault", "audit.jsonl"), "vault");
    write(
      NodePath.join(home, ".claude-x", "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://models.example/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-real-model-key",
          ANTHROPIC_MODEL: "deepseek-v4.1-flash",
          MAX_THINKING_TOKENS: "1024",
        },
        apiKeyHelper: "echo sk-helper-key",
      }),
    );
    write(NodePath.join(home, ".claude-x", "settings.json.bak-old"), '{"env":{"K":"sk-old-key"}}');
    write(NodePath.join(home, ".claude-x", ".credentials.json"), '{"token":"sk-oauth-key"}');
    write(NodePath.join(home, ".claude-x", "projects", "old.jsonl"), "server-side transcript");
    NodeFS.symlinkSync(NodePath.join(state, "secrets"), NodePath.join(home, ".claude-x", "skills"));
    if (options.sandbox === "off")
      write(NodePath.join(state, "bot-sandbox.json"), '{"enabled":false}');
    else if (options.network !== "restricted")
      write(NodePath.join(state, "bot-sandbox.json"), '{"enabled":true,"network":"open"}');
    const fakeBin = NodePath.join(root, "fake-bin");
    if (options.fakeBwrap) {
      write(NodePath.join(fakeBin, "bwrap"), "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(NodePath.join(fakeBin, "bwrap"), 0o755);
    }
    const env = {
      PATH: options.fakeBwrap ? fakeBin : (options.path ?? process.env.PATH),
      HOME: home,
      CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude-x"),
      ...options.env,
    };
    const probes = options.probes;
    const runner = probes
      ? Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.succeed({
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(
                input.args.at(-1) === "true" ? 0 : (probes.shift() ?? 1),
              ),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        })
      : ProcessRunner.layer;
    const layer = Sandbox.layerWithRunner.pipe(
      Layer.provideMerge(ModelProxy.layer),
      Layer.provide(runner),
      Layer.provide(
        Layer.mock(BotStore)({
          owner: (id) => Effect.succeed(owners.get(id)),
          mainBot: Effect.succeed(ThreadId.make("vocab")),
          list: Effect.succeed([]),
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Environment, env)),
      Layer.provide(Config.layerTest(process.cwd(), home)),
      Layer.provide(
        Layer.effect(
          FileSystem.FileSystem,
          FileSystem.FileSystem.pipe(
            Effect.map((real) => ({
              ...real,
              exists: (file: string) =>
                options.networkSetUp !== false && /^\/sys\/fs\/cgroup(\/.*)?\/sandbox$/.test(file)
                  ? Effect.succeed(true)
                  : real.exists(file),
              readFileString: (file: string, encoding?: string) =>
                options.loadedRule === undefined
                  ? real.readFileString(file, encoding)
                  : file === "/proc/self/cgroup"
                    ? Effect.succeed("0::/system.slice/rejects.service\n")
                    : file === "/run/bot-sandbox-net/rejects.service.loaded"
                      ? Effect.succeed(options.loadedRule)
                      : real.readFileString(file, encoding),
            })),
          ),
        ),
      ),
    );
    return yield* body({ home, env }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const launch = (threadId: string, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.BotSandbox;
    const command = yield* sandbox.provider(threadId, "/bin/sh", env, []);
    assert.isDefined(command);
    return command!;
  });

const run = (command: Sandbox.SandboxCommand, env: NodeJS.ProcessEnv, script: string) =>
  NodeChildProcess.spawnSync(command.command, [...command.args, "-c", script], {
    env,
    encoding: "utf8",
  });

describe("bot sandbox", () => {
  it.live.skipIf(!bwrapWorks)(
    "a bot reaches its own workspace and shared config, never other bots, the vault or server state",
    () =>
      withServer({}, ({ home, env }) =>
        Effect.gen(function* () {
          const state = NodePath.join(home, "userdata");
          const vocab = run(
            yield* launch("vocab", env),
            env,
            'echo vocab-notes > notes.txt && mkdir -p "$CLAUDE_CONFIG_DIR/projects" && echo vocab-chat > "$CLAUDE_CONFIG_DIR/projects/vocab.jsonl"',
          );
          assert.strictEqual(vocab.status, 0, vocab.stderr);
          const targets = [
            NodePath.join(state, "statev2.sqlite"),
            NodePath.join(state, "secrets", "server-signing.bin"),
            NodePath.join(home, "..", "rejects-vault", "audit.jsonl"),
            NodePath.join(state, "bots", "vocab", "notes.txt"),
            NodePath.join(
              state,
              "sandbox",
              "vocab",
              "home",
              ".claude-x",
              "projects",
              "vocab.jsonl",
            ),
            NodePath.join(home, ".claude-x", "projects", "old.jsonl"),
            NodePath.join(home, ".claude-x", "projects", "vocab.jsonl"),
            NodePath.join(home, ".claude-x", "skills", "server-signing.bin"),
            NodePath.join(home, ".claude-x", ".credentials.json"),
            NodePath.join(home, ".claude-x", "settings.json.bak-old"),
          ];
          const news = run(
            yield* launch("news", env),
            env,
            [
              ...targets.map(
                (target) => `if cat '${target}' >/dev/null 2>&1; then echo "READ ${target}"; fi`,
              ),
              "ls",
              'cat "$CLAUDE_CONFIG_DIR/settings.json"; echo',
              'echo changed 2>/dev/null > "$CLAUDE_CONFIG_DIR/settings.json" || echo settings-read-only',
              "echo news-draft > draft.txt",
            ].join("\n"),
          );
          assert.strictEqual(news.status, 0, news.stderr);
          assert.notInclude(news.stdout, "READ");
          assert.notInclude(news.stdout, "notes.txt");
          assert.notInclude(news.stdout, "sk-");
          assert.include(news.stdout, '"ANTHROPIC_BASE_URL":"http://127.0.0.1:');
          assert.include(news.stdout, '"MAX_THINKING_TOKENS":"1024"');
          assert.include(news.stdout, "settings-read-only");
          const token = /"ANTHROPIC_AUTH_TOKEN":"(t3bot-[^"]+)"/.exec(news.stdout)?.[1];
          assert.isDefined(token);
          const granted = yield* (yield* ModelProxy.BotModelProxy).resolve(token!);
          assert.deepEqual(granted, {
            bot: "news",
            upstream: {
              baseUrl: "https://models.example/anthropic",
              headers: { authorization: "Bearer sk-real-model-key" },
            },
          });
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(state, "bots", "news", "draft.txt"), "utf8"),
            "news-draft\n",
          );
          const wake = run(yield* launch("wake-news", env), env, "cat draft.txt");
          assert.strictEqual(wake.stdout, "news-draft\n");
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "a bot reads the files attached in its thread, and another thread's files stay out of its sandbox",
    () =>
      withServer({}, ({ home, env }) =>
        Effect.gen(function* () {
          const state = NodePath.join(home, "userdata");
          const attachments = NodePath.join(state, "attachments");
          NodeFS.mkdirSync(attachments, { recursive: true });
          const own = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make("news-00000000-0000-4000-8000-000000000001"),
            name: "catalog.pdf",
            mimeType: "application/pdf",
            sizeBytes: 7,
          });
          const sibling = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make("wake-news-00000000-0000-4000-8000-000000000003"),
            name: "wake.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
          });
          const other = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make("vocab-00000000-0000-4000-8000-000000000002"),
            name: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 6,
          });
          const ownPath = NodePath.join(attachments, `${own.id}.pdf`);
          const siblingPath = NodePath.join(attachments, `${sibling.id}.pdf`);
          const otherPath = NodePath.join(attachments, `${other.id}.pdf`);
          NodeFS.writeFileSync(ownPath, "catalog");
          NodeFS.writeFileSync(`${ownPath}.txt`, "catalog text");
          NodeFS.writeFileSync(siblingPath, "wake");
          NodeFS.writeFileSync(otherPath, "vocab!");
          const sandbox = yield* Sandbox.BotSandbox;
          yield* sandbox.stageAttachments("news", [own]);
          yield* sandbox.stageAttachments("wake-news", [sibling]);
          const result = run(
            yield* launch("news", env),
            env,
            [
              `cat '${ownPath}'`,
              `if cat '${siblingPath}' >/dev/null 2>&1; then echo SIBLING-LEAKED; fi`,
              `if cat '${otherPath}' >/dev/null 2>&1; then echo LEAKED; fi`,
            ].join("; "),
          );
          assert.strictEqual(result.status, 0, result.stderr);
          assert.include(result.stdout, "catalog");
          assert.notInclude(result.stdout, "SIBLING-LEAKED");
          assert.notInclude(result.stdout, "LEAKED");
          // The server copies into the view on every chat turn; a link planted there would turn
          // that copy into a write anywhere the server may write, such as the sandbox switch.
          const sandboxSwitch = NodePath.join(state, "bot-sandbox.json");
          const switchBefore = NodeFS.readFileSync(sandboxSwitch, "utf8");
          const plant = run(
            yield* launch("news", env),
            env,
            `rm -f '${ownPath}' '${ownPath}.txt' && ln -s '${sandboxSwitch}' '${ownPath}.txt' && echo PLANTED`,
          );
          assert.notInclude(plant.stdout, "PLANTED");
          // A link left from when views were writable is replaced, not written through.
          const view = NodePath.join(state, "sandbox", "news", "attachments", "news");
          NodeFS.rmSync(NodePath.join(view, `${own.id}.pdf`), { force: true });
          NodeFS.rmSync(NodePath.join(view, `${own.id}.pdf.txt`), { force: true });
          NodeFS.symlinkSync(sandboxSwitch, NodePath.join(view, `${own.id}.pdf.txt`));
          yield* sandbox.stageAttachments("news", [own]);
          assert.strictEqual(NodeFS.readFileSync(sandboxSwitch, "utf8"), switchBefore);
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(view, `${own.id}.pdf.txt`), "utf8"),
            "catalog text",
          );
          yield* sandbox.stageAttachments("vocab", [other]);
          const main = run(
            yield* launch("vocab", env),
            env,
            `if cat '${otherPath}' >/dev/null 2>&1; then echo MAIN-READ; fi`,
          );
          assert.notInclude(main.stdout, "MAIN-READ");
        }),
      ),
  );

  it.live(
    "staging gives each attachment a short path under its file name, numbered on a clash",
    () =>
      withServer({}, ({ home }) =>
        Effect.gen(function* () {
          const state = NodePath.join(home, "userdata");
          const attachments = NodePath.join(state, "attachments");
          NodeFS.mkdirSync(attachments, { recursive: true });
          const file = (n: number, name: string, content: string) => {
            const attachment = ChatFileAttachment.make({
              type: "file",
              id: ChatAttachmentId.make(`news-00000000-0000-4000-8000-00000000000${n}`),
              name,
              mimeType: "application/octet-stream",
              sizeBytes: content.length,
            });
            NodeFS.writeFileSync(
              NodePath.join(attachments, `${attachment.id}${NodePath.extname(name)}`),
              content,
            );
            return attachment;
          };
          const first = file(1, "report.xlsx", "one");
          const second = file(2, "report.xlsx", "two!");
          const sandbox = yield* Sandbox.BotSandbox;
          const staged = yield* sandbox.stageAttachments("news", [first, second]);
          assert.strictEqual(staged.get(first.id), NodePath.join(attachments, "report.xlsx"));
          assert.strictEqual(staged.get(second.id), NodePath.join(attachments, "report-2.xlsx"));
          const again = yield* sandbox.stageAttachments("news", [second]);
          assert.strictEqual(again.get(second.id), NodePath.join(attachments, "report-2.xlsx"));
          const view = NodePath.join(state, "sandbox", "news", "attachments", "news");
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(view, "report.xlsx"), "utf8"),
            "one",
          );
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(view, "report-2.xlsx"), "utf8"),
            "two!",
          );
          assert.strictEqual(
            NodeFS.statSync(NodePath.join(view, "report.xlsx")).ino,
            NodeFS.statSync(NodePath.join(view, `${first.id}.xlsx`)).ino,
          );
          const main = yield* sandbox.stageAttachments("vocab", [file(3, "notes.pdf", "n")]);
          assert.strictEqual(main.size, 0);
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "a CLI writes its own installation_id, also over a placeholder left from when it was shared",
    () =>
      withServer({}, ({ home, env }) =>
        Effect.gen(function* () {
          const codexHome = NodePath.join(home, ".codex-x");
          NodeFS.mkdirSync(codexHome);
          NodeFS.writeFileSync(NodePath.join(codexHome, "config.toml"), "shared config");
          NodeFS.writeFileSync(NodePath.join(codexHome, "installation_id"), "server id");
          // bwrap leaves an empty read-only mount point in the bot's home for each shared file.
          const placeholder = NodePath.join(
            home,
            "userdata",
            "sandbox",
            "news",
            "home",
            ".codex-x",
            "installation_id",
          );
          NodeFS.mkdirSync(NodePath.dirname(placeholder), { recursive: true });
          NodeFS.writeFileSync(placeholder, "", { mode: 0o444 });
          const codexEnv = { ...env, CODEX_HOME: codexHome };
          // Codex CLI 0.156 rewrites installation_id at start and exits when it cannot.
          const result = run(
            yield* launch("news", codexEnv),
            codexEnv,
            'echo bot-id > "$CODEX_HOME/installation_id" && { cat "$CODEX_HOME/config.toml" 2>/dev/null || echo config-absent; }',
          );
          assert.strictEqual(result.status, 0, result.stderr);
          assert.strictEqual(result.stdout, "config-absent\n");
          assert.strictEqual(NodeFS.readFileSync(placeholder, "utf8"), "bot-id\n");
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(codexHome, "installation_id"), "utf8"),
            "server id",
          );
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "leaves no process behind when the command exits or its launcher is killed",
    () =>
      withServer({}, ({ env }) =>
        Effect.gen(function* () {
          const command = yield* launch("news", env);
          // A detached sleeper holds stdout open, so stdout ends only once nothing in the
          // sandbox is left; a leaked process keeps the test waiting until it fails.
          const finished = (script: string, kill: boolean) =>
            Effect.promise(
              () =>
                new Promise<string>((resolve) => {
                  const child = NodeChildProcess.spawn(
                    command.command,
                    [...command.args, "-c", script],
                    { env, detached: true, stdio: ["ignore", "pipe", "ignore"] },
                  );
                  let output = "";
                  child.stdout.on("data", (chunk: Buffer) => {
                    output += chunk.toString("utf8");
                    if (kill && output.includes("ready")) process.kill(-child.pid!, "SIGKILL");
                  });
                  child.stdout.on("end", () => resolve(output));
                }),
            );
          const sleeper = "setsid sleep 600 & echo ready";
          assert.include(yield* finished(sleeper, false), "ready");
          assert.include(yield* finished(`${sleeper}; sleep 600`, true), "ready");
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "the local computer keeps files and commands in the bot's own sandbox",
    () =>
      withServer({}, ({ home }) =>
        Effect.gen(function* () {
          const state = NodePath.join(home, "userdata");
          const machine = yield* makeLocal;
          const settings = { enabled: true };
          const news = ThreadId.make("news");
          const saved = yield* machine.putFile(
            settings,
            news,
            "../report.txt",
            new TextEncoder().encode("quarterly"),
          );
          assert.strictEqual(saved, "inbox/report.txt");
          assert.strictEqual(
            NodeFS.readFileSync(NodePath.join(state, "bots", "news", saved), "utf8"),
            "quarterly",
          );
          const shell = yield* machine.shell(
            settings,
            news,
            `cat inbox/report.txt; test "$TOKEN" = tok-1 && test "$(cat "$KEY")" = key-2 || echo no-secrets; ls /tmp/.bot-secrets | grep -v '^KEY$'; ln -s '${state}/secrets/server-signing.bin' leak`,
            30,
            [
              { env: "TOKEN", value: "tok-1", file: false },
              { env: "KEY", value: "key-2", file: true },
            ],
          );
          assert.include(shell, { exitCode: 0, output: "quarterly" });
          const own = yield* machine.getFile(settings, news, "inbox/report.txt", 1000);
          assert.isTrue(own.ok && new TextDecoder().decode(own.bytes) === "quarterly");
          // The link resolves inside the sandbox, where server state does not exist.
          assert.deepEqual(yield* machine.getFile(settings, news, "leak", 1000), {
            ok: false,
            reason: "missing",
          });
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks || !chromiumWorks)(
    "the bot's browser reads a page that declares no charset as UTF-8",
    () =>
      withServer({}, () =>
        Effect.gen(function* () {
          // Python's http.server and many small sites send text/html without a charset.
          const port = yield* Effect.acquireRelease(
            Effect.callback<NodeHttp.Server>((resume) => {
              const server = NodeHttp.createServer((_request, response) => {
                response.writeHead(200, { "content-type": "text/html" });
                response.end("<!doctype html><title>Реєстр</title><p>Шевченко Олег — ШО-1199</p>");
              });
              server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
            }),
            (server) =>
              Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
          ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));
          const machine = yield* makeLocal;
          const opened = yield* machine.browse({ enabled: true }, ThreadId.make("news"), {
            action: "open",
            url: `http://127.0.0.1:${port}/`,
          });
          assert.include(JSON.stringify(opened), "Шевченко Олег — ШО-1199");
        }),
      ),
  );

  it.live("without bwrap there is no sandbox: a bot runs on the host and gets no shell", () =>
    withServer({ path: "/nonexistent" }, ({ env }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.BotSandbox;
        assert.isUndefined(yield* sandbox.unavailable);
        const state = yield* sandbox.state;
        assert.strictEqual(state.kind, "absent");
        assert.match("reason" in state ? state.reason : "", /bwrap\) is not installed/);
        assert.isUndefined(yield* sandbox.identity("news"));
        assert.isUndefined(yield* sandbox.provider("news", "/bin/sh", env, []));
        assert.match(String(yield* sandbox.shell("news")), /bots run without a shell/);
      }),
    ),
  );

  it.live.skipIf(!bwrapWorks)(
    "without the network rule set up there is no sandbox, and bots get no shell",
    () =>
      withServer({ network: "restricted", networkSetUp: false }, ({ env }) =>
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.BotSandbox;
          assert.strictEqual((yield* sandbox.state).kind, "absent");
          assert.isUndefined(yield* sandbox.provider("news", "/bin/sh", env, []));
          assert.match(String(yield* sandbox.shell("news")), /network rule is not set up/);
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "fails closed when the network rule is set up but lets a bot reach the host's loopback",
    () =>
      withServer({ network: "restricted", probes: [0, 0, 0] }, ({ env }) =>
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.BotSandbox;
          assert.match((yield* sandbox.unavailable) ?? "", /loopback and local network/);
          assert.strictEqual((yield* sandbox.state).kind, "broken");
          const refused = run(yield* launch("news", env), env, "echo ran");
          assert.strictEqual(refused.status, 126);
          assert.notInclude(refused.stdout, "ran");
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "the shell sandbox keeps PATH, locale and terminal and drops host credentials",
    () =>
      withServer(
        { env: { LANG: "C.UTF-8", TERM: "xterm", ANTHROPIC_API_KEY: "host-secret" } },
        () =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox.BotSandbox;
            const shell = yield* sandbox.shell("news");
            assert.isNotString(shell);
            const { command, args } = shell as Sandbox.SandboxCommand;
            const result = NodeChildProcess.spawnSync(
              command,
              [
                ...args,
                "/bin/sh",
                "-c",
                'echo "$LANG|$TERM|${ANTHROPIC_API_KEY-unset}"; echo "$PATH"',
              ],
              { env: {}, encoding: "utf8" },
            );
            const [vars, path] = result.stdout.trim().split("\n");
            assert.strictEqual(vars, "C.UTF-8|xterm|unset");
            assert.strictEqual(path, process.env.PATH);
          }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "checks the network rule at every launch, so a rule that went away stops the next one",
    () =>
      withServer({ network: "restricted", probes: [1, 0] }, () =>
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.BotSandbox;
          assert.isObject(yield* sandbox.shell("news"));
          assert.match(String(yield* sandbox.shell("news")), /reached this server's loopback/);
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks || !unshareWorks || ownCgroup === undefined)(
    "a bot cannot move itself into another bot's cgroup to take its network grants",
    () =>
      withServer({ network: "restricted", probes: [1] }, () =>
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.BotSandbox;
          const shared = NodePath.join(ownCgroup!, "sandbox");
          const granted = NodePath.join(shared, "vocab");
          NodeFS.mkdirSync(granted, { recursive: true });
          try {
            const shell = yield* sandbox.shell("news");
            assert.isObject(shell, String(shell));
            const command = shell as Sandbox.SandboxCommand;
            // A nested user and cgroup namespace may mount cgroup2; it shows only what is below
            // the cgroup the bot started in.
            const escape = NodeChildProcess.spawnSync(
              command.command,
              [
                ...command.args,
                "/bin/sh",
                "-c",
                `unshare -Urm -C sh -c 'mkdir -p /tmp/cg && mount -t cgroup2 none /tmp/cg && echo mounted || exit 3
                 for procs in /tmp/cg/*/cgroup.procs; do echo $$ > "$procs" 2>/dev/null && echo "moved $procs"; done
                 cat /proc/self/cgroup'`,
              ],
              { encoding: "utf8" },
            );
            assert.strictEqual(escape.status, 0, escape.stderr);
            assert.include(escape.stdout, "mounted");
            assert.notInclude(escape.stdout, "moved", escape.stdout);
          } finally {
            for (const dir of [granted, NodePath.join(shared, "news"), shared])
              if (NodeFS.existsSync(dir)) NodeFS.rmdirSync(dir);
          }
        }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "a bot's local network grants and the filtered provider environment reach its sandbox together",
    () =>
      withServer(
        {
          network: "restricted",
          probes: [1, 1],
          env: {
            LANG: "C.UTF-8",
            ANTHROPIC_API_KEY: "host-secret",
            BOT_LOCAL_NETWORK: "0.0.0.0/0",
          },
          loadedRule:
            "* 127.0.0.1:3774\nnews 192.168.1.0/24:22\nnews 192.168.1.5:80\nvocab 10.0.0.0/8:80\n",
        },
        ({ env }) =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox.BotSandbox;
            const setenv = (args: ReadonlyArray<string>) =>
              args.flatMap((arg, index) =>
                arg === "--setenv" ? [[args[index + 1], args[index + 2]] as const] : [],
              );
            const launched = yield* sandbox.provider("news", "/bin/sh", env, []);
            const shell = yield* sandbox.shell("news");
            assert.isNotString(shell);
            for (const { command, args } of [launched!, shell as Sandbox.SandboxCommand]) {
              assert.include(args, "--clearenv");
              const vars = setenv(args);
              const names = vars.map(([name]) => name);
              assert.notInclude(names, "ANTHROPIC_API_KEY");
              assert.include(vars.find(([name]) => name === "LANG") ?? [], "C.UTF-8");
              const local = vars.filter(([name]) => name === "BOT_LOCAL_NETWORK");
              assert.deepEqual(local, [
                ["BOT_LOCAL_NETWORK", "127.0.0.1:3774 192.168.1.0/24:22 192.168.1.5:80"],
              ]);
              assert.isAbove(names.lastIndexOf("BOT_LOCAL_NETWORK"), names.indexOf("LANG"));
              assert.include(command === "/bin/sh" ? args.join(" ") : "", "/news/cgroup.procs");
            }
          }),
      ),
  );

  it.live.skipIf(!bwrapWorks)(
    "with the switch off, the bot's computer keeps bwrap and needs no network rule",
    () =>
      withServer({ sandbox: "off" }, () =>
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.BotSandbox;
          assert.isNotString(yield* sandbox.shell("news"));
        }),
      ),
  );

  it.live("with the switch off, bots run as before", () =>
    withServer({ sandbox: "off", path: "/nonexistent" }, ({ env, home }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.BotSandbox;
        assert.isUndefined(yield* sandbox.unavailable);
        assert.isUndefined(yield* sandbox.provider("news", "/bin/sh", env, []));
        assert.isUndefined(yield* sandbox.filePath("news", NodePath.join(home, "shared", "a.md")));
      }),
    ),
  );

  it.live(
    "a path a bot names maps to the existing host file behind its home, work dir or attachments",
    () =>
      withServer({ fakeBwrap: true }, ({ home }) =>
        Effect.gen(function* () {
          const state = NodePath.join(home, "userdata");
          const sandbox = yield* Sandbox.BotSandbox;
          const write = (file: string) => {
            NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
            NodeFS.writeFileSync(file, "x");
            return file;
          };
          const shared = NodePath.join(home, "shared", "research", "prices.md");
          const cases = [
            ["news", shared, ["sandbox", "news", "home", "shared", "research", "prices.md"]],
            ["wake-news", NodePath.join(state, "bots", "draft.txt"), ["bots", "news", "draft.txt"]],
            [
              "news",
              NodePath.join(state, "attachments", "card.pdf"),
              ["sandbox", "news", "attachments", "news", "card.pdf"],
            ],
          ] as const;
          for (const [thread, named] of cases)
            assert.isUndefined(yield* sandbox.filePath(thread, named));
          for (const [thread, named, host] of cases) {
            const file = write(NodePath.join(state, ...host));
            assert.strictEqual(yield* sandbox.filePath(thread, named), file);
          }
          assert.isUndefined(yield* sandbox.filePath("news", "/etc/hostname"));
          assert.isUndefined(yield* sandbox.filePath("user", shared));
          // Main gets no attachments view; the host file it names stays where it is.
          write(NodePath.join(state, "attachments", "main-card.pdf"));
          assert.isUndefined(
            yield* sandbox.filePath("vocab", NodePath.join(state, "attachments", "main-card.pdf")),
          );
        }),
      ),
  );

  it.live("wraps provider launches of bot threads, by explicit or ambient thread id", () =>
    withServer({ fakeBwrap: true }, ({ env }) =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const inner: AgentScopeShape = {
          wrap: ({ command, args }) =>
            Effect.sync(() => {
              seen.push(command);
              return { command, args };
            }),
          oomKilled: () => Effect.succeed(false),
          kill: () => Effect.succeed(false),
          stop: () => Effect.void,
          clear: () => Effect.void,
        };
        yield* Effect.gen(function* () {
          const scope = yield* AgentScope;
          yield* scope.wrap({ command: "claude", args: [], name: "claude", threadId: "news" });
          yield* scope
            .wrap({ command: "opencode", args: ["serve"], name: "opencode" })
            .pipe(Effect.provideService(AgentScopeThreadId, "wake-news"));
          yield* scope.wrap({ command: "claude", args: [], name: "claude", threadId: "user" });
          yield* scope.wrap({
            command: "bash",
            args: [],
            name: "terminal",
            threadId: "news",
            survivesRestart: true,
          });
        }).pipe(
          Effect.provide(
            Sandbox.agentScopeLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AgentScope, inner),
                  Layer.mock(BotStore)({
                    owner: (id) => Effect.succeed(owners.get(id)),
                    mainBot: Effect.succeed(ThreadId.make("vocab")),
                    list: Effect.succeed([]),
                  }),
                ),
              ),
            ),
          ),
        );
        const bwrap = NodePath.join(env.PATH!, "bwrap");
        assert.deepEqual(seen, [bwrap, bwrap, "claude", "bash"]);
      }),
    ),
  );
});

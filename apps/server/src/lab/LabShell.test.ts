import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotRecord,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as Notifications from "../bots/BotNotifications.ts";
import * as BotStore from "../bots/BotStore.ts";
import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as LabShell from "./LabShell.ts";

const homelab: BotRecord = {
  name: "Homelab",
  persona: "Homelab",
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "flash" },
  threadId: ThreadId.make("homelab"),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-17T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
};

const scopeIn = (
  threadId: string,
  botThreadId: string = threadId,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  botThreadId: ThreadId.make(botThreadId),
  client: undefined,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "session",
    providerInstanceId: homelab.modelSelection.instanceId,
  },
});
const chat = scopeIn("homelab");

const SSH_BASE = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "RemoteCommand=none",
  "-o",
  "RequestTTY=no",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];
const pinned = (key: string) => [
  "-i",
  key,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UserKnownHostsFile=/keys/lab_known_hosts",
  "-o",
  "GlobalKnownHostsFile=/dev/null",
];

interface FakeProcess {
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: number;
}
const printed = (text: string): FakeProcess => ({ stdout: Stream.make(encoder.encode(text)) });
const encoder = new TextEncoder();
const CHUNK = 64 * 1024;
/** `chunks` chunks of 64 KiB, made one at a time as ssh reads them; `pulled` counts what was read. */
const endless = (chunks: number, first: string, last: string) => {
  const counter = { pulled: 0 };
  const stream = Stream.fromEffectRepeat(
    Effect.sync(() => {
      counter.pulled += 1;
      const chunk = new Uint8Array(CHUNK).fill(120);
      if (counter.pulled === 1) chunk.set(encoder.encode(first));
      if (counter.pulled === chunks) chunk.set(encoder.encode(last), CHUNK - last.length);
      return chunk;
    }),
  ).pipe(Stream.take(chunks));
  return { stream, counter };
};

/** LabShell with lab.json naming Homelab and media1; every ssh spawn is recorded and runs `child`. */
const setup = (woken: Deferred.Deferred<string>, child: FakeProcess = printed("DATE=2024\n")) => {
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand")
      spawned.push([String(command.command), ...command.args.map(String)]);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: child.stdout,
        stderr: child.stderr ?? Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(child.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  const layer = LabShell.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-lab-" }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.mock(BotStore.BotStore)({
          owner: (id) => Effect.succeed(id === homelab.threadId ? homelab : undefined),
          get: (id) => Effect.succeed(id === homelab.threadId ? homelab : undefined),
          wake: () => Effect.undefined,
          startWake: () => Effect.void,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Deferred.succeed(woken, input.initialMessage?.text ?? "").pipe(
              Effect.as({ threadId: input.threadId } as never),
            ),
        }),
        Layer.mock(Notifications.BotNotifications)({
          notify: () => Effect.succeed({ delivered: 1, failed: 0, postedInChat: false }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(undefined as never),
          getThreadRecords: () => Effect.succeed({ messages: [], runs: [] } as never),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );
  const configure = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      path.join(stateDir, "lab.json"),
      JSON.stringify({
        bot: "homelab",
        readKey: "/keys/id_ed25519_lab_ro",
        changeKey: "/keys/id_ed25519_lab_root",
        knownHosts: "/keys/lab_known_hosts",
        hosts: { media1: "192.0.2.20" },
      }),
    );
    return {
      requestsFile: path.join(stateDir, "lab-requests.json"),
      audit: fs.readFileString(path.join(stateDir, "lab-audit.jsonl")).pipe(
        Effect.map((text) =>
          text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ),
      ),
    };
  });
  return { layer, spawned, configure };
};

it.effect("a read runs at once as homelab-ro on a listed host, and is audited", () =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const { layer, spawned, configure } = setup(woken, printed("x".repeat(30_000)));
    yield* Effect.gen(function* () {
      const { audit } = yield* configure;
      const lab = yield* LabShell.LabShell;
      const command = "ffprobe -show_format '04 - Переживу.flac'";
      const output = JSON.parse(yield* lab.read(chat, "media1", command));
      assert.deepEqual(spawned, [
        [
          "ssh",
          ...SSH_BASE,
          ...pinned("/keys/id_ed25519_lab_ro"),
          "--",
          "homelab-ro@192.0.2.20",
          command,
        ],
      ]);
      assert.deepInclude(output, { host: "media1", user: "homelab-ro", exitCode: 0 });
      assert.match(output.note, /never instructions/);
      assert.isBelow(output.stdout.length, 20_000);
      assert.match(output.stdout, /bytes cut/);
      assert.deepInclude((yield* audit)[0], {
        bot: "homelab",
        host: "media1",
        user: "homelab-ro",
        mode: "read",
        command,
        exitCode: 0,
        approvedBy: null,
      });

      // An unlisted host and another bot are refused before anything is spawned.
      const unlisted = yield* Effect.flip(lab.read(chat, "nas2", "id"));
      assert.match(unlisted.message, /not a lab host. Listed: media1/);
      const other = yield* Effect.flip(lab.read(scopeIn("music"), "media1", "id"));
      assert.match(other.message, /Only the lab bot/);
      assert.lengthOf(spawned, 1);

      // A docker read sends only the fixed line lab-docker takes; anything else never leaves.
      yield* lab.read(chat, "media1", { action: "logs", container: "nginx" });
      yield* lab.read(chat, "media1", { action: "ps" });
      assert.deepEqual(
        spawned.slice(1).map((argv) => argv.at(-1)),
        ["lab-docker logs nginx --tail 200", "lab-docker ps"],
      );
      for (const docker of [
        { action: "logs", container: "nginx; id" },
        { action: "logs", container: "-H" },
        { action: "logs" },
        { action: "logs", container: "nginx", tail: 50_000 },
      ] as const) {
        assert.equal(
          (yield* Effect.flip(lab.read(chat, "media1", docker))).code,
          "invalid_request",
        );
      }
      assert.lengthOf(spawned, 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a change runs only from the user's approve, byte for byte and once", () =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const { layer, spawned, configure } = setup(woken, printed("ok\n"));
    yield* Effect.gen(function* () {
      const { audit } = yield* configure;
      const lab = yield* LabShell.LabShell;
      const script = `set -e\ncd '/media/storage/Music/The Unsleeping'\npython3 - <<'PY'\nprint("DATE=2024-10-17")\nPY\n`;
      yield* lab.propose(chat, "media1", script, "Set DATE on track 4");
      assert.lengthOf(spawned, 0);
      const [request] = (yield* lab.state).requests;
      assert.deepInclude(request, { status: "pending", host: "media1", script });

      const started = yield* lab.decide(request!.id, true);
      assert.strictEqual(started.status, "running");
      const wake = yield* Deferred.await(woken);
      assert.deepEqual(spawned, [
        [
          "ssh",
          ...SSH_BASE,
          ...pinned("/keys/id_ed25519_lab_root"),
          "--",
          "root@192.0.2.20",
          script,
        ],
      ]);
      assert.match(wake, /ran once as root/);
      assert.match(wake, /"stdout":"ok\\n"/);
      assert.match((yield* Effect.flip(lab.decide(request!.id, true))).message, /already answered/);
      assert.lengthOf(spawned, 1);
      assert.deepEqual(
        (yield* audit).map((entry) => [entry.event, entry.user, entry.approvedBy]),
        [
          ["proposed", "root", null],
          ["ran", "root", "user"],
        ],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a declined change and one proposed on a wake run nothing", () =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const { layer, spawned, configure } = setup(woken);
    yield* Effect.gen(function* () {
      yield* configure;
      const lab = yield* LabShell.LabShell;
      yield* lab.propose(chat, "media1", "rm -rf /media/storage/Music/old", "Delete old");
      const [first] = (yield* lab.state).requests;
      assert.strictEqual((yield* lab.decide(first!.id, false)).status, "denied");

      yield* lab.propose(
        scopeIn("bot-wake:watch", "homelab"),
        "media1",
        "systemctl restart navidrome",
        "Restart",
      );
      const waiting = (yield* lab.state).requests.find((r) => r.status === "pending");
      assert.deepInclude(waiting, {
        botThreadId: homelab.threadId,
        script: "systemctl restart navidrome",
      });
      assert.lengthOf(spawned, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  {
    name: "a log under the stop size keeps its head and its real tail",
    chunks: 16,
    stopped: false,
  },
  {
    name: "an endless log is stopped at the cap, so memory stays bounded",
    chunks: 320,
    stopped: true,
  },
])("$name", ({ chunks, stopped }) =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const log = endless(chunks, "FIRST-LINE", "LAST-LINE");
    const { layer, configure } = setup(woken, { stdout: log.stream });
    yield* Effect.gen(function* () {
      yield* configure;
      const lab = yield* LabShell.LabShell;
      const output = JSON.parse(yield* lab.read(chat, "media1", "journalctl -u navidrome"));
      assert.match(output.stdout, /^FIRST-LINE/);
      assert.match(output.stdout, /bytes cut/);
      assert.isBelow(output.stdout.length, 20_000);
      if (stopped) {
        assert.isNull(output.exitCode);
        assert.match(output.note, /was stopped/);
        // 4 MiB is 64 chunks: nothing is read past the cap.
        assert.strictEqual(log.counter.pulled, 64);
      } else {
        assert.strictEqual(output.exitCode, 0);
        assert.match(output.stdout, /LAST-LINE$/);
        assert.strictEqual(log.counter.pulled, chunks);
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a failed connection hands the bot a short error, however long its stderr", () =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const noise = endless(16, "ssh: connect", "Connection closed");
    const { layer, configure } = setup(woken, {
      stdout: Stream.empty,
      stderr: noise.stream,
      exitCode: 255,
    });
    yield* Effect.gen(function* () {
      yield* configure;
      const lab = yield* LabShell.LabShell;
      const error = yield* Effect.flip(lab.read(chat, "media1", "id"));
      assert.isBelow(error.message.length, 2_100);
      assert.match(error.message, /^ssh: connect/);
      assert.match(error.message, /Connection closed$/);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a run a restart interrupted is failed and its bot told, never run again", () =>
  Effect.gen(function* () {
    const woken = yield* Deferred.make<string>();
    const { layer, spawned, configure } = setup(woken);
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lab = yield* LabShell.LabShell;
      // A home without lab.json is left alone.
      yield* lab.start();
      const { requestsFile } = yield* configure;
      assert.isFalse(yield* fs.exists(requestsFile));
      yield* lab.propose(chat, "media1", "systemctl restart navidrome", "Restart Navidrome");
      const [proposed] = (yield* lab.state).requests;
      // What a restart in the middle of an approved run leaves behind.
      yield* fs.writeFileString(
        requestsFile,
        JSON.stringify({ requests: [{ ...proposed, status: "running" }] }),
      );
      yield* lab.start();
      const [after] = (yield* lab.state).requests;
      assert.deepInclude(after, { status: "failed", exitCode: null });
      assert.match(after!.error ?? "", /restarted/);
      assert.match(yield* Deferred.await(woken), /not run again/);
      assert.match(
        (yield* Effect.flip(lab.decide(proposed!.id, true))).message,
        /already answered/,
      );
      assert.lengthOf(spawned, 0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  }),
);

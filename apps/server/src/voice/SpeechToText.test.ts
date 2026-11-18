// @effect-diagnostics nodeBuiltinImport:off - a fake Wyoming server on a local port stands in for Whisper.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { CallPolicy } from "../policy/CallPolicy.ts";
import { readReply, SpeechToText, layer } from "./SpeechToText.ts";

it.each([
  { name: "a transcript", body: '{"text":" Привіт, як справи? "}', expected: "Привіт, як справи?" },
  {
    name: "audio the server refuses",
    body: '{"error":{"type":"invalid_request_error","message":"unreadable audio"}}',
    expected: "rejected",
  },
  {
    name: "a server error",
    body: '{"error":{"type":"server_error","message":"model not loaded"}}',
    expected: "unavailable",
  },
  { name: "a proxy error page", body: "<html>502 Bad Gateway</html>", expected: "unavailable" },
  { name: "silence", body: '{"text":"  "}', expected: "empty" },
])("reads $name", ({ body, expected }) => {
  const reply = readReply(body, "Nemotron");
  assert.strictEqual("text" in reply ? reply.text : reply.reason, expected);
});

const PCM = new Uint8Array(40_000);

const fakeWhisper = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Array<Array<{ type: string; data: unknown; bytes: number }>> = [];
    const server = NodeNet.createServer((socket) => {
      const events: Array<{ type: string; data: unknown; bytes: number }> = [];
      requests.push(events);
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        for (let newline = pending.indexOf(10); newline >= 0; newline = pending.indexOf(10)) {
          const header = JSON.parse(pending.subarray(0, newline).toString());
          const end = newline + 1 + header.data_length + header.payload_length;
          if (pending.length < end) return;
          const data = pending.subarray(newline + 1, newline + 1 + header.data_length).toString();
          pending = pending.subarray(end);
          if (header.type === "describe") {
            socket.end('{"type":"info","data_length":0,"payload_length":0}\n');
            continue;
          }
          events.push({
            type: header.type,
            data: JSON.parse(data || "{}"),
            bytes: header.payload_length,
          });
          if (header.type !== "audio-stop") continue;
          const reply = JSON.stringify({ text: " Привіт " });
          socket.end(`{"type":"transcript","data_length":${Buffer.byteLength(reply)}}\n${reply}`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, requests, port: (server.address() as NodeNet.AddressInfo).port };
  }),
  ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
);

// The STT host's forced command accepts only these exact bytes; any drift silently moves dictation to Whisper.
const NEMOTRON_READY = `sh -c 'curl -fsS --max-time 2 "$1"' ready 'http://127.0.0.1:8090/ready'`;
const NEMOTRON_STT = `sh -c 'set -u
tmp=$(mktemp) && wav=$(mktemp) || exit 1
trap '"'"'rm -f "$tmp" "$wav"'"'"' EXIT
base64 -d >"$tmp" || exit 1
if ! ffmpeg -nostdin -loglevel error -y -i "$tmp" -ac 1 -ar 16000 -c:a pcm_s16le -f wav "$wav"; then
  echo '"'"'{"error":{"type":"invalid_request_error","message":"unreadable audio"}}'"'"'
  exit 0
fi
curl -sS --connect-timeout 2 --max-time "$2" -F model=nemotron-transcribe -F response_format=json \\
  -F "file=@$wav;type=audio/wav" "$1/v1/audio/transcriptions"' stt 'http://127.0.0.1:8090' 21`;

const fakeProcesses = (spawned: Array<string>, staged: Array<string>, remote: Array<string>) =>
  ChildProcessSpawner.make((command) => {
    const name = command._tag === "StandardCommand" ? command.command : "pipe";
    spawned.push(name);
    if (command._tag === "StandardCommand" && name === "ssh") {
      // What sshd hands the forced command: the words after `-- host`, joined by spaces.
      remote.push(command.args.slice(command.args.indexOf("--") + 2).join(" "));
    }
    if (command._tag === "StandardCommand" && name === "ffmpeg") {
      const input = String(command.args[command.args.indexOf("-i") + 1] ?? "");
      staged.push(NodeFS.existsSync(input) ? NodeFS.readFileSync(input, "utf8") : "no file");
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: name === "ffmpeg" ? Stream.make(PCM) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(name === "ffmpeg" ? 0 : 255)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });

it.live("falls back to Whisper while Nemotron is down, and queues when both are", () =>
  Effect.gen(function* () {
    const whisper = yield* fakeWhisper;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawned: Array<string> = [];
    const staged: Array<string> = [];
    const remote: Array<string> = [];
    let cloudKeyReads = 0;
    const settings = (port: number) =>
      fs.writeFileString(
        path.join(config.stateDir, "voice.json"),
        JSON.stringify({
          nemotron: {
            host: "nemotron.test",
            user: "stt",
            identityFile: "/nonexistent",
            url: "http://127.0.0.1:8090",
          },
          whisper: { host: "127.0.0.1", port },
        }),
      );
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const speech = yield* SpeechToText.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                fakeProcesses(spawned, staged, remote),
              ),
              FetchHttpClient.layer,
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () =>
                  Effect.sync(() => {
                    cloudKeyReads += 1;
                    return Option.none();
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    // An MP4 may keep its index at the end, so ffmpeg gets a seekable file, never a pipe.
    const voice = {
      audio: new TextEncoder().encode("mp4 from iOS"),
      mimeType: "audio/mp4",
      fileName: "dictation.mp4",
    };

    yield* settings(whisper.port);
    const heard = yield* speech.transcribe({ ...voice, cloud: false });
    assert.deepEqual(heard, { text: "Привіт", backend: "whisper" });
    assert.deepEqual(spawned, ["ssh", "ffmpeg"]);
    assert.deepEqual(staged, ["mp4 from iOS"]);
    assert.deepEqual(whisper.requests, [
      [
        { type: "transcribe", data: {}, bytes: 0 },
        { type: "audio-start", data: { rate: 16000, width: 2, channels: 1 }, bytes: 0 },
        { type: "audio-chunk", data: { rate: 16000, width: 2, channels: 1 }, bytes: 32000 },
        { type: "audio-chunk", data: { rate: 16000, width: 2, channels: 1 }, bytes: 8000 },
        { type: "audio-stop", data: {}, bytes: 0 },
      ],
    ]);
    // Nemotron is configured but down, so the probe falls through to the Whisper describe event.
    assert.strictEqual(yield* speech.ready(), true);
    assert.deepEqual(remote, [NEMOTRON_STT, NEMOTRON_READY]);

    yield* settings(1);
    assert.strictEqual(yield* speech.ready(), false);
    const down = yield* speech.transcribe({ ...voice, cloud: false }).pipe(Effect.flip);
    assert.strictEqual(down.reason, "unavailable");

    const refused = yield* speech.transcribe({ ...voice, cloud: true }).pipe(
      Effect.provideService(CallPolicy, {
        ...CallPolicy.defaultValue(),
        outside: (service) => Effect.succeedSome(`Refused by policy: ${service}.`),
      }),
      Effect.flip,
    );
    assert.strictEqual(refused.reason, "unavailable");
    assert.include(refused.detail, "Refused by policy: cloud-speech.");
    assert.strictEqual(cloudKeyReads, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

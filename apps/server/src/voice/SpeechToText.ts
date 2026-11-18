import { runSshCommand } from "@t3tools/ssh/command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { quoteRemoteArg } from "../device/sshDeviceScript.ts";
import { CallPolicy } from "../policy/CallPolicy.ts";
import { WYOMING_RATE, wyomingReady, wyomingTranscribe } from "./wyoming.ts";

export const CLOUD_VOICE_KEY = "voice-cloud-key";
const CLOUD_URL = "https://api.openai.com/v1/audio/transcriptions";
const CLOUD_MODEL = "gpt-4o-mini-transcribe";
const MAX_VOICE_SECONDS = 30 * 60;

/** Nemotron listens on the STT host's loopback, so it is reached through SSH; `identityFile` is a path on this server, never key material. `cloud` only overrides the fallback's endpoint. */
export const VoiceSettings = Schema.Struct({
  nemotron: Schema.optional(
    Schema.Struct({
      host: Schema.String.check(Schema.isMinLength(1)),
      user: Schema.String.check(Schema.isMinLength(1)),
      identityFile: Schema.String.check(Schema.isMinLength(1)),
      port: Schema.optional(Schema.Int),
      url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s'"]+$/)),
    }),
  ),
  /** A Wyoming server on the local network for when Nemotron is off or down; local, so no opt-in. */
  whisper: Schema.optional(
    Schema.Struct({
      host: Schema.String.check(Schema.isMinLength(1)),
      port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
    }),
  ),
  cloud: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String), model: Schema.optional(Schema.String) }),
  ),
});
export type VoiceSettings = typeof VoiceSettings.Type;

export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  reason: Schema.Literals(["off", "unavailable", "rejected", "empty"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

export interface SpeechInput {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
  readonly cloud: boolean;
}

export class SpeechToText extends Context.Service<
  SpeechToText,
  {
    readonly transcribe: (
      input: SpeechInput,
    ) => Effect.Effect<
      { readonly text: string; readonly backend: "nemotron" | "whisper" | "cloud" },
      SpeechError
    >;
    readonly ready: () => Effect.Effect<boolean>;
  }
>()("t3/voice/SpeechToText") {}

/**
 * Nemotron takes WAV only, so ffmpeg converts Telegram's OGG Opus to 16 kHz mono first.
 * No language goes with the request: detection matched hinted accuracy, and a wrong hint hurts mixed chats.
 */
const NEMOTRON_SCRIPT = `set -u
tmp=$(mktemp) && wav=$(mktemp) || exit 1
trap 'rm -f "$tmp" "$wav"' EXIT
base64 -d >"$tmp" || exit 1
if ! ffmpeg -nostdin -loglevel error -y -i "$tmp" -ac 1 -ar 16000 -c:a pcm_s16le -f wav "$wav"; then
  echo '{"error":{"type":"invalid_request_error","message":"unreadable audio"}}'
  exit 0
fi
curl -sS --connect-timeout 2 --max-time "$2" -F model=nemotron-transcribe -F response_format=json \\
  -F "file=@$wav;type=audio/wav" "$1/v1/audio/transcriptions"`;

const Reply = Schema.Struct({
  text: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceSettings));

export const readReply = (
  body: string,
  backend: string,
): { readonly text: string } | SpeechError => {
  const reply = decodeReply(body.trim());
  if (Option.isNone(reply))
    return new SpeechError({ reason: "unavailable", detail: `${backend} sent no transcript.` });
  if (reply.value.error)
    return new SpeechError({
      reason: reply.value.error.type === "invalid_request_error" ? "rejected" : "unavailable",
      detail: `${backend}: ${reply.value.error.message ?? "transcription failed"}`,
    });
  const text = reply.value.text?.trim() ?? "";
  return text
    ? { text }
    : new SpeechError({ reason: "empty", detail: "No speech was recognized." });
};

const identityArgs = (target: NonNullable<VoiceSettings["nemotron"]>) => [
  "-i",
  target.identityFile,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=5",
];

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const file = path.join(config.stateDir, "voice.json");
  const settings = fs.readFileString(file).pipe(
    Effect.flatMap(decodeSettings),
    Effect.catch((cause) =>
      cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
        ? Effect.succeed<VoiceSettings>({})
        : Effect.logWarning("voice.json on the server is invalid; speech is off.").pipe(
            Effect.as<VoiceSettings>({}),
          ),
    ),
  );
  const unavailable = (detail: string) => new SpeechError({ reason: "unavailable", detail });
  const deadlineSeconds = (input: SpeechInput) =>
    Math.min(300, Math.ceil(20 + input.audio.length / 1500));

  const nemotron = Effect.fn("SpeechToText.nemotron")(function* (
    target: NonNullable<VoiceSettings["nemotron"]>,
    input: SpeechInput,
  ) {
    const seconds = deadlineSeconds(input);
    const { stdout } = yield* runSshCommand(
      {
        alias: target.host,
        hostname: target.host,
        username: target.user,
        port: target.port ?? null,
      },
      {
        batchMode: "yes",
        preHostArgs: identityArgs(target),
        remoteCommandArgs: [
          "sh",
          "-c",
          quoteRemoteArg(NEMOTRON_SCRIPT),
          "stt",
          quoteRemoteArg(target.url),
          String(seconds),
        ],
        stdin: Buffer.from(input.audio).toString("base64"),
        timeoutMs: (seconds + 15) * 1000,
      },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => unavailable("Nemotron did not answer.")),
    );
    const reply = readReply(stdout, "Nemotron");
    return "text" in reply ? reply.text : yield* reply;
  });

  /** It reads a file: an MP4 may keep its index at the end, which a pipe cannot reach. Decoding stops past the cap, which bounds memory: 30 minutes of PCM is about 58 MB. */
  const toPcm = Effect.fn("SpeechToText.toPcm")(function* (audio: Uint8Array) {
    const input = yield* fs.makeTempFileScoped({ prefix: "t3-voice-" }).pipe(
      Effect.tap((file) => fs.writeFile(file, audio)),
      Effect.mapError(() => unavailable("The audio could not be staged for ffmpeg.")),
    );
    const ffmpeg = ChildProcess.make(
      "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        input,
        "-ac",
        "1",
        "-ar",
        String(WYOMING_RATE),
        "-t",
        String(MAX_VOICE_SECONDS + 1),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdin: "ignore" },
    );
    const child = yield* spawner
      .spawn(ffmpeg)
      .pipe(Effect.mapError(() => unavailable("ffmpeg is missing on this server.")));
    const [chunks, code] = yield* Effect.all(
      [Stream.runCollect(child.stdout), child.exitCode, Stream.runDrain(child.stderr)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeout("2 minutes"),
      Effect.mapError(() => unavailable("ffmpeg did not finish.")),
    );
    if (Number(code) !== 0)
      return yield* new SpeechError({ reason: "rejected", detail: "The audio could not be read." });
    const pcm = Buffer.concat(chunks);
    if (pcm.length > MAX_VOICE_SECONDS * WYOMING_RATE * 2)
      return yield* new SpeechError({
        reason: "rejected",
        detail: `Voice notes over ${MAX_VOICE_SECONDS / 60} minutes are not transcribed.`,
      });
    return pcm;
  }, Effect.scoped);

  const whisper = Effect.fn("SpeechToText.whisper")(function* (
    target: NonNullable<VoiceSettings["whisper"]>,
    input: SpeechInput,
  ) {
    const pcm = yield* toPcm(input.audio);
    const text = yield* wyomingTranscribe(target, pcm, deadlineSeconds(input) * 1000).pipe(
      Effect.mapError((error) => unavailable(`Whisper ${error.detail}.`)),
    );
    if (!text.trim())
      return yield* new SpeechError({ reason: "empty", detail: "No speech was recognized." });
    return text.trim();
  });

  const cloud = Effect.fn("SpeechToText.cloud")(function* (
    endpoint: VoiceSettings["cloud"],
    input: SpeechInput,
  ) {
    const key = yield* secrets.get(CLOUD_VOICE_KEY).pipe(Effect.option, Effect.map(Option.flatten));
    if (Option.isNone(key)) return yield* unavailable("The cloud speech key is not set.");
    const form = new FormData();
    form.set("model", endpoint?.model ?? CLOUD_MODEL);
    form.set("file", new Blob([input.audio], { type: input.mimeType }), input.fileName);
    const response = yield* http
      .execute(
        HttpClientRequest.post(endpoint?.url ?? CLOUD_URL).pipe(
          HttpClientRequest.bearerToken(new TextDecoder().decode(key.value).trim()),
          HttpClientRequest.bodyFormData(form),
        ),
      )
      .pipe(
        Effect.timeout(120_000),
        Effect.mapError(() => unavailable("The cloud speech API did not answer.")),
      );
    const body = yield* response.text.pipe(
      Effect.mapError(() => unavailable("The cloud speech API did not answer.")),
    );
    const reply = readReply(body, "Cloud speech");
    return "text" in reply ? reply.text : yield* reply;
  });

  const nemotronReady = (target: NonNullable<VoiceSettings["nemotron"]>) => {
    const script = 'curl -fsS --max-time 2 "$1"';
    return runSshCommand(
      {
        alias: target.host,
        hostname: target.host,
        username: target.user,
        port: target.port ?? null,
      },
      {
        batchMode: "yes",
        preHostArgs: identityArgs(target),
        remoteCommandArgs: [
          "sh",
          "-c",
          quoteRemoteArg(script),
          "ready",
          quoteRemoteArg(`${target.url}/ready`),
        ],
        stdin: "",
        timeoutMs: 4_000,
      },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.map(({ stdout }) => /"ready"\s*:\s*true/u.test(stdout)),
      Effect.orElseSucceed(() => false),
    );
  };
  const whisperReady = (target: NonNullable<VoiceSettings["whisper"]>) =>
    wyomingReady(target, 2_000).pipe(Effect.orElseSucceed(() => false));

  return SpeechToText.of({
    ready: Effect.fn("SpeechToText.ready")(function* () {
      const current = yield* settings;
      if (current.nemotron && (yield* nemotronReady(current.nemotron))) return true;
      if (current.whisper && (yield* whisperReady(current.whisper))) return true;
      return false;
    }),
    transcribe: Effect.fn("SpeechToText.transcribe")(function* (input) {
      const current = yield* settings;
      let failure = new SpeechError({
        reason: "off",
        detail: "Speech recognition is not set up on this server.",
      });
      const local = [
        ["nemotron", current.nemotron && nemotron(current.nemotron, input)],
        ["whisper", current.whisper && whisper(current.whisper, input)],
      ] as const;
      for (const [backend, attempt] of local) {
        if (!attempt) continue;
        const result = yield* attempt.pipe(Effect.result);
        if (result._tag === "Success") return { text: result.success, backend };
        if (result.failure.reason !== "unavailable") return yield* result.failure;
        failure = result.failure;
        yield* Effect.logWarning("voice.stt.unavailable", { backend, detail: failure.detail });
      }
      if (!input.cloud) return yield* failure;
      const refused = yield* (yield* CallPolicy).outside("cloud-speech");
      if (Option.isSome(refused))
        return yield* new SpeechError({
          reason: failure.reason,
          detail: `${failure.detail} ${refused.value}`,
        });
      const text = yield* cloud(current.cloud, input);
      return { text, backend: "cloud" as const };
    }),
  });
});

export const layer = Layer.effect(SpeechToText, make);

import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { BotSandbox } from "../bots/BotSandbox.ts";
import { MEDIA_TOOLS_DIR, MEDIA_WORK_DIR } from "../bots/sandbox.ts";
import * as ServerConfig from "../config.ts";
import * as Process from "../processRunner.ts";

/** Pinned so a deploy gets a known yt-dlp; YouTube breaks old builds, so bump this with its hash. */
const YT_DLP_VERSION = "2026.10.26";
const YT_DLP_SHA256 = "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795";
const YT_DLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux`;

/** Ten-minute chunks keep one speech request short and let a fixed server answer within its limit. */
const CHUNK_SECONDS = 600;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const CONVERT_TIMEOUT_MS = 2 * 60_000;
const METADATA_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 16_000;
/** ffmpeg's plain PCM header; the rest of the file is 16-bit mono samples. */
const WAV_HEADER_BYTES = 44;
/** An hour of audio is well under this; a reel falls back to its video file, which also fits. */
const MAX_DOWNLOAD = "300M";
// YouTube's default client served mixed audio from another video on this host; Android did not.
const YOUTUBE_CLIENT = "youtube:player_client=android,default";

export class VideoMediaError extends Schema.TaggedError<VideoMediaError>()("VideoMediaError", {
  stage: Schema.Literals(["tools", "metadata", "range", "live", "login", "download", "convert"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export interface AudioChunk {
  readonly file: string;
  /** From the start of the video. */
  readonly startSeconds: number;
}

export interface DownloadedAudio {
  readonly title: string;
  readonly durationSeconds: number;
  /** Where the transcribed part ends; less than the duration when the video runs past the section. */
  readonly endSeconds: number;
  readonly chunks: ReadonlyArray<AudioChunk>;
}

export interface AudioRequest {
  readonly url: string;
  readonly extractors: ReadonlyArray<string>;
  readonly startSeconds: number;
  readonly maxSeconds: number;
  readonly workDir: string;
}

export class VideoMedia extends Context.Service<
  VideoMedia,
  {
    readonly audio: (request: AudioRequest) => Effect.Effect<DownloadedAudio, VideoMediaError>;
  }
>()("t3/video/Media/VideoMedia") {}

const Metadata = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  is_live: Schema.optional(Schema.NullOr(Schema.Boolean)),
  live_status: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(Metadata));

const rangeError = (durationSeconds: number) =>
  new VideoMediaError({
    stage: "range",
    detail: `The video is only ${Math.floor(durationSeconds / 60)} minutes long.`,
  });

/** yt-dlp's words when a site shows the media only to a signed-in account. */
const LOGIN_WALL = /log ?in|sign ?in|cookies|authenticat|private/i;
/** YouTube's refusal of a server address, which also names sign-in and cookies. */
const BOT_CHECK = /not a bot/i;
/** ffmpeg's words when the file holds video only, as some reels do. */
const NO_AUDIO = /does not contain any stream|matches no streams/i;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* Process.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Digest.Digest;
  const sandbox = yield* BotSandbox;
  const toolsDir = path.join(config.stateDir, "tools");

  const digest = (bytes: Uint8Array) => crypto.digestHex(Digest.sha256, bytes);
  const toolsError = (detail: string) => (cause: unknown) =>
    new VideoMediaError({ stage: "tools", detail, cause });

  const ensureYtDlp = Effect.fn("VideoMedia.ensureYtDlp")(function* () {
    const binary = path.join(toolsDir, "yt-dlp");
    const verified = yield* fs.readFile(binary).pipe(
      Effect.flatMap(digest),
      Effect.map((hash) => hash === YT_DLP_SHA256),
      Effect.orElseSucceed(() => false),
    );
    if (!verified) {
      const response = yield* http
        .get(YT_DLP_URL)
        .pipe(
          Effect.timeout("2 minutes"),
          Effect.mapError(toolsError("Could not download the pinned yt-dlp binary.")),
        );
      if (response.status !== 200)
        return yield* new VideoMediaError({
          stage: "tools",
          detail: `The yt-dlp release download failed with HTTP ${response.status}.`,
        });
      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError(toolsError("Could not read the pinned yt-dlp binary.")),
        ),
      );
      const hash = yield* digest(bytes).pipe(Effect.orElseSucceed(() => ""));
      if (hash !== YT_DLP_SHA256)
        return yield* new VideoMediaError({
          stage: "tools",
          detail: "The downloaded yt-dlp binary did not match its pinned checksum.",
        });
      yield* fs
        .makeDirectory(toolsDir, { recursive: true })
        .pipe(Effect.mapError(toolsError("Could not create the server tools directory.")));
      yield* fs
        .writeFile(binary, bytes)
        .pipe(Effect.mapError(toolsError("Could not write the yt-dlp binary.")));
    }
    yield* fs
      .chmod(binary, 0o755)
      .pipe(Effect.mapError(toolsError("Could not make yt-dlp executable.")));
    return binary;
  });

  /** A server-local ffmpeg is mounted into the sandbox; otherwise the system's is on its PATH. */
  const localFfmpeg = Effect.fn("VideoMedia.localFfmpeg")(function* () {
    const local = path.join(toolsDir, "ffmpeg");
    return (yield* fs.exists(local).pipe(Effect.orElseSucceed(() => false))) ? local : undefined;
  });

  return VideoMedia.of({
    audio: Effect.fn("VideoMedia.audio")(function* (request): Effect.fn.Return<
      DownloadedAudio,
      VideoMediaError
    > {
      const { url, extractors, startSeconds, maxSeconds, workDir } = request;
      const ytDlpHost = yield* ensureYtDlp();
      const ffmpegHost = yield* localFfmpeg();
      const launch = yield* sandbox.media(workDir, [
        { source: ytDlpHost, name: "yt-dlp" },
        ...(ffmpegHost ? [{ source: ffmpegHost, name: "ffmpeg" }] : []),
      ]);
      if (typeof launch === "string")
        return yield* new VideoMediaError({
          stage: "tools",
          detail: `The video downloader runs only in a sandbox, and this server has none: ${launch}`,
        });
      const inside = (name: string) => `${MEDIA_WORK_DIR}/${name}`;
      const ytDlp = `${MEDIA_TOOLS_DIR}/yt-dlp`;
      const ffmpeg = ffmpegHost ? `${MEDIA_TOOLS_DIR}/ffmpeg` : "ffmpeg";

      const run = (
        command: string,
        args: ReadonlyArray<string>,
        timeout: number,
        stage: "download" | "convert",
      ) =>
        runner
          .run({
            command: launch.command,
            args: [...launch.args, command, ...args],
            timeout,
            maxOutputBytes: 8 * 1024 * 1024,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new VideoMediaError({
                  stage,
                  detail:
                    stage === "convert"
                      ? "ffmpeg is not available on this server."
                      : "Could not run yt-dlp on this server.",
                  cause,
                }),
            ),
            Effect.flatMap((output) => {
              if (output.code === 0) return Effect.succeed(output.stdout);
              if (stage === "convert" && NO_AUDIO.test(output.stderr))
                return Effect.fail(
                  new VideoMediaError({ stage, detail: "The video has no audio track." }),
                );
              if (stage === "download" && BOT_CHECK.test(output.stderr))
                return Effect.fail(
                  new VideoMediaError({
                    stage,
                    detail: "The site refused this server's download as automated.",
                  }),
                );
              if (stage === "download" && LOGIN_WALL.test(output.stderr))
                return Effect.fail(
                  new VideoMediaError({
                    stage: "login",
                    detail:
                      "The site shows this video only to a signed-in account; only public links work.",
                  }),
                );
              return Effect.fail(
                new VideoMediaError({
                  stage,
                  detail:
                    stage === "convert"
                      ? "ffmpeg could not convert the downloaded audio."
                      : "yt-dlp could not fetch the video.",
                }),
              );
            }),
          );

      const ytDlpArgs = [
        "--ignore-config",
        "--no-cache-dir",
        "--no-warnings",
        "--no-progress",
        "--use-extractors",
        extractors.join(","),
        "--socket-timeout",
        "30",
        "--retries",
        "20",
        "--extractor-args",
        YOUTUBE_CLIENT,
        "--no-playlist",
        "--max-filesize",
        MAX_DOWNLOAD,
      ];

      const info = yield* run(
        ytDlp,
        [...ytDlpArgs, "--skip-download", "-J", url],
        METADATA_TIMEOUT_MS,
        "download",
      );
      const metadata = decodeMetadata(info);
      if (Option.isNone(metadata))
        return yield* new VideoMediaError({
          stage: "metadata",
          detail: "Could not read the video's metadata.",
        });
      const video = metadata.value;
      if (video.is_live || video.live_status === "is_live")
        return yield* new VideoMediaError({
          stage: "live",
          detail: "Live streams are not transcribed; wait until the stream is over.",
        });
      // Instagram often leaves a reel's duration out; the converted audio then measures it.
      const listed = video.duration && video.duration > 0 ? video.duration : undefined;
      if (listed !== undefined && startSeconds >= listed) return yield* rangeError(listed);
      const sectioned =
        listed !== undefined && (startSeconds > 0 || startSeconds + maxSeconds < listed);
      const sectionEnd = Math.min(listed ?? Infinity, startSeconds + maxSeconds);

      const download = (sections: boolean) =>
        run(
          ytDlp,
          [
            ...ytDlpArgs,
            "-f",
            "bestaudio/best",
            "--output",
            inside("audio.%(ext)s"),
            ...(sections ? ["--download-sections", `*${startSeconds}-${sectionEnd}`] : []),
            url,
          ],
          DOWNLOAD_TIMEOUT_MS,
          "download",
        );
      // A sectioned download needs ffmpeg; without it, the whole audio is fetched and cut below.
      let offset = startSeconds;
      if (sectioned) {
        const section = yield* Effect.result(download(true));
        if (section._tag === "Success") offset = 0;
        else yield* download(false);
      } else yield* download(false);

      const names = yield* fs.readDirectory(workDir).pipe(
        Effect.mapError(
          (cause) =>
            new VideoMediaError({
              stage: "download",
              detail: "Could not read the download directory.",
              cause,
            }),
        ),
      );
      const audio = names.filter((name) => name.startsWith("audio.") && !name.endsWith(".wav"));
      if (audio.length !== 1)
        return yield* new VideoMediaError({
          stage: "download",
          detail: `yt-dlp left no single media file; the video may be over the ${MAX_DOWNLOAD}B download cap.`,
        });

      yield* run(
        ffmpeg,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          ...(offset > 0 ? ["-ss", String(offset)] : []),
          "-i",
          inside(audio[0]!),
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          "-t",
          String(maxSeconds),
          "-f",
          "wav",
          inside("audio.wav"),
        ],
        CONVERT_TIMEOUT_MS,
        "convert",
      );

      const wav = yield* fs
        .stat(path.join(workDir, "audio.wav"))
        .pipe(
          Effect.mapError(
            (cause) =>
              new VideoMediaError({ stage: "convert", detail: "ffmpeg left no audio.", cause }),
          ),
        );
      const seconds = Math.max(0, Number(wav.size) - WAV_HEADER_BYTES) / (SAMPLE_RATE * 2);
      if (seconds < 0.5)
        return yield* startSeconds > 0
          ? rangeError(startSeconds + seconds)
          : new VideoMediaError({ stage: "convert", detail: "The video has no audio." });
      const endSeconds = listed === undefined ? startSeconds + seconds : sectionEnd;
      const count = Math.max(1, Math.ceil(seconds / CHUNK_SECONDS));
      const chunks: Array<AudioChunk> = [];
      for (let index = 0; index < count; index++) {
        const start = index * CHUNK_SECONDS;
        const name = `chunk-${index}.wav`;
        yield* run(
          ffmpeg,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            String(start),
            "-t",
            String(Math.min(CHUNK_SECONDS, seconds - start)),
            "-i",
            inside("audio.wav"),
            "-ac",
            "1",
            "-ar",
            String(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            inside(name),
          ],
          CONVERT_TIMEOUT_MS,
          "convert",
        );
        chunks.push({ file: path.join(workDir, name), startSeconds: startSeconds + start });
      }
      return {
        title: video.title?.trim() || "Untitled video",
        durationSeconds: listed ?? endSeconds,
        endSeconds,
        chunks,
      };
    }),
  });
});

export const layer = Layer.effect(VideoMedia, make);

/** YouTube's own captions come first, since they take seconds; a video without them, and every other site's, is downloaded and transcribed on the owner's speech server, never in the cloud. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpBody, HttpClient } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as Speech from "../voice/SpeechToText.ts";
import { makeTranscriptCache } from "./cache.ts";
import { clock, mergeCues, Player, selectTrack, TimedText, timedTextUrl } from "./captions.ts";
import * as Media from "./Media.ts";
import { type VideoLink, videoLink } from "./sites.ts";

/** The longest part one call reads: an hour is a lecture or a podcast episode; `fromMinutes` reads the next. */
const MAX_SECONDS = 60 * 60;
/** Roughly 15k tokens, which leaves the bot's own context and memory room to work. */
const MAX_CHARS = 60_000;
/** One GPU serves every bot's speech recognition. */
const MAX_JOBS = 2;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;

export class TranscriptError extends Schema.TaggedError<TranscriptError>()("TranscriptError", {
  stage: Schema.Literals(["url", "range", "stt", "captions"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

export interface TranscriptInput {
  readonly url: string;
  readonly language?: string | undefined;
  readonly fromMinutes?: number | undefined;
}

export class Transcript extends Context.Service<
  Transcript,
  {
    readonly transcript: (input: TranscriptInput) => Effect.Effect<string, TranscriptError>;
  }
>()("t3/video/Transcript") {}

const decodePlayer = Schema.decodeUnknownEffect(Schema.fromJsonString(Player));
const decodeCaptions = Schema.decodeUnknownEffect(Schema.fromJsonString(TimedText));

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

export function trimTranscript(body: string, maxChars = MAX_CHARS) {
  if (body.length <= maxChars) return body;
  const cut = body.lastIndexOf("\n", maxChars);
  const kept = body.slice(0, cut > 0 ? cut : maxChars);
  return `${kept}\n\nNote: the transcript was trimmed to its first ${kept.length} characters.`;
}

interface ReadTranscript {
  readonly title: string;
  readonly durationSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly source: string;
  readonly body: string;
}

const sectionNote = (input: ReadTranscript) =>
  input.startSeconds === 0 && input.endSeconds >= input.durationSeconds
    ? []
    : [
        `Note: this covers ${clock(input.startSeconds)}–${clock(input.endSeconds)} of the ${clock(input.durationSeconds)} video.${
          input.endSeconds < input.durationSeconds
            ? ` Call again with fromMinutes: ${Math.floor(input.endSeconds / 60)} for the next part.`
            : ""
        }`,
      ];

const render = (input: ReadTranscript) =>
  [
    `Video: ${oneLine(input.title)}`,
    `Duration: ${clock(input.durationSeconds)}`,
    `Source: ${input.source}`,
    "",
    trimTranscript(input.body),
    ...sectionNote(input).flatMap((note) => ["", note]),
  ].join("\n");

const captionFailure = (detail: string) => new TranscriptError({ stage: "captions", detail });
const sttFailure = (detail: string) => new TranscriptError({ stage: "stt", detail });

const rangeFailure = (durationSeconds: number) =>
  new TranscriptError({
    stage: "range",
    detail: `The video is only ${Math.floor(durationSeconds / 60)} minutes long.`,
  });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const speech = yield* Speech.SpeechToText;
  const media = yield* Media.VideoMedia;
  const jobs = yield* Semaphore.make(MAX_JOBS);
  const cache = yield* makeTranscriptCache(
    path.join(config.stateDir, "video-transcripts"),
    CACHE_MAX_BYTES,
  );

  const read = Effect.fn("Transcript.read")(
    function* (request: ReturnType<typeof http.get>) {
      const response = yield* request.pipe(
        Effect.mapError(() => captionFailure("Could not reach YouTube.")),
      );
      if (response.status !== 200)
        return yield* captionFailure(
          `YouTube refused the caption request (HTTP ${response.status}).`,
        );
      return yield* response.text.pipe(
        Effect.mapError(() => captionFailure("YouTube sent no readable caption body.")),
      );
    },
    (self) =>
      self.pipe(
        // Keep application trace headers off public caption requests.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeout("30 seconds"),
        Effect.catchTags({
          TimeoutError: () => Effect.fail(captionFailure("YouTube did not answer in time.")),
        }),
      ),
  );

  const captionsFor = Effect.fn("Transcript.captionsFor")(function* (
    player: Player,
    language: string | undefined,
    startSeconds: number,
  ) {
    const durationSeconds = Number(player.videoDetails.lengthSeconds ?? 0);
    if (durationSeconds > 0 && startSeconds >= durationSeconds)
      return yield* rangeFailure(durationSeconds);
    const track = selectTrack(player, language);
    if (!track) return yield* captionFailure("YouTube lists no caption tracks for this video.");
    const url = yield* Effect.try({
      try: () => timedTextUrl(track),
      catch: () => captionFailure("YouTube sent an unexpected caption URL."),
    });
    const text = yield* read(http.get(url));
    const captions = yield* decodeCaptions(text).pipe(
      Effect.mapError(() => captionFailure("YouTube's caption track was unreadable.")),
    );
    const endSeconds = Math.min(durationSeconds || Infinity, startSeconds + MAX_SECONDS);
    const lines = mergeCues(captions).filter(
      (line) => line.start >= startSeconds && line.start < endSeconds,
    );
    if (!lines.length) return yield* captionFailure("YouTube's caption track is empty here.");
    return {
      title: player.videoDetails.title,
      durationSeconds,
      startSeconds,
      endSeconds: Number.isFinite(endSeconds) ? endSeconds : durationSeconds,
      source: `youtube captions (${track.kind === "asr" ? "auto" : "manual"}, ${track.languageCode})`,
      body: lines.map((line) => `[${clock(line.start)}] ${line.text}`).join("\n"),
    } satisfies ReadTranscript;
  });

  /**
   * The watch page carries the player response; when YouTube leaves the track's URL without a
   * usable signature, the iOS player API currently returns one without cookies or a token.
   */
  const fromCaptions = Effect.fn("Transcript.fromCaptions")(function* (
    id: string,
    language: string | undefined,
    startSeconds: number,
  ) {
    const watch = Effect.gen(function* () {
      const html = yield* read(
        http.get(`https://www.youtube.com/watch?v=${id}&hl=en`, {
          headers: { "user-agent": "Mozilla/5.0" },
        }),
      );
      const json = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*(\{.*?\});/s.exec(html)?.[1];
      if (!json) return yield* captionFailure("YouTube's page carried no player response.");
      const player = yield* decodePlayer(json).pipe(
        Effect.mapError(() =>
          captionFailure("YouTube's page carried no readable player response."),
        ),
      );
      return yield* captionsFor(player, language, startSeconds);
    });
    return yield* watch.pipe(
      Effect.catchIf(
        (error) => error.stage === "captions",
        Effect.fn("Transcript.fromPlayerApi")(function* () {
          const body = yield* read(
            http.post("https://www.youtube.com/youtubei/v1/player", {
              body: HttpBody.jsonUnsafe({
                context: {
                  client: {
                    clientName: "IOS",
                    clientVersion: "20.10.4",
                    deviceMake: "Apple",
                    deviceModel: "iPhone16,2",
                    osName: "iPhone",
                    osVersion: "18.3.2.22D82",
                    hl: "en",
                  },
                },
                videoId: id,
                contentCheckOk: true,
                racyCheckOk: true,
              }),
            }),
          );
          const player = yield* decodePlayer(body).pipe(
            Effect.mapError(() =>
              captionFailure("YouTube's player API returned no readable response."),
            ),
          );
          return yield* captionsFor(player, language, startSeconds);
        }),
      ),
    );
  });

  const transcribe = Effect.fn("Transcript.transcribe")(function* (
    link: VideoLink,
    startSeconds: number,
    workDir: string,
  ): Effect.fn.Return<ReadTranscript, TranscriptError> {
    const audio = yield* media
      .audio({
        url: link.url,
        extractors: link.extractors,
        startSeconds,
        maxSeconds: MAX_SECONDS,
        workDir,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new TranscriptError({
              stage: error.stage === "range" ? "range" : "stt",
              detail: error.message,
            }),
        ),
      );
    let backend: "nemotron" | "whisper" | "cloud" | undefined;
    const blocks: Array<string> = [];
    for (const chunk of audio.chunks) {
      const bytes = yield* fs
        .readFile(chunk.file)
        .pipe(Effect.mapError(() => sttFailure("Could not read a downloaded audio chunk.")));
      const heard = yield* speech
        .transcribe({ audio: bytes, mimeType: "audio/wav", fileName: "chunk.wav", cloud: false })
        .pipe(Effect.result);
      if (heard._tag === "Failure") {
        // A chunk with no speech, such as music between chapters, is not a failure.
        if (heard.failure.reason === "empty") continue;
        return yield* sttFailure(heard.failure.detail);
      }
      backend ??= heard.success.backend;
      const text = heard.success.text.trim();
      if (text) blocks.push(`[${clock(chunk.startSeconds)}] ${text}`);
    }
    if (!blocks.length)
      return yield* sttFailure("The speech server recognized no words in this video.");
    return {
      title: audio.title,
      durationSeconds: audio.durationSeconds,
      startSeconds,
      endSeconds: audio.endSeconds,
      source: `local speech recognition (${backend ?? "speech server"})`,
      body: blocks.join("\n\n"),
    } satisfies ReadTranscript;
  });

  /** The speech check and the work directory come before the job slot, so a waiting call holds no permit. */
  const fromSpeech = Effect.fn("Transcript.fromSpeech")(function* (
    link: VideoLink,
    startSeconds: number,
  ) {
    const root = path.join(config.stateDir, "video-tmp");
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(() => sttFailure("Could not create the transcript work directory.")));
    return yield* Effect.gen(function* () {
      const workDir = yield* fs
        .makeTempDirectoryScoped({ directory: root, prefix: "video-" })
        .pipe(Effect.mapError(() => sttFailure("Could not create a transcript work directory.")));
      if (!(yield* speech.ready()))
        return yield* sttFailure("Local speech recognition is off or busy.");
      return yield* jobs.withPermits(1)(transcribe(link, startSeconds, workDir));
    }).pipe(Effect.scoped);
  });

  return Transcript.of({
    transcript: Effect.fn("Transcript.transcript")(function* (input) {
      const link = videoLink(input.url);
      if (link === undefined)
        return yield* new TranscriptError({
          stage: "url",
          detail: "Send a public video link from YouTube, Instagram, TikTok, X or Vimeo.",
        });
      const startSeconds = Math.max(0, Math.floor(input.fromMinutes ?? 0)) * 60;
      const captionsKey = `${link.url}|${startSeconds}|captions|${input.language ?? ""}`;
      const speechKey = `${link.url}|${startSeconds}|speech`;
      for (const key of link.youtubeId ? [captionsKey, speechKey] : [speechKey]) {
        const cached = yield* cache.get(key);
        if (cached._tag === "Some") return cached.value;
      }

      let captionsDetail = "";
      if (link.youtubeId) {
        const captions = yield* fromCaptions(link.youtubeId, input.language, startSeconds).pipe(
          Effect.result,
        );
        if (captions._tag === "Success") {
          const text = render(captions.success);
          yield* cache.put(captionsKey, text);
          return text;
        }
        if (captions.failure.stage === "range") return yield* captions.failure;
        captionsDetail = `${captions.failure.detail} `;
      }
      const spoken = yield* fromSpeech(link, startSeconds).pipe(Effect.result);
      if (spoken._tag === "Success") {
        const text = render(spoken.success);
        yield* cache.put(speechKey, text);
        return text;
      }
      if (spoken.failure.stage === "range") return yield* spoken.failure;
      return yield* sttFailure(`${captionsDetail}${spoken.failure.detail}`);
    }),
  });
});

export const layer = Layer.effect(Transcript, make);

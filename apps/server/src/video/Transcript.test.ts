// @effect-diagnostics nodeBuiltinImport:off - fake media writes chunk files where the service asks.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as Speech from "../voice/SpeechToText.ts";
import { makeTranscriptCache } from "./cache.ts";
import { TimedText } from "./captions.ts";
import * as Media from "./Media.ts";
import * as Transcript from "./Transcript.ts";

const id = "mTd3tBpfYmw";
const reel = (code = "DAbc12x") => `https://www.instagram.com/reel/${code}/?igsh=share`;
const PLAYER = {
  videoDetails: { title: "A talk about Ferris", author: "Channel", lengthSeconds: "754" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=en`,
          languageCode: "en",
          kind: "asr",
        },
      ],
      audioTracks: [{ defaultCaptionTrackIndex: 0 }],
    },
  },
};
const UNCAPTIONED = { videoDetails: PLAYER.videoDetails };
const encodeTimedText = Schema.encodeSync(Schema.fromJsonString(TimedText));
const timedText = (events: ReadonlyArray<readonly [number, string]>) =>
  encodeTimedText({
    events: events.map(([seconds, utf8]) => ({
      tStartMs: seconds * 1000,
      dDurationMs: 2_000,
      segs: [{ utf8 }],
    })),
  });
const TIMED_TEXT = timedText([
  [0, "Ferris says hello."],
  [16, "The borrow checker agrees."],
]);

interface Deps {
  readonly speech: Speech.SpeechToText["Service"];
  readonly media: Media.VideoMedia["Service"];
  readonly http: HttpClient.HttpClient;
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, Transcript.Transcript>,
  deps: Deps,
): Effect.Effect<A, E | PlatformError.PlatformError> => {
  const services = Layer.mergeAll(
    Layer.succeed(Speech.SpeechToText, deps.speech),
    Layer.succeed(Media.VideoMedia, deps.media),
    Layer.succeed(HttpClient.HttpClient, deps.http),
    Digest.layerWebCrypto,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-video-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  return effect.pipe(
    Effect.provide(Layer.mergeAll(Transcript.layer.pipe(Layer.provide(services)), services)),
  );
};

const speech = (
  ready: boolean,
  heard: (
    call: number,
  ) => Effect.Effect<{ readonly text: string; readonly backend: "whisper" }, Speech.SpeechError>,
  onReady: Effect.Effect<void> = Effect.void,
) => {
  let calls = 0;
  return Speech.SpeechToText.of({
    ready: () => Effect.as(onReady, ready),
    transcribe: () => heard(calls++),
  });
};
const heardChunks = speech(true, (call) =>
  Effect.succeed({ text: call === 0 ? " first part " : "second part", backend: "whisper" }),
);

const captionsHttp = (
  calls: Array<string>,
  options: { readonly status?: number; readonly player?: object; readonly captions?: string } = {},
) =>
  HttpClient.make((request) => {
    calls.push(request.url);
    const status = options.status ?? 200;
    const player = options.player ?? PLAYER;
    const body = request.url.includes("/watch?")
      ? `var ytInitialPlayerResponse = ${JSON.stringify(player)};`
      : request.url.includes("/youtubei/v1/player")
        ? JSON.stringify(player)
        : (options.captions ?? TIMED_TEXT);
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
  });

const noHttp = HttpClient.make(() => Effect.die("captions must not be fetched"));
const noMedia = Media.VideoMedia.of({ audio: () => Effect.die("nothing is downloaded") });

const writeChunks = (workDir: string, startSeconds: number, count: number) => {
  NodeFS.mkdirSync(workDir, { recursive: true });
  return Array.from({ length: count }, (_, index) => {
    const file = NodePath.join(workDir, `chunk-${index}.wav`);
    NodeFS.writeFileSync(file, "wav");
    return { file, startSeconds: startSeconds + index * 600 };
  });
};

const fakeMedia = (
  title: string,
  durationSeconds: number,
  chunkCount: number,
  requests: Array<Media.AudioRequest> = [],
) =>
  Media.VideoMedia.of({
    audio: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return {
          title,
          durationSeconds,
          endSeconds: Math.min(durationSeconds, request.startSeconds + 3600),
          chunks: writeChunks(request.workDir, request.startSeconds, chunkCount),
        };
      }),
  });

it.effect("reads YouTube's captions first and downloads nothing", () => {
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const text = yield* transcripts.transcript({ url: `https://youtu.be/${id}` });
    expect(text).toBe(
      [
        "Video: A talk about Ferris",
        "Duration: 12:34",
        "Source: youtube captions (auto, en)",
        "",
        "[00:00] Ferris says hello.",
        "[00:16] The borrow checker agrees.",
      ].join("\n"),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/watch?v=");
    expect(calls[1]).toContain("/api/timedtext");
  }).pipe((effect) =>
    provide(effect, {
      speech: speech(true, () => Effect.die("captions need no speech server")),
      media: noMedia,
      http: captionsHttp(calls),
    }),
  );
});

it.effect("transcribes a YouTube video without captions on the speech server", () => {
  const requests: Array<Media.AudioRequest> = [];
  return Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const text = yield* transcripts.transcript({ url: `https://youtu.be/${id}` });
    expect(text).toContain("Video: A talk in two parts");
    expect(text).toContain("Duration: 20:34");
    expect(text).toContain("Source: local speech recognition (whisper)");
    expect(text).toContain("[00:00] first part");
    expect(text).toContain("[10:00] second part");
    expect(text).not.toContain("Note:");
    expect(requests.map(({ url, extractors }) => ({ url, extractors }))).toEqual([
      { url: `https://www.youtube.com/watch?v=${id}`, extractors: ["youtube"] },
    ]);
  }).pipe((effect) =>
    provide(effect, {
      speech: heardChunks,
      media: fakeMedia("A talk in two parts", 1_234, 2, requests),
      http: captionsHttp([], { player: UNCAPTIONED }),
    }),
  );
});

it.effect("sends a reel straight to the downloader with Instagram's extractor only", () => {
  const requests: Array<Media.AudioRequest> = [];
  return Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const text = yield* transcripts.transcript({ url: reel() });
    expect(text).toContain("Source: local speech recognition (whisper)");
    expect(requests.map(({ url, extractors }) => ({ url, extractors }))).toEqual([
      { url: "https://www.instagram.com/reel/DAbc12x/", extractors: ["instagram"] },
    ]);
  }).pipe((effect) =>
    provide(effect, {
      speech: heardChunks,
      media: fakeMedia("A reel", 40, 1, requests),
      http: noHttp,
    }),
  );
});

it.effect("reports both sources in one line when neither gives a transcript", () =>
  Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const error = yield* transcripts
      .transcript({ url: `https://youtu.be/${id}` })
      .pipe(Effect.flip);
    expect(error.stage).toBe("stt");
    expect(error.detail).toContain("HTTP 429");
    expect(error.detail).toContain("Local speech recognition is off or busy.");
    expect(error.detail).not.toContain("\n");
  }).pipe((effect) =>
    provide(effect, {
      speech: speech(false, () => Effect.die("nothing is transcribed")),
      media: noMedia,
      http: captionsHttp([], { status: 429 }),
    }),
  ),
);

it.effect("refuses a LAN address, a file link and an unlisted host before any work", () =>
  Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    for (const url of [
      "http://192.168.1.20:8080/video.mp4",
      "file:///var/lib/rejects/userdata/bots.json",
      "https://example.com/video",
    ]) {
      const error = yield* transcripts.transcript({ url }).pipe(Effect.flip);
      expect(error.stage).toBe("url");
    }
  }).pipe((effect) =>
    provide(effect, {
      speech: speech(true, () => Effect.die("nothing is transcribed")),
      media: noMedia,
      http: noHttp,
    }),
  ),
);

it.effect("reads the hour fromMinutes names and says where the next one starts", () => {
  const requests: Array<Media.AudioRequest> = [];
  return Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const captions = yield* transcripts.transcript({
      url: `https://youtu.be/${id}`,
      fromMinutes: 60,
    });
    expect(captions).toContain("[1:01:40] The second hour starts.");
    expect(captions).not.toContain("First hour.");
    expect(captions).not.toContain("Third hour.");
    expect(captions).toContain("Call again with fromMinutes: 120");
    yield* transcripts.transcript({ url: reel(), fromMinutes: 60 });
    expect(requests.map((request) => request.startSeconds)).toEqual([3_600]);
  }).pipe((effect) =>
    provide(effect, {
      speech: heardChunks,
      media: fakeMedia("A long reel", 5_000, 1, requests),
      http: captionsHttp([], {
        player: { ...PLAYER, videoDetails: { ...PLAYER.videoDetails, lengthSeconds: "9000" } },
        captions: timedText([
          [10, "First hour."],
          [3_700, "The second hour starts."],
          [7_300, "Third hour."],
        ]),
      }),
    }),
  );
});

it.effect("runs two downloads at a time; a third waits for a slot", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<"ready" | "start">();
    const gate = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      const transcripts = yield* Transcript.Transcript;
      const fibers = yield* Effect.forEach(["A1", "A2", "A3"], (code) =>
        Effect.forkChild(transcripts.transcript({ url: reel(code) })),
      );
      const seen: Array<string> = [];
      while (seen.filter((event) => event === "ready").length < 3)
        seen.push(yield* Queue.take(events));
      // The ready check and the download run back to back; only the slot can hold the third.
      seen.push(...(yield* Queue.clear(events)));
      expect(seen.filter((event) => event === "start")).toHaveLength(2);
      yield* Deferred.succeed(gate, undefined);
      for (const fiber of fibers) expect(yield* Fiber.join(fiber)).toContain("Source:");
      expect(
        [...seen, ...(yield* Queue.clear(events))].filter((event) => event === "start"),
      ).toHaveLength(3);
    }).pipe((effect) =>
      provide(effect, {
        speech: speech(
          true,
          () => Effect.succeed({ text: "words", backend: "whisper" }),
          Queue.offer(events, "ready").pipe(Effect.asVoid),
        ),
        media: Media.VideoMedia.of({
          audio: (request) =>
            Queue.offer(events, "start").pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.map(() => ({
                title: "A reel",
                durationSeconds: 30,
                endSeconds: 30,
                chunks: writeChunks(request.workDir, 0, 1),
              })),
            ),
        }),
        http: noHttp,
      }),
    );
  }),
);

it.effect("answers a second call for the same video from the cache, without a download", () => {
  const requests: Array<Media.AudioRequest> = [];
  return Effect.gen(function* () {
    const transcripts = yield* Transcript.Transcript;
    const first = yield* transcripts.transcript({ url: reel() });
    const second = yield* transcripts.transcript({ url: reel().replace("?igsh=share", "") });
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
    yield* transcripts.transcript({ url: reel(), fromMinutes: 1 });
    expect(requests).toHaveLength(2);
  }).pipe((effect) =>
    provide(effect, {
      speech: heardChunks,
      media: fakeMedia("A reel", 300, 1, requests),
      http: noHttp,
    }),
  );
});

it.effect("removes the oldest transcripts once the cache passes its size", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-video-cache-" });
    const cache = yield* makeTranscriptCache(dir, 25);
    // Node reads a number as seconds since the epoch; only files written just now are moved back.
    const age = (seconds: number) =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(dir)) {
          const file = NodePath.join(dir, name);
          const { mtime } = yield* fs.stat(file);
          if (mtime._tag === "Some" && mtime.value.getTime() > 10_000_000)
            yield* fs.utimes(file, seconds, seconds);
        }
      });
    yield* cache.put("a", "0123456789");
    yield* age(1_000);
    yield* cache.put("b", "0123456789");
    yield* age(2_000);
    yield* cache.put("c", "0123456789");
    expect((yield* cache.get("a"))._tag).toBe("None");
    expect((yield* cache.get("b"))._tag).toBe("Some");
    expect((yield* cache.get("c"))._tag).toBe("Some");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto))),
);

it("trims a long transcript at a line boundary and says so", () => {
  const body = Array.from({ length: 2_000 }, (_, i) => `[00:00] line ${i}`).join("\n");
  const trimmed = Transcript.trimTranscript(body, 1_000);
  expect(trimmed.length).toBeLessThan(2_000);
  expect(trimmed).toContain("Note: the transcript was trimmed to its first");
  expect(Transcript.trimTranscript("short body", 1_000)).toBe("short body");
});

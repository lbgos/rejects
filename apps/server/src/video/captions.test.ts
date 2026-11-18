import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  clock,
  mergeCues,
  Player,
  selectTrack,
  TimedText,
  timedTextUrl,
  videoIdFromUrl,
} from "./captions.ts";

const id = "mTd3tBpfYmw";

it("accepts the URL forms a chat message carries and rejects other hosts, paths and ids", () => {
  for (const url of [
    `https://youtube.com/watch?v=${id}&t=3`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://m.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `  https://youtu.be/${id}  `,
  ])
    expect(videoIdFromUrl(url)).toBe(id);
  for (const url of [
    "oops",
    `https://youtube.com.evil/watch?v=${id}`,
    `https://evil.com/watch?v=${id}`,
    `https://youtube.com/playlist?v=${id}`,
    "https://youtube.com/watch?v=short",
    `ftp://youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}/extra`,
    `https://youtube.com:@evil.com/watch?v=${id}`,
  ])
    expect(() => videoIdFromUrl(url)).toThrow();
});

const track = (languageCode: string, kind?: string) => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=${languageCode}`,
  languageCode,
  ...(kind === undefined ? {} : { kind }),
});
const player = (captionTracks: ReadonlyArray<ReturnType<typeof track>>, original = 0) => ({
  videoDetails: { title: "A talk", author: "Channel", lengthSeconds: "754" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks,
      defaultAudioTrackIndex: original,
      audioTracks: captionTracks.map((_, index) => ({ defaultCaptionTrackIndex: index })),
    },
  },
});

it("prefers the requested language, then a manual track, then the spoken language, then English", () => {
  expect(selectTrack(player([track("en", "asr"), track("en")]))?.kind).toBeUndefined();
  expect(selectTrack(player([track("uk", "asr"), track("en", "asr")]))?.languageCode).toBe("uk");
  expect(selectTrack(player([track("en"), track("uk")], 1))?.languageCode).toBe("uk");
  expect(selectTrack(player([track("fr"), track("en")], 0))?.languageCode).toBe("fr");
  expect(selectTrack(player([track("uk", "asr"), track("en", "asr")]), "uk")?.languageCode).toBe(
    "uk",
  );
  expect(selectTrack(player([track("uk", "asr"), track("uk")]), "uk")?.kind).toBeUndefined();
  expect(selectTrack(player([track("uk", "asr")]), "ru")?.languageCode).toBe("uk");
  expect(selectTrack(player([track("fr"), track("uk", "asr")], 1))?.languageCode).toBe("uk");
  expect(selectTrack(player([track("de")]), "fr")?.languageCode).toBe("de");
  expect(selectTrack({ videoDetails: { title: "x", author: "y" } })).toBeUndefined();
});

it("only fetches YouTube's own timedtext route", () => {
  expect(timedTextUrl(track("en"))).toBe(
    `https://www.youtube.com/api/timedtext?v=${id}&lang=en&fmt=json3`,
  );
  expect(() =>
    timedTextUrl({ ...track("en"), baseUrl: "https://evil.com/api/timedtext?v=x" }),
  ).toThrow();
  expect(() =>
    timedTextUrl({ ...track("en"), baseUrl: `https://www.youtube.com/other?v=${id}` }),
  ).toThrow();
});

const decodePlayer = Schema.decodeSync(Player);
const captions = Schema.decodeSync(TimedText)({
  events: [
    {
      tStartMs: 0,
      dDurationMs: 2_000,
      segs: [{ utf8: "With the anticipated " }, { utf8: "Nvidia." }],
    },
    { tStartMs: 2_000, dDurationMs: 2_000, segs: [{ utf8: "With the anticipated Nvidia." }] },
    { tStartMs: 16_000, dDurationMs: 2_000, segs: [{ utf8: "And then the next thing." }] },
    { tStartMs: 20_000, dDurationMs: 0 },
  ],
});

it("merges rolling json3 events into roughly 15-second lines without an empty one", () => {
  expect(mergeCues(captions)).toEqual([
    { start: 0, text: "With the anticipated Nvidia. With the anticipated Nvidia." },
    { start: 16, text: "And then the next thing." },
  ]);
  expect(mergeCues({ events: [] })).toEqual([]);
});

it("writes durations as minutes, and hours once they pass one", () => {
  expect(clock(0)).toBe("00:00");
  expect(clock(754)).toBe("12:34");
  expect(clock(3_599)).toBe("59:59");
  expect(clock(3_600)).toBe("1:00:00");
  expect(clock(Number.NaN)).toBe("unknown");
});

it("decodes a player response with no caption tracks", () => {
  expect(decodePlayer({ videoDetails: { title: "x", author: "y", lengthSeconds: "1" } })).toEqual({
    videoDetails: { title: "x", author: "y", lengthSeconds: "1" },
  });
});

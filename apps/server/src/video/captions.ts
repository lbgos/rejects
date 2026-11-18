import * as Schema from "effect/Schema";

const CaptionTrack = Schema.Struct({
  baseUrl: Schema.String,
  languageCode: Schema.String,
  kind: Schema.optional(Schema.String),
});
const TrackList = Schema.Struct({
  captionTracks: Schema.Array(CaptionTrack),
  defaultAudioTrackIndex: Schema.optional(Schema.Number),
  audioTracks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        defaultCaptionTrackIndex: Schema.optional(Schema.Number),
      }),
    ),
  ),
});
export const Player = Schema.Struct({
  videoDetails: Schema.Struct({
    title: Schema.String,
    author: Schema.String,
    lengthSeconds: Schema.optional(Schema.String),
  }),
  captions: Schema.optional(
    Schema.Struct({ playerCaptionsTracklistRenderer: Schema.optional(TrackList) }),
  ),
});
export type Player = typeof Player.Type;
export const TimedText = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      tStartMs: Schema.Number,
      dDurationMs: Schema.optional(Schema.Number),
      segs: Schema.optional(Schema.Array(Schema.Struct({ utf8: Schema.String }))),
    }),
  ),
});
export type TimedText = typeof TimedText.Type;

export interface CaptionTrack {
  readonly baseUrl: string;
  readonly languageCode: string;
  /** `asr` is YouTube's automatic track; a missing kind is a manual one. */
  readonly kind?: string | undefined;
}

export function videoIdFromUrl(input: string) {
  const url = new URL(input.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
    throw new Error("Expected a YouTube video URL.");
  let id: string | null | undefined;
  if (url.hostname === "youtu.be") id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "www.youtube-nocookie.com",
    ].includes(url.hostname)
  ) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|live|embed|v)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Expected a YouTube video URL.");
  return id;
}

const isAuto = (track: CaptionTrack) => track.kind === "asr";
const english = (track: CaptionTrack) => /^en(?:-|$)/.test(track.languageCode);

const inLanguage = (track: CaptionTrack, language: string) => {
  const code = track.languageCode.toLowerCase();
  const wanted = language.trim().toLowerCase();
  return code === wanted || code.startsWith(`${wanted}-`);
};

/**
 * Manual tracks go before automatic ones, because the automatic text is often punctuated badly and
 * repeats words; then the spoken language, then English.
 */
export function selectTrack(player: Player, language?: string | undefined) {
  const list = player.captions?.playerCaptionsTracklistRenderer;
  if (!list?.captionTracks.length) return undefined;
  const wanted =
    language === undefined ? [] : list.captionTracks.filter((t) => inLanguage(t, language));
  const original =
    list.audioTracks?.[list.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex ?? 0;
  const originalLanguage = list.captionTracks[original]?.languageCode;
  const candidates = list.captionTracks.filter(
    (track) =>
      english(track) || (originalLanguage !== undefined && track.languageCode === originalLanguage),
  );
  const spoken = (track: CaptionTrack) => track.languageCode === originalLanguage;
  const pick = (tracks: ReadonlyArray<CaptionTrack>) =>
    tracks.toSorted(
      (a, b) =>
        Number(isAuto(a)) - Number(isAuto(b)) ||
        Number(spoken(b)) - Number(spoken(a)) ||
        Number(english(b)) - Number(english(a)),
    )[0];
  return pick(wanted.length ? wanted : candidates.length ? candidates : list.captionTracks);
}

/** A caption URL from YouTube's own timedtext route; anything else is refused before a request. */
export function timedTextUrl(track: CaptionTrack) {
  const url = new URL(track.baseUrl);
  if (
    url.protocol !== "https:" ||
    !["www.youtube.com", "www.youtube-nocookie.com"].includes(url.hostname) ||
    url.pathname !== "/api/timedtext"
  )
    throw new Error("Unexpected caption URL.");
  url.searchParams.set("fmt", "json3");
  return url.toString();
}

export function mergeCues(captions: TimedText) {
  const lines: Array<{ start: number; text: string }> = [];
  let line: { start: number; text: string } | undefined;
  for (const event of captions.events) {
    const text = event.segs
      ?.map((segment) => segment.utf8)
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) continue;
    const start = event.tStartMs / 1000;
    if (line === undefined || start - line.start >= 15) {
      line = { start, text };
      lines.push(line);
    } else line.text += ` ${text}`;
  }
  return lines;
}

export function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return "unknown";
  const whole = Math.max(0, Math.floor(seconds));
  const rest = whole % 3600;
  const minutes = String(Math.floor(rest / 60)).padStart(2, "0");
  const tail = `${minutes}:${String(rest % 60).padStart(2, "0")}`;
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${tail}` : tail;
}

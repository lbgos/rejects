import { assert, it } from "@effect/vitest";
import { rankFolders, type SearchResponse } from "./ranking.ts";

const flac = (dir: string, count: number, depth = 16, rate = 44_100, from = 1) =>
  Array.from({ length: count }, (_, i) => ({
    filename: `${dir}\\${String(from + i).padStart(2, "0")} - Track.flac`,
    size: 30_000_000,
    extension: "flac",
    bitDepth: depth,
    sampleRate: rate,
  }));
const peer = (
  username: string,
  files: SearchResponse["files"],
  slot = true,
  queue = 0,
  speed = 2_000_000,
): SearchResponse => ({
  username,
  files,
  hasFreeUploadSlot: slot,
  queueLength: queue,
  uploadSpeed: speed,
});

it("prefers complete, consistent FLAC from a free slot over speed, MP3 and queues", () => {
  const ranked = rankFolders(
    [
      peer("fast-incomplete", flac("m\\NIN\\The Slip", 8), true, 0, 20_000_000),
      peer("mp3", [
        { filename: "m\\NIN - The Slip\\01.mp3", size: 9e6, bitRate: 320 },
        ...Array.from({ length: 9 }, (_, i) => ({
          filename: `m\\NIN - The Slip\\0${i + 2}.mp3`,
          size: 9e6,
          bitRate: 320,
        })),
      ]),
      peer("mixed", [...flac("x\\The Slip", 5), ...flac("x\\The Slip", 5, 24, 96_000, 6)]),
      peer("queued", flac("q\\The Slip (2008)", 10), false, 300),
      peer("good", flac("music\\Nine Inch Nails\\The Slip (2008)", 10), true, 0, 3_000_000),
    ],
    [10],
  );
  assert.deepStrictEqual(
    ranked.map((folder) => folder.username),
    ["good", "queued", "mixed", "fast-incomplete", "mp3"],
  );
  assert.deepInclude(ranked[0], {
    directory: "music\\Nine Inch Nails\\The Slip (2008)",
    tracks: 10,
    format: "FLAC 16/44.1",
    complete: true,
  });
  assert.strictEqual(ranked[2]?.format, "FLAC mixed");
  assert.strictEqual(ranked[3]?.complete, false);
});

it("drops folders with executables or archives, locked files and non-audio files", () => {
  const ranked = rankFolders(
    [
      peer("bundle", [...flac("a\\Album", 10), { filename: "a\\Album\\setup.exe", size: 1 }]),
      peer("zip", [...flac("z\\Album", 10), { filename: "z\\Album\\scans.rar", size: 1 }]),
      peer("clean", [
        ...flac("c\\Album", 10),
        { filename: "c\\Album\\cover.jpg", size: 1 },
        { filename: "c\\Album\\Album.cue", size: 1 },
        { ...flac("c\\Album", 1, 16, 44_100, 11)[0]!, isLocked: true },
      ]),
    ],
    [10],
  );
  assert.deepStrictEqual(
    ranked.map((folder) => [folder.username, folder.files.length]),
    [["clean", 10]],
  );
  assert.isTrue(ranked[0]?.files.every((file) => file.filename.endsWith(".flac")));
});

it("judges completeness by the most common track count when MusicBrainz has none", () => {
  const ranked = rankFolders(
    [
      peer("a", flac("a\\X", 12)),
      peer("b", flac("b\\X", 12)),
      peer("c", flac("c\\X", 9), true, 0, 9_000_000),
    ],
    [],
  );
  assert.deepStrictEqual(
    ranked.map((folder) => [folder.username, folder.complete]),
    [
      ["a", true],
      ["b", true],
      ["c", false],
    ],
  );
});

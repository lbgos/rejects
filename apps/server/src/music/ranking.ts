interface SearchFile {
  readonly filename: string;
  readonly size: number;
  readonly bitDepth?: number | undefined;
  readonly sampleRate?: number | undefined;
  readonly bitRate?: number | undefined;
  readonly isLocked?: boolean | undefined;
}
export interface SearchResponse {
  readonly username: string;
  readonly files: ReadonlyArray<SearchFile>;
  readonly hasFreeUploadSlot: boolean;
  readonly queueLength: number;
  readonly uploadSpeed: number;
}
export interface RankedFolder {
  readonly username: string;
  readonly directory: string;
  readonly files: ReadonlyArray<{ readonly filename: string; readonly size: number }>;
  readonly tracks: number;
  readonly format: string;
  readonly lossless: boolean;
  readonly complete: boolean;
  readonly bytes: number;
  readonly freeSlot: boolean;
  readonly queue: number;
  readonly speed: number;
  readonly score: number;
}

const AUDIO = new Set([
  "flac",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "wav",
  "aiff",
  "aif",
  "ape",
  "wv",
  "alac",
]);
const LOSSLESS = new Set(["flac", "wav", "aiff", "aif", "ape", "wv", "alac"]);
export const FORBIDDEN = new Set(
  "exe msi bat cmd com scr dll apk jar sh ps1 vbs lnk zip rar 7z tar gz tgz bz2 xz zst cab iso".split(
    " ",
  ),
);

export const extensionOf = (filename: string) => {
  const name = filename.slice(filename.lastIndexOf("\\") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};
export const isAudio = (filename: string) => AUDIO.has(extensionOf(filename));
const directoryOf = (filename: string) => filename.slice(0, filename.lastIndexOf("\\"));

const khz = (rate: number) => String(rate / 1000).replace(/\.0+$/u, "");

const describe = (files: ReadonlyArray<SearchFile>) => {
  const extensions = new Set(files.map((file) => extensionOf(file.filename)));
  if (extensions.size > 1) return [...extensions].map((ext) => ext.toUpperCase()).join("+");
  const ext = [...extensions][0]!.toUpperCase();
  const qualities = new Set(
    files.map((file) =>
      LOSSLESS.has(extensionOf(file.filename))
        ? file.bitDepth && file.sampleRate
          ? `${file.bitDepth}/${khz(file.sampleRate)}`
          : "?"
        : file.bitRate
          ? String(file.bitRate)
          : "?",
    ),
  );
  if (qualities.size > 1) return `${ext} mixed`;
  const quality = [...qualities][0]!;
  return quality === "?" ? ext : `${ext} ${quality}`;
};

const mostCommon = (values: ReadonlyArray<number>) => {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
};

export const rankFolders = (
  responses: ReadonlyArray<SearchResponse>,
  expectedTracks: ReadonlyArray<number>,
): RankedFolder[] => {
  const folders = responses.flatMap((response) => {
    const byDirectory = new Map<string, SearchFile[]>();
    for (const file of response.files) {
      if (file.isLocked) continue;
      const directory = directoryOf(file.filename);
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
    }
    return [...byDirectory].flatMap(([directory, files]) => {
      if (files.some((file) => FORBIDDEN.has(extensionOf(file.filename)))) return [];
      const audio = files
        .filter((file) => isAudio(file.filename))
        .toSorted((a, b) => a.filename.localeCompare(b.filename));
      return audio.length === 0 ? [] : [{ response, directory, audio }];
    });
  });
  const expected =
    expectedTracks.length > 0
      ? expectedTracks
      : [
          mostCommon(
            folders
              .filter(({ audio }) =>
                audio.every((file) => LOSSLESS.has(extensionOf(file.filename))),
              )
              .map(({ audio }) => audio.length),
          ),
        ].filter((count) => count !== undefined);
  return folders
    .map(({ response, directory, audio }): RankedFolder => {
      const losslessCount = audio.filter((file) => LOSSLESS.has(extensionOf(file.filename))).length;
      const lossless = losslessCount === audio.length;
      const format = describe(audio);
      const tracks = audio.length;
      const complete = expected.includes(tracks);
      const known = audio.every(
        (file) => file.bitDepth !== undefined || file.bitRate !== undefined,
      );
      const score =
        (lossless ? 100 : losslessCount > 0 ? 30 : 0) +
        (expected.length === 0 ? 0 : complete ? 50 : tracks > Math.max(...expected) ? -10 : -60) +
        // Consistency outweighs availability: the brief ranks bit depth above slots and queues.
        (!known ? 0 : format.endsWith(" mixed") ? -50 : 20) +
        (response.hasFreeUploadSlot ? 30 : -Math.min(30, response.queueLength)) +
        Math.min(20, response.uploadSpeed / 500_000);
      return {
        username: response.username,
        directory,
        files: audio.map((file) => ({ filename: file.filename, size: file.size })),
        tracks,
        format,
        lossless,
        complete,
        bytes: audio.reduce((sum, file) => sum + file.size, 0),
        freeSlot: response.hasFreeUploadSlot,
        queue: response.queueLength,
        speed: response.uploadSpeed,
        score,
      };
    })
    .toSorted((a, b) => b.score - a.score || b.speed - a.speed);
};

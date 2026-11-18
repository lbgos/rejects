/** Every name is one safe path segment; the music host's music-import checks that again before it moves anything. */
export interface InspectedFile {
  readonly name: string;
  readonly size: number;
  readonly flac: {
    readonly rate: number;
    readonly bits: number;
    readonly channels: number;
    readonly seconds: number;
  } | null;
  readonly tags: Readonly<Record<string, string>>;
}
export interface AlbumHint {
  readonly artist: string;
  readonly album: string;
  readonly year?: number | undefined;
}
interface ImportPlan {
  readonly target: string;
  readonly files: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly summary: {
    readonly artist: string;
    readonly album: string;
    readonly year: number | undefined;
    readonly tracks: number;
    readonly format: string;
  };
}

const safeName = (text: string) => {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  return [...cleaned].slice(0, 120).join("").trim() || "Unknown";
};

const numberOf = (value: string | undefined) => {
  const match = value?.match(/^\s*(\d{1,3})(?!\d)/u);
  return match ? Number(match[1]) : undefined;
};
const yearOf = (value: string | undefined) => {
  const match = value?.match(/\b(\d{4})\b/u);
  return match ? Number(match[1]) : undefined;
};
const firstTag = (files: ReadonlyArray<InspectedFile>, ...names: string[]) => {
  for (const name of names)
    for (const file of files) {
      const value = file.tags[name]?.trim();
      if (value) return value;
    }
  return undefined;
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};
const stemOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
};

const formatOf = (files: ReadonlyArray<InspectedFile>) => {
  const streams = files.map((file) => file.flac);
  if (streams.every((stream) => stream !== null)) {
    const kinds = new Set(
      streams.map((stream) => `${stream.bits}/${Math.floor(stream.rate / 1000)}`),
    );
    return kinds.size === 1 ? `FLAC ${[...kinds][0]}` : "FLAC mixed";
  }
  return [...new Set(files.map((file) => extensionOf(file.name).toUpperCase()))].join("+");
};

export const importPlan = (files: ReadonlyArray<InspectedFile>, hint: AlbumHint): ImportPlan => {
  const artists = new Set(files.map((file) => file.tags.artist?.trim()).filter(Boolean));
  const artist =
    firstTag(files, "albumartist", "album artist", "album_artist") ??
    (artists.size === 1 ? [...artists][0] : artists.size > 1 ? "Various Artists" : undefined) ??
    hint.artist;
  const album = firstTag(files, "album") ?? hint.album;
  const year = yearOf(firstTag(files, "originaldate", "originalyear", "date", "year")) ?? hint.year;
  const tracks = files.map((file) => {
    const stem = stemOf(file.name);
    const number = numberOf(file.tags.tracknumber) ?? numberOf(stem);
    const title =
      file.tags.title?.trim() ||
      stem.replace(/^\s*\d{1,3}(?!\d)\s*[-._)]?\s*(?:-\s*)?/u, "") ||
      stem;
    return { file, disc: numberOf(file.tags.discnumber), number, title };
  });
  const multiDisc = tracks.some((track) => (track.disc ?? 1) > 1);
  const ordered = tracks.toSorted(
    (a, b) =>
      (a.disc ?? 1) - (b.disc ?? 1) ||
      (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) ||
      a.file.name.localeCompare(b.file.name),
  );
  const used = new Set<string>();
  const planned = ordered.map(({ file, disc, number, title }) => {
    const prefix =
      number === undefined
        ? ""
        : `${multiDisc ? `${disc ?? 1}-` : ""}${String(number).padStart(2, "0")} - `;
    const base = `${prefix}${safeName(title)}`;
    const ext = extensionOf(file.name);
    let to = `${base}.${ext}`;
    for (let n = 2; used.has(to.toLowerCase()); n++) to = `${base} (${n}).${ext}`;
    used.add(to.toLowerCase());
    return { from: file.name, to };
  });
  return {
    target: `${safeName(artist)}/${year === undefined ? "" : `${year} - `}${safeName(album)}`,
    files: planned,
    summary: { artist, album, year, tracks: files.length, format: formatOf(files) },
  };
};

import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Finished transcripts on disk, one file per link, section and source; the oldest go first past `maxBytes`. */
export const makeTranscriptCache = Effect.fn("TranscriptCache.make")(function* (
  dir: string,
  maxBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const encoder = new TextEncoder();
  let writes = 0;

  const fileFor = (key: string) =>
    crypto
      .digestHex(Digest.sha256, encoder.encode(key))
      .pipe(Effect.map((hash) => path.join(dir, `${hash}.txt`)));

  const prune = Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir);
    const entries: Array<{ readonly file: string; readonly size: number; readonly at: number }> =
      [];
    for (const name of names) {
      if (!name.endsWith(".txt")) continue;
      const file = path.join(dir, name);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (info._tag === "None") continue;
      entries.push({
        file,
        size: Number(info.value.size),
        at: Option.match(info.value.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.toSorted((a, b) => a.at - b.at)) {
      if (total <= maxBytes) break;
      yield* fs.remove(entry.file).pipe(Effect.ignore);
      total -= entry.size;
    }
  });

  return {
    get: (key: string) =>
      fileFor(key).pipe(
        Effect.flatMap((file) => fs.readFileString(file)),
        Effect.option,
        Effect.withSpan("TranscriptCache.get"),
      ),
    /** A failed write only costs the next call a download. */
    put: Effect.fn("TranscriptCache.put")(
      function* (key: string, text: string) {
        yield* fs.makeDirectory(dir, { recursive: true });
        const file = yield* fileFor(key);
        // A reader never sees half a transcript: the rename is atomic within the directory.
        const temp = `${file}.${writes++}.part`;
        yield* fs.writeFileString(temp, text);
        yield* fs.rename(temp, file);
        yield* prune;
      },
      Effect.catch((cause) => Effect.logWarning("video.transcript.cache-write-failed", { cause })),
    ),
  };
});

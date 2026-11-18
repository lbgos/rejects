import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const decodeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ owner: Schema.NullOr(Schema.Struct({ chatId: Schema.Number })) }),
  ),
);

/**
 * Whether a Telegram owner is paired, read from `telegram.json` on each call so bots' tool lists
 * follow a link or unlink at once. A missing or unreadable file is not linked.
 */
export const telegramLinked = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.flatMap(decodeOwner),
    Effect.map((stored) => stored.owner !== null),
    Effect.orElseSucceed(() => false),
  );

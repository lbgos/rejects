import * as Effect from "effect/Effect";
import * as MusicLibrary from "../../../music/MusicLibrary.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { MusicToolkit } from "./tools.ts";

const asBot = Effect.fn("MusicTools.asBot")(function* () {
  const scope = yield* Invocation.requireThreadScope(
    yield* Invocation.McpInvocationContext,
    "music",
  );
  return {
    music: yield* MusicLibrary.MusicLibrary,
    bot: scope.botThreadId ?? scope.thread.threadId,
  };
});

export const layer = Access.toLayer(MusicToolkit, {
  music_search: Access.readsAsCaller(({ query }) =>
    asBot().pipe(Effect.flatMap(({ music, bot }) => music.search(bot, query))),
  ),
  music_download: Access.actsAsCaller(({ candidateId }) =>
    asBot().pipe(Effect.flatMap(({ music, bot }) => music.download(bot, candidateId))),
  ),
  music_status: Access.readsAsCaller(() =>
    asBot().pipe(Effect.flatMap(({ music, bot }) => music.status(bot))),
  ),
});

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Transcript from "../../../video/Transcript.ts";
import * as Access from "../../McpToolAccess.ts";
import { VideoToolkit } from "./tools.ts";

export const layer = Access.toLayer(VideoToolkit, {
  video_transcript: Access.readsAsCaller(({ url, language, fromMinutes }) =>
    Effect.gen(function* () {
      const transcripts = yield* Transcript.Transcript;
      return yield* transcripts.transcript({ url, language, fromMinutes }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.stage === "url" || error.stage === "range"
                  ? "invalid_request"
                  : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});

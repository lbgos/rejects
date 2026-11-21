import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Transcript from "../../../video/Transcript.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { VideoToolkit } from "./tools.ts";

export const layer = Access.toLayer(VideoToolkit, {
  video_transcript: Access.readsAsCaller(({ url, language, fromMinutes }) =>
    Effect.gen(function* () {
      const transcripts = yield* Transcript.Transcript;
      const scope = yield* Invocation.McpInvocationContext;
      const cache = scope.standalone !== true;
      return yield* transcripts.transcript({ url, language, fromMinutes, cache }).pipe(
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

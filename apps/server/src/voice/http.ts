import { VOICE_TRANSCRIBE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateHttpScope } from "../auth/http.ts";
import * as SpeechToText from "./SpeechToText.ts";

const failure = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status });

/** What MediaRecorder writes: WebM or Ogg Opus, MP4 AAC on iOS; some browsers label it video. */
const RECORDING = /^(?:audio\/[\w.+-]+|video\/(?:webm|mp4))$/;

const STATUS: Record<SpeechToText.SpeechError["reason"], number> = {
  off: 503,
  unavailable: 503,
  rejected: 422,
  empty: 422,
};

const TOO_LONG = `Recordings over ${VOICE_TRANSCRIBE.maxSeconds / 60} minutes are not transcribed.`;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const speech = yield* SpeechToText.SpeechToText;
    return HttpRouter.add(
      "POST",
      VOICE_TRANSCRIBE.path,
      Effect.gen(function* () {
        yield* authenticateHttpScope(VOICE_TRANSCRIBE.scope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const mimeType = (request.headers["content-type"] ?? "")
          .split(";")[0]!
          .trim()
          .toLowerCase();
        if (!RECORDING.test(mimeType)) return failure(415, "Send the recording as audio.");
        if (Number(request.headers["content-length"] ?? 0) > VOICE_TRANSCRIBE.maxBytes)
          return failure(413, TOO_LONG);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const read = yield* request.stream.pipe(
          Stream.runForEach((chunk) => {
            bytes += chunk.length;
            if (bytes > VOICE_TRANSCRIBE.maxBytes) return Effect.fail("too-long" as const);
            chunks.push(chunk);
            return Effect.void;
          }),
          Effect.result,
        );
        if (read._tag === "Failure")
          return read.failure === "too-long"
            ? failure(413, TOO_LONG)
            : failure(400, "Could not read the recording.");
        if (bytes === 0) return failure(400, "The recording is empty.");
        const result = yield* speech
          .transcribe({
            audio: Buffer.concat(chunks),
            mimeType,
            fileName: `dictation.${mimeType.split("/")[1]}`,
            // The paid fallback stays a Telegram opt-in; dictation uses the local backends only.
            cloud: false,
          })
          .pipe(Effect.result);
        if (result._tag === "Failure")
          return failure(STATUS[result.failure.reason], result.failure.message);
        yield* Effect.logInfo("voice.dictation", { backend: result.success.backend, bytes });
        return HttpServerResponse.jsonUnsafe({ text: result.success.text });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);

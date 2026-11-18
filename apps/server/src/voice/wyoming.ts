// @effect-diagnostics nodeBuiltinImport:off - Wyoming is a raw TCP protocol.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const WYOMING_RATE = 16_000;
const FORMAT = { rate: WYOMING_RATE, width: 2, channels: 1 };
const CHUNK_BYTES = 32_000;
const MAX_REPLY_BYTES = 1024 * 1024;

const Header = Schema.Struct({
  type: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  data_length: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  payload_length: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
const decodeData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeTranscript = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));

export class WyomingError extends Schema.TaggedError<WyomingError>()("WyomingError", {
  detail: Schema.String,
}) {}

const encode = (type: string, data?: object, payload: Uint8Array = new Uint8Array()) => {
  const body = Buffer.from(data ? JSON.stringify(data) : "");
  const header = { type, data_length: body.length, payload_length: payload.length };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body, payload]);
};

/** No language goes with the request: the server detects it, which also suits mixed chats. */
function* request(pcm: Uint8Array) {
  yield encode("transcribe");
  yield encode("audio-start", FORMAT);
  for (let at = 0; at < pcm.length; at += CHUNK_BYTES)
    yield encode("audio-chunk", FORMAT, pcm.subarray(at, at + CHUNK_BYTES));
  yield encode("audio-stop");
}

export const wyomingTranscribe = (
  target: { readonly host: string; readonly port: number },
  pcm: Uint8Array,
  deadlineMs: number,
) =>
  Effect.callback<string, WyomingError>((resume) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const socket = new NodeNet.Socket();
    const finish = (result: Effect.Effect<string, WyomingError>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(result);
    };
    const fail = (detail: string) => finish(Effect.fail(new WyomingError({ detail })));
    const frames = request(pcm);
    // Frames go out as the socket drains, so a long note is never queued in memory twice.
    const send = () => {
      for (let next = frames.next(); !next.done; next = frames.next()) {
        if (!socket.write(next.value)) {
          socket.once("drain", send);
          return;
        }
      }
    };
    socket.setTimeout(5_000, () => fail("did not accept the connection"));
    socket.once("connect", () => {
      socket.setTimeout(0);
      send();
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0)
          return pending.length > MAX_REPLY_BYTES ? fail("sent an oversized reply") : undefined;
        const header = decodeHeader(pending.subarray(0, newline).toString("utf8"));
        if (Option.isNone(header)) return fail("sent an invalid reply");
        const dataEnd = newline + 1 + (header.value.data_length ?? 0);
        const end = dataEnd + (header.value.payload_length ?? 0);
        if (end - newline > MAX_REPLY_BYTES) return fail("sent an oversized reply");
        if (pending.length < end) return;
        const data =
          dataEnd > newline + 1
            ? decodeData(pending.subarray(newline + 1, dataEnd).toString("utf8"))
            : Option.some({});
        pending = pending.subarray(end);
        if (Option.isNone(data)) return fail("sent an invalid reply");
        const event = { ...header.value.data, ...data.value };
        if (header.value.type === "error") return fail(`reported ${JSON.stringify(event)}`);
        if (header.value.type !== "transcript") continue;
        const transcript = decodeTranscript(event);
        return Option.isSome(transcript)
          ? finish(Effect.succeed(transcript.value.text))
          : fail("sent a transcript without text");
      }
    });
    socket.once("error", (error) => fail(`is unreachable (${error.message})`));
    socket.once("close", () => fail("closed the connection before the transcript"));
    try {
      socket.connect({ host: target.host, port: target.port });
    } catch (error) {
      fail(`cannot be reached at ${target.host}:${target.port} (${String(error)})`);
    }
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () => Effect.fail(new WyomingError({ detail: "did not answer in time" })),
    }),
  );

/** A serving speech server answers in milliseconds; a stopped one refuses the connection and a busy GPU leaves the port closed, which both come back as `false`. */
export const wyomingReady = (
  target: { readonly host: string; readonly port: number },
  deadlineMs: number,
) =>
  Effect.callback<boolean, WyomingError>((resume) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const socket = new NodeNet.Socket();
    const finish = (result: Effect.Effect<boolean, WyomingError>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(result);
    };
    const fail = (detail: string) => finish(Effect.fail(new WyomingError({ detail })));
    socket.setTimeout(deadlineMs, () => fail("did not answer in time"));
    socket.once("connect", () => socket.write(encode("describe")));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline < 0) {
        if (pending.length > MAX_REPLY_BYTES) fail("sent an oversized reply");
        return;
      }
      const header = decodeHeader(pending.subarray(0, newline).toString("utf8"));
      if (Option.isNone(header)) return fail("sent an invalid reply");
      if (header.value.type === "info") return finish(Effect.succeed(true));
      return fail(`reported ${header.value.type}`);
    });
    socket.once("error", (error) => fail(`is unreachable (${error.message})`));
    socket.once("close", () => fail("closed the connection before its info"));
    try {
      socket.connect({ host: target.host, port: target.port });
    } catch (error) {
      fail(`cannot be reached at ${target.host}:${target.port} (${String(error)})`);
    }
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () => Effect.fail(new WyomingError({ detail: "did not answer in time" })),
    }),
  );

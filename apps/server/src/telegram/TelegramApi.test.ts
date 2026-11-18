import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeTelegramApi } from "./TelegramApi.ts";

const TOKEN = "123456789:AAtest-token-value_ABCDEFGHIJKLMNOPQRST";

const fakeTelegram = HttpClient.make((request, url) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      url.pathname.startsWith("/file/")
        ? new Response(new Uint8Array([1, 2, 3]))
        : Response.json({
            ok: true,
            result: url.pathname.endsWith("/getFile")
              ? { file_path: "documents/a.txt", file_size: 3 }
              : { message_id: 1 },
          }),
    ),
  ),
);

it.effect("keeps the bot token out of trace spans", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const api = makeTelegramApi(fakeTelegram, "https://api.telegram.test", TOKEN);

    yield* api.sendMessage({ chatId: 1, text: "hi" }).pipe(Effect.withTracer(tracer));
    yield* api.download("file-1").pipe(Effect.withTracer(tracer));

    expect(spans.length).toBeGreaterThan(0);
    const recorded = JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]));
    expect(recorded).not.toContain(TOKEN);
  }),
);

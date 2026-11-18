import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
/** Bot API limits: bots download files up to 20 MB and upload up to 50 MB. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_CAPTION_MAX_CHARS = 1024;
const TELEGRAM_TEXT_MAX_CHARS = 4096;
const TELEGRAM_MEDIA = {
  photo: { method: "sendPhoto", field: "photo" },
  video: { method: "sendVideo", field: "video" },
  document: { method: "sendDocument", field: "document" },
} as const;
export type TelegramMediaKind = keyof typeof TELEGRAM_MEDIA;

export class TelegramApiError extends Schema.TaggedError<TelegramApiError>()("TelegramApiError", {
  method: Schema.String,
  status: Schema.Number,
  detail: Schema.String,
  retryAfter: Schema.optional(Schema.Number),
}) {
  override get message() {
    return `Telegram ${this.method}: ${this.detail}`;
  }
}

const User = Schema.Struct({
  id: Schema.Number,
  first_name: Schema.String,
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});
const FileRef = Schema.Struct({
  file_id: Schema.String,
  file_name: Schema.optional(Schema.String),
  mime_type: Schema.optional(Schema.String),
  file_size: Schema.optional(Schema.Number),
});
const PhotoSize = Schema.Struct({
  file_id: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  file_size: Schema.optional(Schema.Number),
});
export const TelegramMessage = Schema.Struct({
  message_id: Schema.Number,
  date: Schema.Number,
  chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  photo: Schema.optional(Schema.Array(PhotoSize)),
  document: Schema.optional(FileRef),
  voice: Schema.optional(FileRef),
  audio: Schema.optional(FileRef),
  video: Schema.optional(FileRef),
});
export type TelegramMessage = typeof TelegramMessage.Type;
export const TelegramCallbackQuery = Schema.Struct({
  id: Schema.String,
  from: User,
  message: Schema.optional(
    Schema.Struct({
      message_id: Schema.Number,
      chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
    }),
  ),
  data: Schema.optional(Schema.String),
});
export type TelegramCallbackQuery = typeof TelegramCallbackQuery.Type;
export const TelegramUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(TelegramMessage),
  callback_query: Schema.optional(TelegramCallbackQuery),
});
export type TelegramUpdate = typeof TelegramUpdate.Type;

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const SentMessage = Schema.Struct({ message_id: Schema.Number });

export const makeTelegramApi = (client: HttpClient.HttpClient, base: string, token: string) => {
  // The bot token sits in every request path, and client spans record it as url.full/url.path.
  const http = HttpClient.transform(client, (effect) =>
    Effect.provideService(effect, HttpClient.TracerDisabledWhen, () => true),
  );
  const url = (method: string) => `${base}/bot${token}/${method}`;
  const call = Effect.fn("TelegramApi.call")(function* <S extends Schema.Top>(
    method: string,
    success: S,
    request: HttpClientRequest.HttpClientRequest,
    timeoutMs = 30_000,
  ) {
    const silent = new TelegramApiError({ method, status: 0, detail: "Telegram did not answer." });
    const response = yield* http.execute(request).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(() => silent),
    );
    const envelope = yield* response.json.pipe(
      Effect.flatMap(decodeEnvelope),
      Effect.mapError(
        () =>
          new TelegramApiError({
            method,
            status: response.status,
            detail: "Telegram sent an unreadable reply.",
          }),
      ),
    );
    if (!envelope.ok)
      return yield* new TelegramApiError({
        method,
        status: envelope.error_code ?? response.status,
        detail: envelope.description ?? "Telegram refused the call.",
        ...(envelope.parameters?.retry_after === undefined
          ? {}
          : { retryAfter: envelope.parameters.retry_after }),
      });
    return yield* Schema.decodeUnknownEffect(success)(envelope.result).pipe(
      Effect.mapError(
        () =>
          new TelegramApiError({
            method,
            status: response.status,
            detail: "Telegram sent an unexpected result.",
          }),
      ),
    );
  });
  const json = <S extends Schema.Top>(
    method: string,
    success: S,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ) =>
    Effect.flatMap(
      HttpClientRequest.post(url(method)).pipe(HttpClientRequest.bodyJson(body), Effect.orDie),
      (request) => call(method, success, request, timeoutMs),
    );
  const upload = Effect.fn("TelegramApi.upload")(function* (
    kind: TelegramMediaKind,
    input: {
      readonly chatId: number;
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
      readonly caption?: string;
    },
  ) {
    const { method, field } = TELEGRAM_MEDIA[kind];
    const form = new FormData();
    form.set("chat_id", String(input.chatId));
    if (input.caption) form.set("caption", input.caption.slice(0, TELEGRAM_CAPTION_MAX_CHARS));
    form.set(field, new Blob([input.bytes], { type: input.mimeType }), input.name);
    return yield* call(
      method,
      SentMessage,
      HttpClientRequest.post(url(method)).pipe(HttpClientRequest.bodyFormData(form)),
      120_000,
    );
  });
  return {
    getMe: json("getMe", User, {}),
    getUpdates: (offset: number, timeoutSeconds: number) =>
      json(
        "getUpdates",
        Schema.Array(TelegramUpdate),
        { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
        (timeoutSeconds + 15) * 1000,
      ),
    sendMessage: (input: {
      readonly chatId: number;
      readonly text: string;
      readonly replyTo?: number;
      readonly buttons?: ReadonlyArray<{ readonly text: string; readonly data: string }>;
    }) =>
      json("sendMessage", SentMessage, {
        chat_id: input.chatId,
        text: input.text,
        link_preview_options: { is_disabled: true },
        ...(input.replyTo === undefined
          ? {}
          : { reply_parameters: { message_id: input.replyTo, allow_sending_without_reply: true } }),
        ...(input.buttons === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: [
                  input.buttons.map((button) => ({
                    text: button.text,
                    callback_data: button.data,
                  })),
                ],
              },
            }),
      }),
    answerCallbackQuery: (id: string, text?: string) =>
      json("answerCallbackQuery", Schema.Boolean, {
        callback_query_id: id,
        ...(text === undefined ? {} : { text }),
      }),
    editMessageText: (chatId: number, messageId: number, text: string) =>
      json("editMessageText", Schema.Unknown, { chat_id: chatId, message_id: messageId, text }),
    deleteMessage: (chatId: number, messageId: number) =>
      json("deleteMessage", Schema.Boolean, { chat_id: chatId, message_id: messageId }),
    sendChatAction: (chatId: number, action: "typing" | "upload_document") =>
      json("sendChatAction", Schema.Boolean, { chat_id: chatId, action }),
    setMessageReaction: (chatId: number, messageId: number, emoji: string) =>
      json("setMessageReaction", Schema.Boolean, {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    download: Effect.fn("TelegramApi.download")(function* (fileId: string) {
      const file = yield* json(
        "getFile",
        Schema.Struct({
          file_path: Schema.optional(Schema.String),
          file_size: Schema.optional(Schema.Number),
        }),
        { file_id: fileId },
      );
      const tooLarge = new TelegramApiError({
        method: "getFile",
        status: 400,
        detail: "file is too big",
      });
      if (!file.file_path || (file.file_size ?? 0) > TELEGRAM_DOWNLOAD_MAX_BYTES)
        return yield* tooLarge;
      const silent = new TelegramApiError({
        method: "download",
        status: 0,
        detail: "Telegram did not send the file.",
      });
      const response = yield* http
        .execute(HttpClientRequest.get(`${base}/file/bot${token}/${file.file_path}`))
        .pipe(
          Effect.timeout(120_000),
          Effect.mapError(() => silent),
        );
      if (response.status !== 200) return yield* silent;
      const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(() => silent)));
      if (bytes.length > TELEGRAM_DOWNLOAD_MAX_BYTES) return yield* tooLarge;
      return bytes;
    }),
    sendDocument: (input: Parameters<typeof upload>[1]) => upload("document", input),
    sendPhoto: (input: Parameters<typeof upload>[1]) => upload("photo", input),
    upload,
    /** Telegram downloads `url` itself: up to 5 MB for a photo, 20 MB for anything else. */
    sendUrl: (
      kind: TelegramMediaKind,
      input: { readonly chatId: number; readonly url: string; readonly caption?: string },
    ) =>
      json(
        TELEGRAM_MEDIA[kind].method,
        SentMessage,
        {
          chat_id: input.chatId,
          [TELEGRAM_MEDIA[kind].field]: input.url,
          ...(input.caption ? { caption: input.caption } : {}),
        },
        120_000,
      ),
  };
};
export type TelegramApi = ReturnType<typeof makeTelegramApi>;

export const splitTelegramText = (text: string, max = TELEGRAM_TEXT_MAX_CHARS): string[] => {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
};

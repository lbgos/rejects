import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Telegram from "../telegram/Telegram.ts";
import { TELEGRAM_UPLOAD_MAX_BYTES, type TelegramMediaKind } from "../telegram/TelegramApi.ts";
import * as Computer from "./BotComputer.ts";
import * as Store from "./BotStore.ts";
import {
  BotAttachmentError,
  readAttachment,
  safeFileName,
  storeAttachment,
} from "./attachments.ts";

const MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  mp4: "video/mp4",
};
const extensionOf = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";
const mimeTypeOf = (name: string) => MIME_TYPES[extensionOf(name)] ?? "application/octet-stream";
/** Telegram plays MP4 inline and shows these images as photos; anything else goes as a document. */
const telegramKindOf = (name: string): TelegramMediaKind => {
  const extension = extensionOf(name);
  if (["jpg", "jpeg", "png", "webp"].includes(extension)) return "photo";
  return extension === "mp4" ? "video" : "document";
};

export interface SendTelegramInput {
  readonly text?: string | undefined;
  readonly path?: string | undefined;
  readonly url?: string | undefined;
  readonly png?: Uint8Array | undefined;
  readonly kind?: TelegramMediaKind | undefined;
  readonly caption?: string | undefined;
  /** False for bots without web tools: a URL would carry what they read to its server. */
  readonly urlAllowed: boolean;
}

export class BotFiles extends Context.Service<
  BotFiles,
  {
    readonly giveFiles: (
      mainThreadId: ThreadId,
      input: { readonly bot: string; readonly files: ReadonlyArray<string> },
    ) => Effect.Effect<
      {
        readonly bot: string;
        readonly threadId: ThreadId;
        readonly files: ReadonlyArray<string>;
        readonly next: string;
      },
      BotAttachmentError
    >;
    readonly share: (
      botThreadId: ThreadId,
      turn: ThreadId,
      input: { readonly path: string; readonly caption?: string | undefined },
    ) => Effect.Effect<{ readonly shared: string; readonly next: string }, BotAttachmentError>;
    readonly sendTelegram: (
      botThreadId: ThreadId,
      turn: ThreadId,
      input: SendTelegramInput,
    ) => Effect.Effect<{ readonly sent: string; readonly next: string }, BotAttachmentError>;
  }
>()("t3/bots/BotFiles") {}

const make = Effect.gen(function* () {
  const bots = yield* Store.BotStore;
  const computer = yield* Computer.BotComputer;
  const threads = yield* Threads.ThreadManagementService;
  const telegram = yield* Telegram.Telegram;
  const crypto = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const fail = (detail: string) => new BotAttachmentError({ detail });

  const workFile = Effect.fn("BotFiles.workFile")(function* (
    botThreadId: ThreadId,
    path: string,
    maxBytes: number,
  ) {
    const result = yield* computer
      .getFile(botThreadId, path, maxBytes)
      .pipe(Effect.mapError((cause) => new BotAttachmentError({ detail: cause.message, cause })));
    if (result.ok) return result.bytes;
    return yield* fail(
      {
        missing: `No file at ${path}.`,
        outside: "Send files from your work dir or ~/shared only.",
        notfile: `${path} is not a file.`,
        large: `${path} is over ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      }[result.reason],
    );
  });

  return BotFiles.of({
    sendTelegram: Effect.fn("BotFiles.sendTelegram")(function* (botThreadId, turn, input) {
      const given =
        [input.text, input.path, input.url].filter((v) => v?.trim()).length +
        (input.png === undefined ? 0 : 1);
      if (given !== 1) return yield* fail("Give exactly one of text, path, url or html.");
      if (input.url?.trim() && !input.urlAllowed)
        return yield* fail("You cannot send URLs. Send a file from your work dir instead.");
      const caption = input.caption;
      const message: Telegram.TelegramOutgoing = input.text?.trim()
        ? { type: "text", text: input.text.trim() }
        : input.png !== undefined
          ? {
              type: "file",
              kind: "photo",
              name: "chart.png",
              mimeType: "image/png",
              bytes: input.png,
              caption,
            }
          : input.url?.trim()
            ? {
                type: "url",
                kind: input.kind ?? telegramKindOf(input.url.trim().split(/[?#]/)[0]!),
                url: input.url.trim(),
                caption,
              }
            : {
                type: "file",
                kind: input.kind ?? telegramKindOf(input.path!),
                name: safeFileName(input.path!),
                mimeType: mimeTypeOf(input.path!),
                bytes: yield* workFile(botThreadId, input.path!.trim(), TELEGRAM_UPLOAD_MAX_BYTES),
                caption,
              };
      if (message.type === "url" && !/^https?:\/\//i.test(message.url))
        return yield* fail("url must start with https:// or http://.");
      yield* telegram
        .sendToOwner(botThreadId, message)
        .pipe(Effect.mapError((cause) => new BotAttachmentError({ detail: cause.detail, cause })));
      yield* bots.sentToTelegram(turn);
      return {
        sent:
          message.type === "text" ? "text" : message.type === "file" ? message.name : message.url,
        next: "Sent; this is the user's notification. Do not call notify_user or send it again. On a wake, reply with the message itself, not that you sent it; in a chat, say so in one line.",
      };
    }),

    giveFiles: Effect.fn("BotFiles.giveFiles")(function* (mainThreadId, input) {
      const mainId = yield* bots.mainBot;
      const main = mainId === mainThreadId ? yield* bots.get(mainThreadId) : undefined;
      if (!main) return yield* fail("Only the main bot gives files to other bots.");
      const roster = (yield* bots.list.pipe(
        Effect.mapError((cause) => new BotAttachmentError({ detail: cause.message, cause })),
      )).filter((bot) => bot.threadId !== main.threadId && !bot.standalone);
      const wanted = input.bot.trim().toLowerCase();
      const target = roster.find(
        (bot) => bot.name.toLowerCase() === wanted || bot.threadId === input.bot.trim(),
      );
      if (!target)
        return yield* fail(
          `No bot named ${input.bot}. Bots: ${roster.map((bot) => bot.name).join(", ") || "none"}.`,
        );
      // Only files sent in the main bot's own chat qualify; their names come from there.
      const sent = (yield* threads
        .getThreadRecords(main.threadId, ["messages"], {
          messageRoles: ["user"],
          turnItemTypes: [],
        })
        .pipe(
          Effect.mapError(
            (cause) => new BotAttachmentError({ detail: "Could not read this chat.", cause }),
          ),
        )).messages.flatMap((message) => message.attachments);
      const paths: Array<string> = [];
      for (const fileId of new Set(input.files)) {
        const attachment = sent.find((a) => a.id === fileId);
        if (!attachment) return yield* fail(`No file ${fileId} in this chat.`);
        // Passing a file reads it whole; larger files go to the bot's own chat.
        if (attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
          return yield* fail(
            `${attachment.name} is over 50 MB. Ask the user to send it in ${target.name}'s chat.`,
          );
        const bytes = yield* provide(readAttachment(main.threadId, attachment.id));
        const placed = yield* computer
          .putFile(target.threadId, safeFileName(attachment.name), bytes)
          .pipe(
            Effect.mapError((cause) => new BotAttachmentError({ detail: cause.message, cause })),
          );
        if (placed === undefined)
          return yield* fail("Files need the bot computer, which is off on this server.");
        paths.push(placed);
      }
      return {
        bot: target.name,
        threadId: target.threadId,
        files: paths,
        next: `Name these paths in the task you t3_thread_send to ${target.name} (thread ${target.threadId}).`,
      };
    }),
    share: Effect.fn("BotFiles.share")(function* (botThreadId, turn, input) {
      const bot = yield* bots.get(botThreadId);
      if (!bot) return yield* fail("Only a bot shares files.");
      const result = yield* computer
        .getFile(botThreadId, input.path, PROVIDER_SEND_TURN_MAX_FILE_BYTES)
        .pipe(Effect.mapError((cause) => new BotAttachmentError({ detail: cause.message, cause })));
      if (!result.ok)
        return yield* fail(
          {
            missing: `No file at ${input.path}.`,
            outside: "Share files from your work dir or ~/shared only.",
            notfile: `${input.path} is not a file.`,
            large: `${input.path} is over 50 MB.`,
          }[result.reason],
        );
      const name = safeFileName(input.path);
      const attachment = yield* provide(
        storeAttachment({
          threadId: bot.threadId,
          name,
          mimeType: mimeTypeOf(name),
          bytes: result.bytes,
        }),
      );
      const id = `bots:share:${yield* crypto.uuidV4().pipe(Effect.orDie)}`;
      yield* threads
        .dispatch({
          type: "message.record",
          commandId: CommandId.make(id),
          threadId: bot.threadId,
          messageId: MessageId.make(id),
          text: input.caption?.trim() || name,
          attachments: [attachment],
        })
        .pipe(
          Effect.mapError(
            (cause) => new BotAttachmentError({ detail: "Could not post the file.", cause }),
          ),
        );
      if (yield* telegram.fileShared(bot.threadId, attachment)) yield* bots.sentToTelegram(turn);
      return {
        shared: name,
        next: "The user has the file in this chat. Do not paste its content.",
      };
    }),
  });
});

export const layer = Layer.effect(BotFiles, make);

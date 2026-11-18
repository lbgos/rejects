/** This service decides nothing a model decides: it moves messages. */
import {
  type BotRecord,
  type BotSummary,
  ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type TelegramClaim,
  type TelegramState,
  TELEGRAM_MESSAGE_PREFIX,
  type ThreadId,
  emojiOnlyReply,
  isReactionEcho,
} from "@t3tools/contracts";
import { resolveT3McpToolName } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no hash.
import * as NodeCrypto from "node:crypto";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BotStore from "../bots/BotStore.ts";
import { readAttachment, safeFileName, storeAttachment } from "../bots/attachments.ts";
import { chatLanguageOf, type ChatLanguage } from "../bots/language.ts";
import * as ServerConfig from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Speech from "../voice/SpeechToText.ts";
import { telegramReaction } from "./telegramReaction.ts";
import {
  makeTelegramApi,
  splitTelegramText,
  TELEGRAM_API_BASE,
  TELEGRAM_CAPTION_MAX_CHARS,
  TELEGRAM_DOWNLOAD_MAX_BYTES,
  type TelegramMediaKind,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_UPLOAD_MAX_BYTES,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from "./TelegramApi.ts";

export const TOKEN_SECRET = "telegram-bot-token";
const CLAIM_MS = 15 * 60_000;
const POLL_SECONDS = 50;
const TYPING_EVERY_MS = 4_500;
const TYPING_MAX_MS = 15 * 60_000;
const VOICE_GIVE_UP_MS = 24 * 3_600_000;
const OUTBOX_GIVE_UP_MS = 24 * 3_600_000;
const INBOUND_TRIES = 3;
/** The Create button's data under a main bot's proposal: this prefix and the client-only nonce. */
const APPROVE = "approve:";
const isTransient = (error: TelegramApiError) =>
  error.status === 0 || error.status === 429 || error.status >= 500;

const telegramMessageId = (chatId: number, messageId: number) =>
  MessageId.make(`${TELEGRAM_MESSAGE_PREFIX}${chatId}:${messageId}`);
const parseTelegramMessageId = (id: string) => {
  const match = /^tg:(-?\d+):(\d+)$/.exec(id);
  return match ? { chatId: Number(match[1]), messageId: Number(match[2]) } : undefined;
};

const VoiceNote = Schema.Struct({
  chatId: Schema.Number,
  messageId: Schema.Number,
  file: Schema.String,
  mimeType: Schema.String,
  at: Schema.Number,
});
type VoiceNote = typeof VoiceNote.Type;
const Stored = Schema.Struct({
  botUsername: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Schema.Struct({ chatId: Schema.Number, name: Schema.String })),
  claim: Schema.NullOr(Schema.Struct({ hash: Schema.String, expiresAt: Schema.Number })),
  offset: Schema.Number,
  error: Schema.NullOr(Schema.String),
  filesNow: Schema.Boolean,
  cloudVoice: Schema.Boolean,
  apiBase: Schema.optional(Schema.String),
  pending: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ attachment: ChatAttachment, at: Schema.Number })),
  ),
  outbox: Schema.Array(
    Schema.Struct({
      chatId: Schema.Number,
      text: Schema.String,
      replyTo: Schema.optional(Schema.Number),
      at: Schema.Number,
    }),
  ),
  voice: Schema.Array(VoiceNote),
});
type Stored = typeof Stored.Type;
const initial: Stored = {
  botUsername: null,
  owner: null,
  claim: null,
  offset: 0,
  error: null,
  filesNow: true,
  cloudVoice: false,
  pending: {},
  outbox: [],
  voice: [],
};
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Stored));
const decodeToolInput = Schema.decodeUnknownOption(
  Schema.Struct({ emoji: Schema.optional(Schema.String), text: Schema.optional(Schema.String) }),
);
const isApiError = Schema.is(TelegramApiError);
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Stored));

export type TelegramOutgoing =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      readonly kind: TelegramMediaKind;
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
      readonly caption?: string | undefined;
    }
  | {
      readonly type: "url";
      readonly kind: TelegramMediaKind;
      readonly url: string;
      readonly caption?: string | undefined;
    };

const refusal = (error: TelegramApiError) => {
  const detail = error.detail;
  if (error.status === 0) return "Telegram did not answer. Try again later.";
  if (error.status === 429)
    return `Telegram asks to wait${error.retryAfter ? ` ${error.retryAfter} s` : ""}. Try again later.`;
  if (error.status === 413 || /too (big|large)/i.test(detail))
    return "Telegram refused the file as too large: bots upload up to 50 MB, and Telegram fetches a URL up to 20 MB (5 MB for a photo).";
  if (/PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_.*INVALID/i.test(detail))
    return "Telegram refused the photo's size or shape. Send it as a document.";
  if (/HTTP URL|web page content|failed to get/i.test(detail))
    return "Telegram could not fetch that URL. It must be public and point straight at the file, up to 20 MB (5 MB for a photo); else download it to your work dir and send the file.";
  if (/caption is too long/i.test(detail))
    return `Telegram takes captions up to ${TELEGRAM_CAPTION_MAX_CHARS} characters. Shorten it or send the text as its own message.`;
  return `Telegram refused it: ${detail}`;
};
export const TELEGRAM_NOT_LINKED =
  "Telegram is not linked. Give the user the file here with share_file instead.";

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const hashCode = (code: string) =>
  NodeCrypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
/** Eight letters and digits a person can type: no 0/O or 1/I. */
const newCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(NodeCrypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
};

const lines = {
  connected: (bot: string | undefined) => ({
    en: bot
      ? `Connected. Messages here go to ${bot}.`
      : "Connected. Pick the main bot on the web under You → Telegram.",
    ru: bot
      ? `Подключено. Сообщения отсюда идут боту ${bot}.`
      : "Подключено. Выберите главного бота на сайте: You → Telegram.",
    uk: bot
      ? `Підключено. Повідомлення звідси йдуть боту ${bot}.`
      : "Підключено. Виберіть головного бота на сайті: You → Telegram.",
  }),
  noMainBot: {
    en: "No main bot is chosen. Pick one on the web under You → Telegram.",
    ru: "Главный бот не выбран. Выберите его на сайте: You → Telegram.",
    uk: "Головного бота не вибрано. Виберіть його на сайті: You → Telegram.",
  },
  tooLarge: (name: string) => ({
    en: `${name} is over 20 MB, which Telegram does not let bots download. Send it on the web.`,
    ru: `${name} больше 20 МБ: Telegram не даёт ботам скачивать такие файлы. Отправьте его на сайте.`,
    uk: `${name} більший за 20 МБ: Telegram не дає ботам завантажувати такі файли. Надішліть його на сайті.`,
  }),
  notDownloaded: (name: string) => ({
    en: `Could not download ${name} from Telegram.`,
    ru: `Не удалось скачать ${name} из Telegram.`,
    uk: `Не вдалося завантажити ${name} з Telegram.`,
  }),
  voiceQueued: {
    en: "🎤 Speech recognition is offline. This voice note waits and goes on once it is back.",
    ru: "🎤 Распознавание речи недоступно. Голосовое подождёт и уйдёт, когда оно вернётся.",
    uk: "🎤 Розпізнавання мовлення недоступне. Голосове зачекає і піде, коли воно повернеться.",
  },
  voiceFailed: {
    en: "🎤 No speech was recognized in this voice note.",
    ru: "🎤 В этом голосовом не удалось распознать речь.",
    uk: "🎤 У цьому голосовому не вдалося розпізнати мовлення.",
  },
  voiceOff: {
    en: "🎤 Voice notes are not set up on this server. Send text instead.",
    ru: "🎤 Голосовые на этом сервере не настроены. Напишите текстом.",
    uk: "🎤 Голосові на цьому сервері не налаштовані. Напишіть текстом.",
  },
  voiceGaveUp: {
    en: "🎤 Speech recognition stayed offline for a day; this voice note was dropped.",
    ru: "🎤 Распознавание речи не работало сутки; это голосовое отброшено.",
    uk: "🎤 Розпізнавання мовлення не працювало добу; це голосове відкинуто.",
  },
  runFailed: (detail: string) => ({
    en: `Run failed: ${detail}`,
    ru: `Сбой: ${detail}`,
    uk: `Збій: ${detail}`,
  }),
  stopped: { en: "Stopped.", ru: "Остановлено.", uk: "Зупинено." },
  create: { en: "Create", ru: "Создать", uk: "Створити" },
  tapCreate: {
    en: "Tap Create to make these bots.",
    ru: "Нажмите «Создать», чтобы создать этих ботов.",
    uk: "Натисніть «Створити», щоб створити цих ботів.",
  },
  staleProposal: {
    en: "This proposal is out of date. Ask the bot again.",
    ru: "Это предложение устарело. Попросите бота ещё раз.",
    uk: "Ця пропозиція застаріла. Попросіть бота ще раз.",
  },
  createNotSent: {
    en: "Approved, but the Create message did not reach the bot. Tap Create again.",
    ru: "Одобрено, но сообщение «Создать» не дошло до бота. Нажмите «Создать» ещё раз.",
    uk: "Схвалено, але повідомлення «Створити» не дійшло до бота. Натисніть «Створити» ще раз.",
  },
};

export class Telegram extends Context.Service<
  Telegram,
  {
    readonly state: Effect.Effect<TelegramState>;
    readonly connect: (token: string) => Effect.Effect<TelegramClaim, TelegramError>;
    readonly newCode: Effect.Effect<TelegramClaim, TelegramError>;
    readonly configure: (input: {
      readonly mainBot?: ThreadId | null | undefined;
      readonly filesNow?: boolean | undefined;
      readonly cloudVoice?: boolean | undefined;
      readonly cloudVoiceKey?: string | undefined;
    }) => Effect.Effect<TelegramState, TelegramError>;
    readonly disconnect: Effect.Effect<TelegramState, TelegramError>;
    readonly fileShared: (
      botThreadId: ThreadId,
      attachment: ChatAttachment,
    ) => Effect.Effect<boolean>;
    readonly sendToOwner: (
      botThreadId: ThreadId,
      message: TelegramOutgoing,
    ) => Effect.Effect<void, TelegramError>;
    readonly poll: (timeoutSeconds: number) => Effect.Effect<void, TelegramError>;
    readonly deliver: Effect.Effect<void>;
    readonly retryVoice: Effect.Effect<void>;
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/telegram/Telegram") {}

interface ActiveRun {
  readonly chatId: number;
  readonly messageId: number;
  statusMessageId: number | null;
  statusText: string | null;
  reacted: string | null;
  proposal: string | null;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const bots = yield* BotStore.BotStore;
  const threads = yield* Threads.ThreadManagementService;
  const speech = yield* Speech.SpeechToText;
  const file = path.join(config.stateDir, "telegram.json");
  const voiceDir = path.join(config.stateDir, "telegram-voice");
  const lock = yield* Semaphore.make(1);
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, config),
    );

  let stored = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeStored),
    Effect.catch((cause) =>
      cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
        ? Effect.succeed(initial)
        : Effect.logWarning("telegram.json is unreadable; Telegram starts fresh.").pipe(
            Effect.as(initial),
          ),
    ),
  );
  const save = (next: Stored) =>
    encodeStored(next).pipe(
      Effect.flatMap((contents) =>
        provide(writeFileStringAtomically({ filePath: file, contents })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          stored = next;
        }),
      ),
      Effect.mapError(
        (cause) => new TelegramError({ detail: "Could not save Telegram settings.", cause }),
      ),
    );
  const update = (change: (current: Stored) => Stored) =>
    lock.withPermit(Effect.suspend(() => save(change(stored))));
  const recordError = (detail: string) =>
    stored.error === detail
      ? Effect.void
      : update((current) => ({ ...current, error: detail })).pipe(Effect.ignore);

  const readToken = secrets.get(TOKEN_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const apiFor = (token: string) =>
    makeTelegramApi(http, stored.apiBase ?? TELEGRAM_API_BASE, token);
  let api: TelegramApi | undefined = Option.match(yield* readToken, {
    onNone: () => undefined,
    onSome: apiFor,
  });

  const mainBot = Effect.gen(function* () {
    const id = yield* bots.mainBot;
    return id === undefined ? undefined : yield* bots.get(id);
  });
  const language = (main: BotRecord | undefined) =>
    main ? chatLanguageOf(threads, main.threadId) : Effect.succeed<ChatLanguage>("en");
  const sendText = Effect.fn("Telegram.sendText")(function* (
    chatId: number,
    text: string,
    replyTo?: number,
    buttons?: ReadonlyArray<{ readonly text: string; readonly data: string }>,
  ) {
    const split = splitTelegramText(text);
    const parts = split.map((part, index) => ({
      chatId,
      text: part,
      ...(index === 0 && replyTo !== undefined ? { replyTo } : {}),
      ...(index === split.length - 1 && buttons !== undefined ? { buttons } : {}),
    }));
    for (const [index, part] of parts.entries()) {
      if (!api) return;
      const sent = yield* api.sendMessage(part).pipe(Effect.result);
      if (sent._tag === "Success") continue;
      yield* Effect.logWarning("telegram.send-failed", { detail: sent.failure.detail });
      if (!isTransient(sent.failure)) continue;
      const at = yield* Clock.currentTimeMillis;
      yield* update((current) => ({
        ...current,
        outbox: [
          ...current.outbox,
          ...parts.slice(index).map(({ chatId, text, replyTo }) => ({
            chatId,
            text,
            ...(replyTo === undefined ? {} : { replyTo }),
            at,
          })),
        ].slice(-100),
      }));
      return;
    }
  });
  const flushOutbox = Effect.fn("Telegram.flushOutbox")(function* () {
    const now = yield* Clock.currentTimeMillis;
    while (api && stored.outbox.length > 0) {
      const { at, replyTo, ...next } = stored.outbox[0]!;
      const sent =
        now - at > OUTBOX_GIVE_UP_MS
          ? undefined
          : yield* api
              .sendMessage({ ...next, ...(replyTo === undefined ? {} : { replyTo }) })
              .pipe(Effect.result);
      if (sent?._tag === "Failure" && isTransient(sent.failure)) return;
      yield* update((current) => ({ ...current, outbox: current.outbox.slice(1) }));
    }
  });
  const say = Effect.fn("Telegram.say")(function* (
    chatId: number,
    text: Record<ChatLanguage, string>,
    replyTo?: number,
  ) {
    if (!api) return;
    const lang = yield* language(yield* mainBot);
    yield* sendText(chatId, text[lang], replyTo);
  });

  const state: Effect.Effect<TelegramState> = Effect.gen(function* () {
    const hasKey = Option.isSome(
      yield* secrets.get(Speech.CLOUD_VOICE_KEY).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      connected: api !== undefined,
      botUsername: stored.botUsername,
      owner: stored.owner,
      claimExpiresAt:
        stored.claim && stored.claim.expiresAt > now
          ? DateTime.formatIso(DateTime.makeUnsafe(stored.claim.expiresAt))
          : null,
      error: stored.error,
      mainBot: (yield* bots.mainBot) ?? null,
      filesNow: stored.filesNow,
      voiceQueued: stored.voice.length,
      cloudVoice: stored.cloudVoice,
      cloudVoiceKey: hasKey,
    };
  });

  const claim = Effect.fn("Telegram.claim")(function* () {
    const code = newCode();
    const expiresAt = (yield* Clock.currentTimeMillis) + CLAIM_MS;
    yield* update((current) => ({ ...current, claim: { hash: hashCode(code), expiresAt } }));
    const username = stored.botUsername ?? "";
    return {
      state: yield* state,
      code,
      link: `https://t.me/${username}?start=${code}`,
    };
  });

  const typing = yield* FiberMap.make<string>();
  const startTyping = (chatId: number, key: string) =>
    api
      ? FiberMap.run(
          typing,
          key,
          api
            .sendChatAction(chatId, "typing")
            .pipe(
              Effect.ignore,
              Effect.repeat(Schedule.spaced(Duration.millis(TYPING_EVERY_MS))),
              Effect.timeout(Duration.millis(TYPING_MAX_MS)),
              Effect.ignore,
            ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid)
      : Effect.void;

  const toMain = Effect.fn("Telegram.toMain")(function* (
    main: BotRecord,
    message: Pick<TelegramMessage, "message_id"> & { readonly chat: { readonly id: number } },
    text: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const id = telegramMessageId(message.chat.id, message.message_id);
    yield* threads.sendToThread({
      projectId: main.projectId,
      commandId: CommandId.make(`telegram:send:${id}`),
      threadId: main.threadId,
      messageId: id,
      text,
      attachments,
      mode: "queue",
      createdBy: "user",
      creationSource: "server",
    });
    yield* startTyping(message.chat.id, id);
  });

  const download = Effect.fn("Telegram.download")(function* (
    message: TelegramMessage,
    ref: { readonly file_id: string; readonly file_size?: number | undefined },
    name: string,
  ) {
    if (!api) return undefined;
    if ((ref.file_size ?? 0) > TELEGRAM_DOWNLOAD_MAX_BYTES) {
      yield* say(message.chat.id, lines.tooLarge(name), message.message_id);
      return undefined;
    }
    const bytes = yield* api.download(ref.file_id).pipe(Effect.option);
    if (Option.isNone(bytes))
      yield* say(message.chat.id, lines.notDownloaded(name), message.message_id);
    return Option.getOrUndefined(bytes);
  });

  const transcribeVoice = Effect.fn("Telegram.transcribeVoice")(function* (
    note: VoiceNote,
    audio: Uint8Array,
  ) {
    const result = yield* speech
      .transcribe({
        audio,
        mimeType: note.mimeType,
        fileName: note.file,
        cloud: stored.cloudVoice,
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") return result.failure;
    const main = yield* mainBot;
    if (!main) {
      yield* say(note.chatId, lines.noMainBot, note.messageId);
      return undefined;
    }
    const text = `🎤 ${result.success.text}`;
    yield* sendText(note.chatId, text, note.messageId);
    yield* toMain(main, { chat: { id: note.chatId }, message_id: note.messageId }, text, []);
    return undefined;
  });

  const inbound = Effect.fn("Telegram.inbound")(function* (message: TelegramMessage) {
    const chatId = message.chat.id;
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(message.text ?? "");
    if (start?.[1] && stored.claim && message.chat.type === "private") {
      const now = yield* Clock.currentTimeMillis;
      if (stored.claim.expiresAt > now && hashCode(start[1]) === stored.claim.hash) {
        const name =
          [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") ||
          (message.from?.username ?? String(chatId));
        yield* update((current) => ({
          ...current,
          owner: { chatId, name },
          claim: null,
          pending: {},
          outbox: [],
        }));
        yield* say(chatId, lines.connected((yield* mainBot)?.name));
        return;
      }
    }
    if (stored.owner === null || chatId !== stored.owner.chatId) return;
    if (start) {
      yield* say(chatId, lines.connected((yield* mainBot)?.name));
      return;
    }
    const main = yield* mainBot;
    if (!main) {
      yield* say(chatId, lines.noMainBot, message.message_id);
      return;
    }
    if (message.voice) {
      const audio = yield* download(message, message.voice, "voice");
      if (!audio) return;
      const note: VoiceNote = {
        chatId,
        messageId: message.message_id,
        file: `${chatId}-${message.message_id}.oga`,
        mimeType: message.voice.mime_type ?? "audio/ogg",
        at: yield* Clock.currentTimeMillis,
      };
      const failure = yield* transcribeVoice(note, audio);
      if (failure?.reason === "unavailable") {
        yield* provide(
          fs
            .makeDirectory(voiceDir, { recursive: true })
            .pipe(Effect.andThen(fs.writeFile(path.join(voiceDir, note.file), audio))),
        ).pipe(
          Effect.mapError(
            (cause) => new TelegramError({ detail: "Could not queue the voice note.", cause }),
          ),
        );
        yield* update((current) => ({ ...current, voice: [...current.voice, note] }));
        yield* say(chatId, lines.voiceQueued, message.message_id);
      } else if (failure?.reason === "off") yield* say(chatId, lines.voiceOff, message.message_id);
      else if (failure) yield* say(chatId, lines.voiceFailed, message.message_id);
      return;
    }
    const files: Array<{
      readonly ref: { readonly file_id: string; readonly file_size?: number | undefined };
      readonly name: string;
      readonly mimeType: string;
    }> = [];
    const photo = message.photo?.at(-1);
    if (photo)
      files.push({ ref: photo, name: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg" });
    for (const ref of [message.document, message.audio, message.video])
      if (ref)
        files.push({
          ref,
          name: safeFileName(ref.file_name ?? `file-${message.message_id}`),
          mimeType: ref.mime_type ?? "application/octet-stream",
        });
    const attachments: Array<ChatAttachment> = [];
    for (const item of files) {
      const bytes = yield* download(message, item.ref, item.name);
      if (!bytes) continue;
      const saved = yield* provide(
        storeAttachment({
          threadId: main.threadId,
          name: item.name,
          mimeType: item.mimeType,
          bytes,
        }),
      ).pipe(Effect.option);
      if (Option.isSome(saved)) attachments.push(saved.value);
    }
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text && attachments.length === 0) return;
    yield* toMain(main, message, text, attachments);
  });

  const tapped = Effect.fn("Telegram.tapped")(function* (query: TelegramCallbackQuery) {
    if (!api || stored.owner === null || query.from.id !== stored.owner.chatId) return;
    const answer = (text?: string) =>
      api
        ? api.answerCallbackQuery(query.id, text).pipe(Effect.ignore({ log: true }))
        : Effect.void;
    const nonce = query.data?.startsWith(APPROVE) ? query.data.slice(APPROVE.length) : "";
    const main = yield* mainBot;
    // A button forwarded to another chat is not the owner tapping it.
    if (!nonce || !main || !query.message || query.message.chat.id !== stored.owner.chatId)
      return yield* answer();
    const lang = yield* language(main);
    const proposal = (yield* bots.onboarding).proposal;
    // The same id `toMain` sends, so only that message can use the approval.
    const messageId = telegramMessageId(query.message.chat.id, query.message.message_id);
    if (
      proposal === undefined ||
      !(yield* BotStore.approveProposal(bots, proposal.id, nonce, messageId))
    )
      return yield* answer(lines.staleProposal[lang]);
    // An approval without its Create message would let a later turn make the bots unasked.
    yield* toMain(main, query.message, lines.create[lang], []).pipe(
      Effect.andThen(answer()),
      Effect.catchCause((cause) =>
        BotStore.releaseProposal(bots, proposal.id).pipe(
          Effect.andThen(answer(lines.createNotSent[lang])),
          Effect.andThen(Effect.logWarning("telegram.create-not-sent", { cause })),
        ),
      ),
    );
  });

  const inboundTries = new Map<number, number>();
  const poll = Effect.fn("Telegram.poll")(function* (timeoutSeconds: number) {
    if (!api) return;
    const updates = yield* api.getUpdates(stored.offset, timeoutSeconds).pipe(
      Effect.mapError(
        (error) =>
          new TelegramError({
            detail:
              error.status === 401
                ? "Telegram refused the bot token. Connect it again."
                : error.status === 409
                  ? "Another program reads this bot's updates. Stop it, or make a new bot."
                  : error.detail,
            cause: error,
          }),
      ),
      Effect.tapError((error) => recordError(error.detail)),
    );
    // A poll that answered clears an error an earlier one left, even when it brought no updates.
    if (stored.error !== null) yield* update((current) => ({ ...current, error: null }));
    for (const item of updates) {
      const handled = item.message
        ? yield* Effect.exit(inbound(item.message))
        : item.callback_query
          ? yield* Effect.exit(tapped(item.callback_query))
          : undefined;
      if (handled?._tag === "Failure") {
        yield* Effect.logWarning("telegram.inbound-failed", {
          updateId: item.update_id,
          cause: handled.cause,
        });
        // The offset stays, so Telegram sends the message again; sends to the thread are idempotent.
        const tries = (inboundTries.get(item.update_id) ?? 0) + 1;
        if (tries < INBOUND_TRIES) {
          inboundTries.set(item.update_id, tries);
          return yield* new TelegramError({
            detail: "A Telegram message did not reach the bot yet.",
          });
        }
      }
      inboundTries.delete(item.update_id);
      yield* update((current) => ({ ...current, offset: item.update_id + 1, error: null }));
    }
  });

  const sendFile = Effect.fn("Telegram.sendFile")(function* (
    chatId: number,
    botThreadId: ThreadId,
    attachment: ChatAttachment,
    caption: string | undefined,
  ) {
    if (!api) return false;
    if (attachment.sizeBytes > TELEGRAM_UPLOAD_MAX_BYTES) return true;
    const bytes = yield* provide(readAttachment(botThreadId, attachment.id)).pipe(Effect.option);
    if (Option.isNone(bytes)) return true;
    const input = {
      chatId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      bytes: bytes.value,
      ...(caption ? { caption } : {}),
    };
    const sent = yield* (
      attachment.type === "image" ? api.sendPhoto(input) : api.sendDocument(input)
    ).pipe(Effect.result);
    if (sent._tag === "Success") return true;
    yield* Effect.logWarning("telegram.file-failed", { detail: sent.failure.detail });
    return !isTransient(sent.failure);
  });

  const dropPending = (
    botThreadId: ThreadId,
    keep: (file: Stored["pending"][string][number]) => boolean,
  ) =>
    update((current) => {
      const { [botThreadId]: files = [], ...others } = current.pending;
      const kept = files.filter(keep);
      return { ...current, pending: kept.length ? { ...others, [botThreadId]: kept } : others };
    });

  const flushFiles = Effect.fn("Telegram.flushFiles")(function* (
    chatId: number,
    bot: Pick<BotRecord, "threadId" | "name">,
    withName: boolean,
  ) {
    for (const file of stored.pending[bot.threadId] ?? []) {
      const done = yield* sendFile(
        chatId,
        bot.threadId,
        file.attachment,
        withName ? bot.name : undefined,
      );
      if (!done) return;
      yield* dropPending(bot.threadId, (kept) => kept.attachment.id !== file.attachment.id);
    }
  });

  const deliver = Effect.gen(function* () {
    if (!api || !stored.owner) return;
    yield* flushOutbox();
    const list = yield* bots.list.pipe(Effect.orElseSucceed((): readonly BotSummary[] => []));
    for (const bot of list) {
      const readAt = bot.notifiedAt ? Date.parse(bot.notifiedAt) : 0;
      if (!bot.unread && stored.pending[bot.threadId]?.some((file) => file.at < readAt))
        yield* dropPending(bot.threadId, (file) => file.at >= readAt);
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("telegram.deliver-failed", { cause })));

  const retryVoice = Effect.gen(function* () {
    for (const note of stored.voice) {
      const audioPath = path.join(voiceDir, note.file);
      const drop = Effect.gen(function* () {
        yield* update((current) => ({
          ...current,
          voice: current.voice.filter((v) => v.file !== note.file),
        }));
        yield* fs.remove(audioPath).pipe(Effect.ignore);
      });
      const audio = yield* fs.readFile(audioPath).pipe(Effect.option);
      if (Option.isNone(audio)) {
        yield* drop;
        continue;
      }
      const failure = yield* transcribeVoice(note, audio.value);
      if (failure?.reason === "unavailable") {
        if ((yield* Clock.currentTimeMillis) - note.at < VOICE_GIVE_UP_MS) return;
        yield* say(note.chatId, lines.voiceGaveUp, note.messageId);
      } else if (failure?.reason === "off") yield* say(note.chatId, lines.voiceOff, note.messageId);
      else if (failure) yield* say(note.chatId, lines.voiceFailed, note.messageId);
      yield* drop;
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("telegram.voice-retry-failed", { cause })),
  );

  const active = new Map<RunId, ActiveRun>();
  const answered = new Set<RunId>();
  const handleEvent = Effect.fn("Telegram.handleEvent")(
    function* (event: OrchestrationV2DomainEvent) {
      if (!api) return;
      if (event.type === "run.updated") {
        const run = event.payload;
        const origin = parseTelegramMessageId(run.userMessageId);
        if (!origin) return;
        if (!Threads.isTerminalRunStatus(run.status)) {
          if (!active.has(run.id)) {
            // The reply goes back to Telegram: it is this turn's notification, so no push.
            yield* bots.sentToTelegram(run.threadId);
            active.set(run.id, {
              ...origin,
              statusMessageId: null,
              statusText: null,
              reacted: null,
              proposal: null,
            });
          }
          return;
        }
        // A finished run keeps getting updates, such as its checkpoint; it is answered once.
        if (answered.has(run.id)) return;
        answered.add(run.id);
        if (answered.size > 500) answered.delete(answered.values().next().value!);
        const current = active.get(run.id) ?? {
          ...origin,
          statusMessageId: null,
          statusText: null,
          reacted: null,
          proposal: null,
        };
        active.delete(run.id);
        yield* FiberMap.remove(typing, run.userMessageId);
        if (current.statusMessageId !== null)
          yield* api
            .deleteMessage(origin.chatId, current.statusMessageId)
            .pipe(Effect.ignore({ log: true }));
        const main = yield* mainBot;
        if (run.status === "completed") {
          const replies = (yield* threads.getThreadRecords(run.threadId, ["messages"], {
            messageRunIds: [run.id],
            messageRoles: ["assistant"],
          })).messages.filter((m) => !m.streaming && m.text.trim());
          const lone = emojiOnlyReply(replies.at(-1)?.text ?? "");
          if (lone && current.reacted === null)
            yield* api
              .setMessageReaction(origin.chatId, origin.messageId, telegramReaction(lone))
              .pipe(Effect.ignore({ log: true }));
          // The turn's last message is its answer, as in the web chat; earlier text narrated the work.
          const answer =
            replies
              .filter(
                (m, index) =>
                  !(lone && index === replies.length - 1) &&
                  !(current.reacted !== null && isReactionEcho(m.text)),
              )
              .at(-1)
              ?.text.trim() ?? "";
          // The nonce, so a forwarded button approves nothing without the owner's chat.
          const pending = (yield* bots.onboarding).proposal;
          const buttons =
            current.proposal === null ||
            pending?.id !== current.proposal ||
            pending.nonce === undefined
              ? undefined
              : [
                  {
                    text: lines.create[yield* language(main)],
                    data: `${APPROVE}${pending.nonce}`,
                  },
                ];
          if (answer || buttons)
            yield* sendText(
              origin.chatId,
              answer || lines.tapCreate[yield* language(main)],
              origin.messageId,
              buttons,
            );
        } else if (run.status === "failed") {
          const error = (yield* threads.getThreadShell(run.threadId))?.lastError
            ?.trim()
            .split("\n")[0];
          yield* say(
            origin.chatId,
            lines.runFailed(error?.slice(0, 200) ?? "no error reported."),
            origin.messageId,
          );
        } else if (run.status === "interrupted" || run.status === "cancelled")
          yield* say(origin.chatId, lines.stopped, origin.messageId);
        if (main && main.threadId === run.threadId) yield* flushFiles(origin.chatId, main, false);
        return;
      }
      if (event.type !== "turn-item.updated" || event.payload.type !== "dynamic_tool") return;
      const item = event.payload;
      const run = item.runId === null ? undefined : active.get(item.runId);
      const tool = item.toolName === null ? null : resolveT3McpToolName(item.toolName);
      if (!run || item.status !== "completed") return;
      if (tool === "propose_bots") {
        run.proposal = compactDynamicToolOutput(item.output)?.proposalId ?? run.proposal;
        return;
      }
      if (tool !== "react" && tool !== "status") return;
      const input = decodeToolInput(item.input);
      if (Option.isNone(input)) return;
      if (tool === "react" && input.value.emoji) {
        // Each call replaces the reaction; the same one twice is not sent twice.
        const emoji = telegramReaction(input.value.emoji);
        if (run.reacted === emoji) return;
        run.reacted = emoji;
        yield* api
          .setMessageReaction(run.chatId, run.messageId, emoji)
          .pipe(Effect.ignore({ log: true }));
        return;
      }
      const text = input.value.text?.trim().slice(0, 200);
      if (tool !== "status" || !text || text === run.statusText) return;
      run.statusText = text;
      if (run.statusMessageId === null) {
        const sent = yield* api
          .sendMessage({ chatId: run.chatId, text: `⏳ ${text}` })
          .pipe(Effect.option);
        if (Option.isSome(sent)) run.statusMessageId = sent.value.message_id;
      } else
        yield* api
          .editMessageText(run.chatId, run.statusMessageId, `⏳ ${text}`)
          .pipe(Effect.ignore({ log: true }));
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("telegram.event-failed", { cause })),
      ),
  );

  const polling = yield* FiberHandle.make<void, never>();
  const loop = Effect.gen(function* () {
    let backoff = 5_000;
    while (api) {
      const result = yield* poll(POLL_SECONDS).pipe(Effect.result);
      if (result._tag === "Success") {
        backoff = 5_000;
        continue;
      }
      const cause = result.failure.cause;
      const apiError = isApiError(cause) ? cause : undefined;
      const status = apiError?.status ?? 0;
      yield* recordError(result.failure.detail);
      if (status === 401) {
        api = undefined;
        return;
      }
      const retryAfter = apiError?.retryAfter;
      yield* Effect.sleep(Duration.millis(retryAfter ? retryAfter * 1000 : backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  });
  let started = false;
  const restartPolling = Effect.suspend(() =>
    started ? FiberHandle.run(polling, loop).pipe(Effect.asVoid) : Effect.void,
  );

  const connect = Effect.fn("Telegram.connect")(function* (raw: string) {
    const token = raw.trim();
    if (!/^\d+:[\w-]+$/.test(token))
      return yield* new TelegramError({
        detail: "That is not a bot token. Copy it from BotFather.",
      });
    const candidate = apiFor(token);
    const me = yield* candidate.getMe.pipe(
      Effect.mapError(
        (cause) =>
          new TelegramError({
            detail:
              cause.status === 401 || cause.status === 404
                ? "Telegram does not know this token."
                : "Telegram did not answer. Try again.",
            cause,
          }),
      ),
    );
    yield* secrets
      .set(TOKEN_SECRET, new TextEncoder().encode(token))
      .pipe(
        Effect.mapError(
          (cause) => new TelegramError({ detail: "Could not save the token.", cause }),
        ),
      );
    yield* FiberHandle.clear(polling);
    api = candidate;
    yield* update((current) => ({
      ...current,
      botUsername: me.username ?? null,
      owner: null,
      error: null,
      offset: 0,
    }));
    yield* restartPolling;
    return yield* claim();
  });

  const fileShared = Effect.fn("Telegram.fileShared")(
    function* (botThreadId: ThreadId, attachment: ChatAttachment) {
      const owner = stored.owner;
      if (!api || !owner) return false;
      const bot = yield* bots.get(botThreadId);
      if (!bot) return false;
      if (stored.filesNow) {
        const main = yield* bots.mainBot;
        const done = yield* sendFile(
          owner.chatId,
          botThreadId,
          attachment,
          main === botThreadId ? undefined : bot.name,
        );
        if (done) return true;
      }
      const at = yield* Clock.currentTimeMillis;
      yield* update((current) => ({
        ...current,
        pending: {
          ...current.pending,
          [botThreadId]: [...(current.pending[botThreadId] ?? []), { attachment, at }].slice(-20),
        },
      }));
      return false;
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telegram.file-failed", { cause }).pipe(Effect.as(false)),
        ),
      ),
  );

  const sendToOwner = Effect.fn("Telegram.sendToOwner")(function* (
    botThreadId: ThreadId,
    message: TelegramOutgoing,
  ) {
    const owner = stored.owner;
    const client = api;
    if (!client || !owner) return yield* new TelegramError({ detail: TELEGRAM_NOT_LINKED });
    const bot = yield* bots.get(botThreadId);
    if (!bot) return yield* new TelegramError({ detail: "Only a bot sends to Telegram." });
    const main = (yield* bots.mainBot) === botThreadId;
    const refused = (cause: TelegramApiError) =>
      new TelegramError({ detail: refusal(cause), cause });
    const fail = (detail: string) => new TelegramError({ detail });
    if (message.type === "text") {
      for (const part of splitTelegramText(main ? message.text : `${bot.name}:\n${message.text}`))
        yield* client
          .sendMessage({ chatId: owner.chatId, text: part })
          .pipe(Effect.mapError(refused));
      return;
    }
    const given = message.caption?.trim() || undefined;
    const caption = main ? given : given ? `${bot.name}: ${given}` : bot.name;
    if (caption !== undefined && caption.length > TELEGRAM_CAPTION_MAX_CHARS)
      return yield* fail(
        `Telegram takes captions up to ${TELEGRAM_CAPTION_MAX_CHARS} characters${main ? "" : ", your name included"}. Shorten it or send the text as its own message.`,
      );
    const withCaption = caption === undefined ? {} : { caption };
    if (message.type === "url") {
      yield* client
        .sendUrl(message.kind, { chatId: owner.chatId, url: message.url, ...withCaption })
        .pipe(Effect.mapError(refused));
      return;
    }
    if (message.bytes.length > TELEGRAM_UPLOAD_MAX_BYTES)
      return yield* fail(
        `${message.name} is over 50 MB, the most Telegram takes from a bot. Make it smaller or split it.`,
      );
    if (message.kind === "photo" && message.bytes.length > TELEGRAM_PHOTO_MAX_BYTES)
      return yield* fail(
        `${message.name} is over 10 MB, the most Telegram takes as a photo. Send it as a document.`,
      );
    yield* client
      .upload(message.kind, {
        chatId: owner.chatId,
        name: message.name,
        mimeType: message.mimeType,
        bytes: message.bytes,
        ...withCaption,
      })
      .pipe(Effect.mapError(refused));
  });

  return Telegram.of({
    state,
    sendToOwner,
    connect,
    newCode: Effect.suspend(() =>
      api ? claim() : Effect.fail(new TelegramError({ detail: "Connect a bot token first." })),
    ),
    configure: Effect.fn("Telegram.configure")(function* (input) {
      if (input.mainBot !== undefined)
        yield* bots
          .setMainBot(input.mainBot)
          .pipe(
            Effect.mapError(
              (cause) => new TelegramError({ detail: "That bot does not exist.", cause }),
            ),
          );
      if (input.cloudVoiceKey !== undefined)
        yield* (
          input.cloudVoiceKey.trim()
            ? secrets.set(
                Speech.CLOUD_VOICE_KEY,
                new TextEncoder().encode(input.cloudVoiceKey.trim()),
              )
            : secrets.remove(Speech.CLOUD_VOICE_KEY)
        ).pipe(
          Effect.mapError(
            (cause) => new TelegramError({ detail: "Could not save the key.", cause }),
          ),
        );
      yield* update((current) => ({
        ...current,
        ...(input.filesNow === undefined ? {} : { filesNow: input.filesNow }),
        ...(input.cloudVoice === undefined ? {} : { cloudVoice: input.cloudVoice }),
      }));
      return yield* state;
    }),
    disconnect: Effect.gen(function* () {
      yield* FiberHandle.clear(polling);
      yield* FiberMap.clear(typing);
      api = undefined;
      active.clear();
      yield* secrets
        .remove(TOKEN_SECRET)
        .pipe(
          Effect.mapError(
            (cause) => new TelegramError({ detail: "Could not remove the token.", cause }),
          ),
        );
      yield* update((current) => ({
        ...current,
        botUsername: null,
        owner: null,
        claim: null,
        error: null,
        offset: 0,
        pending: {},
        outbox: [],
      }));
      return yield* state;
    }),
    fileShared,
    poll,
    deliver,
    retryVoice,
    handleEvent,
    start: Effect.fn("Telegram.start")(function* () {
      started = true;
      yield* restartPolling;
      yield* deliver.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
      yield* retryVoice.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
      yield* threads.streamDomainEvents.pipe(
        Stream.runForEach(handleEvent),
        Effect.tapCause((cause) => Effect.logWarning("telegram.events-failed", { cause })),
        Effect.retry(Schedule.spaced("5 seconds")),
        Effect.forkScoped,
      );
    }),
  });
});

export const layer = Layer.effect(Telegram, make);

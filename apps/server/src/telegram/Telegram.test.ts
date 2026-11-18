// @effect-diagnostics nodeBuiltinImport:off - a fake Bot API on a local port stands in for Telegram.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotSummary,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BotStore from "../bots/BotStore.ts";
import { storeAttachment } from "../bots/attachments.ts";
import * as ServerConfig from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Speech from "../voice/SpeechToText.ts";
import * as Telegram from "./Telegram.ts";
import { splitTelegramText, type TelegramUpdate } from "./TelegramApi.ts";

const TOKEN = "123:secret";
const OWNER = 7;
const STRANGER = 99;
const MAIN = ThreadId.make("main");
const RESEARCH = ThreadId.make("research");
const RUN = RunId.make("run-1");
const at = DateTime.makeUnsafe(0);

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const fakeBotApi = Effect.acquireRelease(
  Effect.promise(async () => {
    const calls: Call[] = [];
    const updates: TelegramUpdate[] = [];
    const failNext: string[] = [];
    const refuseNext = new Map<string, string>();
    const files = new Map<string, Uint8Array>();
    let nextMessageId = 500;
    const server = NodeHttp.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(request.url ?? "");
      if (download) {
        const bytes = download[1] === TOKEN ? files.get(download[2]!) : undefined;
        if (!bytes) return reply(404, { ok: false, error_code: 404 });
        response.writeHead(200);
        return response.end(bytes);
      }
      const call = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "");
      if (call?.[1] !== TOKEN)
        return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
      const type = request.headers["content-type"] ?? "";
      const body: Record<string, unknown> = type.startsWith("multipart/")
        ? Object.fromEntries(
            [...(await new Response(raw, { headers: { "content-type": type } }).formData())].map(
              ([key, value]) => [key, typeof value === "string" ? value : value.name],
            ),
          )
        : JSON.parse(raw.toString("utf8") || "{}");
      const method = call[2]!;
      if (failNext.includes(method)) {
        failNext.splice(failNext.indexOf(method), 1);
        return reply(502, { ok: false, error_code: 502, description: "Bad Gateway" });
      }
      calls.push({ method, body });
      const refused = refuseNext.get(method);
      if (refused !== undefined) {
        refuseNext.delete(method);
        return reply(400, { ok: false, error_code: 400, description: refused });
      }
      switch (method) {
        case "getMe":
          return reply(200, {
            ok: true,
            result: { id: 1, is_bot: true, first_name: "Main", username: "main_test_bot" },
          });
        case "getUpdates":
          return reply(200, {
            ok: true,
            result: updates.filter((u) => u.update_id >= Number(body.offset ?? 0)),
          });
        case "getFile": {
          const id = String(body.file_id);
          return reply(200, {
            ok: true,
            result: { file_id: id, file_path: id, file_size: files.get(id)?.length },
          });
        }
        case "sendMessage":
        case "sendDocument":
        case "sendPhoto":
        case "sendVideo":
          return reply(200, { ok: true, result: { message_id: nextMessageId++ } });
        default:
          return reply(200, { ok: true, result: true });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as NodeNet.AddressInfo;
    const sent = () =>
      calls
        .filter((c) => !["getMe", "getUpdates", "getFile", "sendChatAction"].includes(c.method))
        .map(({ method, body }): Record<string, unknown> => {
          const { link_preview_options: _preview, ...rest } = body;
          return { method, ...rest };
        });
    return {
      url: `http://127.0.0.1:${port}`,
      calls,
      updates,
      failNext,
      refuseNext,
      files,
      sent,
      server,
    };
  }),
  (fake) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          fake.server.closeAllConnections();
          fake.server.close(() => resolve());
        }),
    ),
);

const bot = (threadId: ThreadId, name: string, extra: Partial<BotSummary> = {}): BotSummary => ({
  name,
  persona: name,
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
  threadId,
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-01T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
  tokensToday: 0,
  usage: [],
  stopped: false,
  resumesAt: null,
  ...extra,
});

const message = (
  id: number,
  chat: number,
  fields: Omit<TelegramUpdate["message"] & object, "message_id" | "date" | "chat">,
): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: chat, type: "private" },
    from: { id: chat, first_name: chat === OWNER ? "Ann" : "Eve" },
    ...fields,
  },
});

const runUpdated = (
  status: OrchestrationV2RunStatus,
  userMessageId = `tg:${OWNER}:12`,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${status}`),
  type: "run.updated",
  threadId: MAIN,
  occurredAt: at,
  payload: {
    id: RUN,
    threadId: MAIN,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("opencode"),
    modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

const toolCall = (
  toolName: string,
  input: unknown,
  output: unknown = null,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${toolName}`),
  type: "turn-item.updated",
  threadId: MAIN,
  occurredAt: at,
  payload: {
    id: TurnItemId.make(`item:${toolName}`),
    threadId: MAIN,
    runId: RUN,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input,
    output,
  },
});

const tap = (
  id: number,
  from: number,
  data: string,
  messageId: number,
  chatId = from,
): TelegramUpdate => ({
  update_id: id,
  callback_query: {
    id: `query-${id}`,
    from: { id: from, first_name: from === OWNER ? "Ann" : "Eve" },
    message: { message_id: messageId, chat: { id: chatId, type: "private" } },
    data,
  },
});

const withTelegram = <A, E>(
  options: { readonly paired?: boolean; readonly filesNow?: boolean },
  body: (input: {
    readonly telegram: Telegram.Telegram["Service"];
    readonly fake: Effect.Success<typeof fakeBotApi>;
    readonly world: ReturnType<typeof makeWorld>;
  }) => Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fake = yield* fakeBotApi;
    const world = makeWorld();
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paired = options.paired ?? true;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(config.stateDir, "telegram.json"),
      JSON.stringify({
        botUsername: paired ? "main_test_bot" : null,
        owner: paired ? { chatId: OWNER, name: "Ann" } : null,
        claim: null,
        offset: 0,
        error: null,
        filesNow: options.filesNow ?? true,
        cloudVoice: false,
        apiBase: fake.url,
        pending: {},
        outbox: [],
        voice: [],
      }),
    );
    if (paired) world.secrets.set(Telegram.TOKEN_SECRET, new TextEncoder().encode(TOKEN));
    return yield* Telegram.Telegram.pipe(
      Effect.flatMap((telegram) => body({ telegram, fake, world })),
      Effect.provide(Telegram.layer.pipe(Layer.provide(mocks(world)))),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-telegram-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const makeWorld = () => ({
  secrets: new Map<string, Uint8Array>(),
  mainBot: MAIN as ThreadId | undefined,
  bots: [bot(MAIN, "Main"), bot(RESEARCH, "Research")],
  sent: [] as Array<Threads.ThreadManagementSendInput>,
  answer: "" as string | ReadonlyArray<string>,
  failSends: 0,
  speech: [] as Array<ReturnType<Speech.SpeechToText["Service"]["transcribe"]>>,
  telegramTurns: [] as ThreadId[],
  onboarding: {} as BotStore.Onboarding,
});

const mocks = (world: ReturnType<typeof makeWorld>) =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromNullishOr(world.secrets.get(name))),
      set: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
      remove: (name) => Effect.sync(() => void world.secrets.delete(name)),
    }),
    Layer.mock(BotStore.BotStore)({
      mainBot: Effect.sync(() => world.mainBot),
      get: (id) => Effect.sync(() => world.bots.find((b) => b.threadId === id)),
      list: Effect.sync(() => world.bots),
      sentToTelegram: (id) => Effect.sync(() => void world.telegramTurns.push(id)),
      onboarding: Effect.sync(() => world.onboarding),
      updateOnboarding: (change) =>
        Effect.sync(() => (world.onboarding = change(world.onboarding))),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      sendToThread: (input) =>
        world.failSends-- > 0
          ? Effect.die(new Error("The thread is busy."))
          : Effect.sync(() => {
              world.sent.push(input);
              return {} as never;
            }),
      getThreadRecords: (threadId, _fields, filter) =>
        Effect.succeed({
          messages: filter?.messageRunIds
            ? [world.answer].flat().flatMap((text, n) =>
                text
                  ? [
                      {
                        id: MessageId.make(`answer-${n}`),
                        threadId,
                        runId: RUN,
                        nodeId: null,
                        role: "assistant" as const,
                        text,
                        attachments: [],
                        streaming: false,
                        createdAt: at,
                        updatedAt: at,
                      },
                    ]
                  : [],
              )
            : [],
        } as never),
      getThreadShell: () => Effect.succeed(null),
    }),
    Layer.mock(Speech.SpeechToText)({
      transcribe: () =>
        world.speech.shift() ??
        Effect.fail(new Speech.SpeechError({ reason: "unavailable", detail: "Nemotron is down." })),
    }),
  );

it.live("pairs the owner by a one-time code and ignores everyone else", () =>
  withTelegram({ paired: false }, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      const claim = yield* telegram.connect(TOKEN);
      assert.strictEqual(claim.link, `https://t.me/main_test_bot?start=${claim.code}`);
      fake.updates.push(
        message(1, STRANGER, { text: "hello" }),
        message(2, STRANGER, { text: "/start WRONGCODE" }),
        message(3, OWNER, { text: `/start ${claim.code}` }),
      );
      yield* telegram.poll(0);
      fake.updates.push(
        message(4, STRANGER, { text: `/start ${claim.code}` }),
        message(5, OWNER, { text: "status?" }),
      );
      yield* telegram.poll(0);

      assert.deepEqual((yield* telegram.state).owner, { chatId: OWNER, name: "Ann" });
      assert.deepEqual(fake.sent(), [
        { method: "sendMessage", chat_id: OWNER, text: "Connected. Messages here go to Main." },
      ]);
      assert.deepEqual(
        world.sent.map(({ threadId, messageId, text, mode, createdBy }) => ({
          threadId,
          messageId,
          text,
          mode,
          createdBy,
        })),
        [
          {
            threadId: MAIN,
            messageId: `tg:${OWNER}:5`,
            text: "status?",
            mode: "queue",
            createdBy: "user",
          },
        ],
      );
    }),
  ),
);

it.live("brings the owner's files into the main bot and queues voice while speech is down", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      fake.files.set("doc", new TextEncoder().encode("%PDF-1"));
      fake.files.set("voice", new Uint8Array([1, 2, 3]));
      fake.updates.push(
        message(20, OWNER, {
          caption: "summarize",
          document: { file_id: "doc", file_name: "report.pdf", mime_type: "application/pdf" },
        }),
        message(21, OWNER, {
          document: { file_id: "big", file_name: "big.zip", file_size: 21 * 1024 * 1024 },
        }),
        message(22, OWNER, { voice: { file_id: "voice", mime_type: "audio/ogg" } }),
      );
      yield* telegram.poll(0);
      assert.strictEqual((yield* telegram.state).voiceQueued, 1);

      world.speech.push(Effect.succeed({ text: "Привет", backend: "nemotron" }));
      yield* telegram.retryVoice;

      assert.strictEqual((yield* telegram.state).voiceQueued, 0);
      assert.deepEqual(
        world.sent.map(({ messageId, text, attachments }) => ({
          messageId,
          text,
          files: attachments?.map(({ type, name, mimeType, sizeBytes }) => ({
            type,
            name,
            mimeType,
            sizeBytes,
          })),
        })),
        [
          {
            messageId: `tg:${OWNER}:20`,
            text: "summarize",
            files: [
              { type: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 6 },
            ],
          },
          { messageId: `tg:${OWNER}:22`, text: "🎤 Привет", files: [] },
        ],
      );
      const replyTo = (id: number) => ({ message_id: id, allow_sending_without_reply: true });
      assert.deepEqual(fake.sent(), [
        {
          method: "sendMessage",
          chat_id: OWNER,
          text: "big.zip is over 20 MB, which Telegram does not let bots download. Send it on the web.",
          reply_parameters: replyTo(21),
        },
        {
          method: "sendMessage",
          chat_id: OWNER,
          text: "🎤 Speech recognition is offline. This voice note waits and goes on once it is back.",
          reply_parameters: replyTo(22),
        },
        { method: "sendMessage", chat_id: OWNER, text: "🎤 Привет", reply_parameters: replyTo(22) },
      ]);
    }),
  ),
);

it.live("answers a Telegram run with one status line, a reaction and the reply", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      yield* telegram.handleEvent(toolCall("mcp__t3-code__status", { text: "Reading files" }));
      yield* telegram.handleEvent(toolCall("mcp__t3-code__status", { text: "Writing" }));
      yield* telegram.handleEvent(toolCall("t3-code.react", { emoji: "✅" }));
      world.answer = ["Reading the files first.", "Done: 3 files."];
      yield* telegram.handleEvent(runUpdated("completed"));
      yield* telegram.handleEvent(runUpdated("completed"));
      yield* telegram.handleEvent(runUpdated("completed", "user:1"));

      assert.deepEqual(fake.sent(), [
        { method: "sendMessage", chat_id: OWNER, text: "⏳ Reading files" },
        { method: "editMessageText", chat_id: OWNER, message_id: 500, text: "⏳ Writing" },
        {
          method: "setMessageReaction",
          chat_id: OWNER,
          message_id: 12,
          reaction: [{ type: "emoji", emoji: "👌" }],
        },
        { method: "deleteMessage", chat_id: OWNER, message_id: 500 },
        {
          method: "sendMessage",
          chat_id: OWNER,
          text: "Done: 3 files.",
          reply_parameters: { message_id: 12, allow_sending_without_reply: true },
        },
      ]);
    }),
  ),
);

it.live("puts Create under the main bot's proposal and approves it on the owner's tap", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      world.onboarding = {
        proposal: {
          id: "p-1",
          nonce: "n-1",
          botThreadId: MAIN,
          bots: [{ template: "mail", name: "Mail" }],
        },
      };
      yield* telegram.handleEvent(runUpdated("running"));
      const result = { content: [{ type: "text", text: JSON.stringify({ proposalId: "p-1" }) }] };
      yield* telegram.handleEvent(
        toolCall("mcp__t3-code__propose_bots", { templates: ["mail"] }, result),
      );
      world.answer = "I suggest Mail: it sorts your inbox.";
      yield* telegram.handleEvent(runUpdated("completed"));
      assert.deepEqual(fake.sent(), [
        {
          method: "sendMessage",
          chat_id: OWNER,
          text: "I suggest Mail: it sorts your inbox.",
          reply_parameters: { message_id: 12, allow_sending_without_reply: true },
          reply_markup: { inline_keyboard: [[{ text: "Create", callback_data: "approve:n-1" }]] },
        },
      ]);

      fake.calls.length = 0;
      fake.updates.push(
        tap(20, STRANGER, "approve:n-1", 500),
        tap(21, OWNER, "approve:old", 500),
        tap(23, OWNER, "approve:n-1", 500, 555),
        tap(22, OWNER, "approve:n-1", 500),
      );
      yield* telegram.poll(0);
      assert.deepEqual(fake.sent(), [
        {
          method: "answerCallbackQuery",
          callback_query_id: "query-21",
          text: "This proposal is out of date. Ask the bot again.",
        },
        { method: "answerCallbackQuery", callback_query_id: "query-23" },
        { method: "answerCallbackQuery", callback_query_id: "query-22" },
      ]);
      assert.strictEqual(world.onboarding.proposal?.approved, true);
      assert.deepEqual(
        world.sent.map((sent) => [sent.threadId, sent.messageId, sent.text, sent.createdBy]),
        [[MAIN, `tg:${OWNER}:500`, "Create", "user"]],
      );
    }),
  ),
);

it.live("drops the approval when the Create message does not reach the bot", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      world.onboarding = {
        proposal: {
          id: "p-1",
          nonce: "n-1",
          botThreadId: MAIN,
          bots: [{ template: "mail", name: "Mail" }],
          approved: true,
        },
      };
      world.failSends = 1;
      fake.updates.push(tap(30, OWNER, "approve:n-1", 500));
      yield* telegram.poll(0);
      assert.deepEqual(fake.sent(), [
        {
          method: "answerCallbackQuery",
          callback_query_id: "query-30",
          text: "Approved, but the Create message did not reach the bot. Tap Create again.",
        },
      ]);
      assert.isUndefined(world.onboarding.proposal?.approved);
    }),
  ),
);

it.live("maps any emoji to one Telegram allows", () =>
  withTelegram({}, ({ telegram, fake }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      // ⏰ and 🚲 are not on Telegram's list: ⏰ has a near match, 🚲 falls back to 👍.
      // ✍️ carries a variation selector that Telegram's own ✍ lacks.
      for (const [name, emoji] of [
        ["mcp__t3-code__react", "⏰"],
        ["t3-code.react", "✍️"],
        ["t3-code-thread_1_react", "🫡"],
        ["mcp__t3-code__react", "🚲"],
      ] as const)
        yield* telegram.handleEvent(toolCall(name, { emoji }));

      assert.deepEqual(
        fake.sent().map((call) => call.reaction),
        ["🫡", "✍", "🫡", "👍"].map((emoji) => [{ type: "emoji", emoji }]),
      );
    }),
  ),
);

it.live("a second reaction replaces the first, and a reaction-only run sends no text", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      yield* telegram.handleEvent(toolCall("mcp__t3-code__react", { emoji: "👀" }));
      yield* telegram.handleEvent(toolCall("t3-code.react", { emoji: "⏰" }));
      world.answer = "⏰";
      yield* telegram.handleEvent(runUpdated("completed"));

      assert.deepEqual(
        fake.sent().map((call) => [call.method, call.reaction]),
        [
          ["setMessageReaction", [{ type: "emoji", emoji: "👀" }]],
          ["setMessageReaction", [{ type: "emoji", emoji: "🫡" }]],
        ],
      );
    }),
  ),
);

it.live("repeated reactions make one Telegram call; a lone emoji reply is a reaction", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      for (const emoji of ["⏰", "⏰", "⏰"])
        yield* telegram.handleEvent(toolCall("mcp__t3-code__react", { emoji }));
      world.answer = "Disk is 91% full.";
      yield* telegram.handleEvent(runUpdated("completed"));
      assert.deepEqual(
        fake.sent().map((call) => [call.method, call.reaction ?? call.text]),
        [
          ["setMessageReaction", [{ type: "emoji", emoji: "🫡" }]],
          ["sendMessage", "Disk is 91% full."],
        ],
      );
    }),
  ),
);

it.live("a final reply of one emoji becomes the reaction, with no text sent", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      world.answer = " 👍 ";
      yield* telegram.handleEvent(runUpdated("completed"));
      assert.deepEqual(fake.sent(), [
        {
          method: "setMessageReaction",
          chat_id: OWNER,
          message_id: 12,
          reaction: [{ type: "emoji", emoji: "👍" }],
        },
      ]);
    }),
  ),
);

it.live("never sends an unread bot result on its own, queued files included", () =>
  withTelegram({ filesNow: false }, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const notifiedAt = DateTime.formatIso(DateTime.makeUnsafe(now - 60_000));
      world.bots = [
        bot(MAIN, "Main", { unread: true, notifiedAt, lastNotification: "Математика в 10:20" }),
        bot(RESEARCH, "Research", { unread: true, notifiedAt, lastNotification: "Report ready" }),
      ];
      const csv = yield* storeAttachment({
        threadId: RESEARCH,
        name: "report.csv",
        mimeType: "text/csv",
        bytes: new TextEncoder().encode("a,b\n"),
      });
      yield* telegram.fileShared(RESEARCH, csv);
      yield* telegram.deliver;
      yield* telegram.deliver;
      assert.deepEqual(fake.sent(), []);
    }),
  ),
);

it.live("a turn that answers a Telegram message sends no push", () =>
  withTelegram({}, ({ telegram, world }) =>
    Effect.gen(function* () {
      yield* telegram.handleEvent(runUpdated("running"));
      yield* telegram.handleEvent(runUpdated("running"));
      assert.deepEqual(world.telegramTurns, [MAIN]);
    }),
  ),
);

it.live("retries what the thread or Telegram did not take", () =>
  withTelegram({}, ({ telegram, fake, world }) =>
    Effect.gen(function* () {
      world.failSends = 1;
      fake.updates.push(message(30, OWNER, { text: "hi" }));
      assert.strictEqual((yield* telegram.poll(0).pipe(Effect.result))._tag, "Failure");
      yield* telegram.poll(0);
      assert.deepEqual(
        world.sent.map((sent) => sent.messageId),
        [`tg:${OWNER}:30`],
      );

      fake.failNext.push("sendMessage");
      world.answer = "Done.";
      yield* telegram.handleEvent(runUpdated("running"));
      yield* telegram.handleEvent(runUpdated("completed"));
      assert.deepEqual(fake.sent(), []);
      yield* telegram.deliver;
      yield* telegram.deliver;
      assert.deepEqual(fake.sent(), [
        {
          method: "sendMessage",
          chat_id: OWNER,
          text: "Done.",
          reply_parameters: { message_id: 12, allow_sending_without_reply: true },
        },
      ]);
    }),
  ),
);

it.live("clears a failed poll's error after the next successful one", () =>
  withTelegram({}, ({ telegram, fake }) =>
    Effect.gen(function* () {
      fake.failNext.push("getUpdates");
      yield* Effect.flip(telegram.poll(0));
      assert.equal((yield* telegram.state).error, "Bad Gateway");
      yield* telegram.poll(0);
      assert.isNull((yield* telegram.state).error);
    }),
  ),
);

it.live("sends a bot's send_telegram to the owner's chat, named unless it is the main bot", () =>
  withTelegram({}, ({ telegram, fake }) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([1, 2, 3]);
      yield* telegram.sendToOwner(MAIN, { type: "text", text: "Done" });
      yield* telegram.sendToOwner(RESEARCH, {
        type: "file",
        kind: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        bytes,
        caption: "Trip",
      });
      yield* telegram.sendToOwner(RESEARCH, {
        type: "url",
        kind: "photo",
        url: "https://example.com/a.jpg",
      });
      yield* telegram.sendToOwner(MAIN, {
        type: "file",
        kind: "photo",
        name: "chart.png",
        mimeType: "image/png",
        bytes,
        caption: "3090: 690 USD",
      });
      assert.deepEqual(fake.sent(), [
        { method: "sendMessage", chat_id: OWNER, text: "Done" },
        {
          method: "sendVideo",
          chat_id: String(OWNER),
          caption: "Research: Trip",
          video: "clip.mp4",
        },
        {
          method: "sendPhoto",
          chat_id: OWNER,
          photo: "https://example.com/a.jpg",
          caption: "Research",
        },
        {
          method: "sendPhoto",
          chat_id: String(OWNER),
          caption: "3090: 690 USD",
          photo: "chart.png",
        },
      ]);
    }),
  ),
);

it.live("refuses what Telegram would not take with a line for the bot", () =>
  withTelegram({}, ({ telegram, fake }) =>
    Effect.gen(function* () {
      const file = (kind: "photo" | "document", size: number, caption?: string) =>
        telegram
          .sendToOwner(MAIN, {
            type: "file",
            kind,
            name: "big.bin",
            mimeType: "application/octet-stream",
            bytes: new Uint8Array(size),
            caption,
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.detail),
          );
      assert.match(yield* file("document", 50 * 1024 * 1024 + 1), /over 50 MB/);
      assert.match(yield* file("photo", 10 * 1024 * 1024 + 1), /as a document/);
      assert.match(yield* file("document", 1, "x".repeat(1025)), /captions up to 1024/);
      fake.refuseNext.set("sendPhoto", "Bad Request: PHOTO_INVALID_DIMENSIONS");
      assert.match(yield* file("photo", 1), /size or shape\. Send it as a document/);
      fake.refuseNext.set("sendVideo", "Bad Request: failed to get HTTP URL content");
      const url = yield* telegram
        .sendToOwner(MAIN, { type: "url", kind: "video", url: "https://example.com/v.mp4" })
        .pipe(Effect.flip);
      assert.match(url.detail, /could not fetch that URL/);
      assert.deepEqual(
        fake.sent().map((call) => call.method),
        ["sendPhoto", "sendVideo"],
      );
    }),
  ),
);

it.live("tells the bot when Telegram is not linked", () =>
  withTelegram({ paired: false }, ({ telegram }) =>
    Effect.gen(function* () {
      const error = yield* telegram
        .sendToOwner(MAIN, { type: "text", text: "hi" })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, Telegram.TELEGRAM_NOT_LINKED);
    }),
  ),
);

it("splits long text at line breaks within Telegram's limit", () => {
  const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
  assert.deepEqual(splitTelegramText(text), ["a".repeat(3000), "b".repeat(3000)]);
  assert.deepEqual(
    splitTelegramText("c".repeat(5000)).map((part) => part.length),
    [4096, 904],
  );
});

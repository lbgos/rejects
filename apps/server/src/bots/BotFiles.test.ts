import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { BotFilesToolkit } from "../mcp/toolkits/botFiles/tools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Telegram from "../telegram/Telegram.ts";
import * as BotFiles from "./BotFiles.ts";
import * as Computer from "./BotComputer.ts";
import * as Store from "./BotStore.ts";
import { storeAttachment } from "./attachments.ts";

const BOT = ThreadId.make("hardware");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const setup = (
  mocks: {
    readonly bots?: Partial<Store.BotStore["Service"]>;
    readonly computer?: Partial<Computer.BotComputer["Service"]>;
    readonly threads?: Partial<Threads.ThreadManagementService["Service"]>;
  } = {},
) => {
  const sent: Array<Telegram.TelegramOutgoing> = [];
  const notified: Array<ThreadId> = [];
  const layer = BotFiles.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Store.BotStore)({
          sentToTelegram: (id) => Effect.sync(() => void notified.push(id)),
          ...mocks.bots,
        }),
        Layer.mock(Computer.BotComputer)({ ...mocks.computer }),
        Layer.mock(Threads.ThreadManagementService)({ ...mocks.threads }),
        Layer.mock(Telegram.Telegram)({
          sendToOwner: (_, message) => Effect.sync(() => void sent.push(message)),
        }),
      ),
    ),
    // The test stores the user's file where the service reads it.
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-files-" })),
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
  return { sent, notified, layer };
};

it.effect("sends a rendered chart as a photo with its caption and marks the turn notified", () => {
  const { sent, notified, layer } = setup();
  return Effect.gen(function* () {
    const files = yield* BotFiles.BotFiles;
    const result = yield* files.sendTelegram(BOT, BOT, {
      png: PNG,
      caption: "3090: 690 USD",
      urlAllowed: false,
    });
    assert.strictEqual(result.sent, "chart.png");
    assert.deepEqual(sent, [
      {
        type: "file",
        kind: "photo",
        name: "chart.png",
        mimeType: "image/png",
        bytes: PNG,
        caption: "3090: 690 USD",
      },
    ]);
    assert.deepEqual(notified, [BOT]);
  }).pipe(Effect.provide(layer));
});

it.effect("takes exactly one of text, path, url or a rendered page", () => {
  const { sent, layer } = setup();
  return Effect.gen(function* () {
    const files = yield* BotFiles.BotFiles;
    const error = yield* Effect.flip(
      files.sendTelegram(BOT, BOT, { png: PNG, text: "hi", urlAllowed: false }),
    );
    assert.match(error.message, /exactly one of text, path, url or html/);
    yield* files.sendTelegram(BOT, BOT, { text: "hi", urlAllowed: false });
    assert.deepEqual(sent, [{ type: "text", text: "hi" }]);
  }).pipe(Effect.provide(layer));
});

it("send_telegram decodes html and caps its size", () => {
  const decode = Schema.decodeUnknownSync(BotFilesToolkit.tools.send_telegram.parametersSchema);
  assert.deepEqual(decode({ html: "<svg></svg>", caption: "x" }), {
    html: "<svg></svg>",
    caption: "x",
  });
  assert.throws(() => decode({ html: "x".repeat(512_001) }));
});

type ListedBot = Effect.Success<Store.BotStore["Service"]["list"]>[number];
const bot = (threadId: string, name: string) =>
  ({ threadId: ThreadId.make(threadId), name, projectId: ProjectId.make("bots") }) as ListedBot;
const MAIN = bot("main", "Main");
const EXCEL = bot("excel", "Excel");

it.effect.each([
  {
    computer: "on",
    expected: { bot: "Excel", threadId: EXCEL.threadId, files: ["inbox/q3.xlsx"] },
  },
  { computer: "off", expected: "Files need the bot computer, which is off on this server." },
])(
  "give_files copies a file from Main's chat into a bot's inbox, computer $computer",
  ({ computer, expected }) => {
    const placed: Array<[ThreadId, string, string]> = [];
    let stored: Effect.Success<ReturnType<typeof storeAttachment>> | undefined;
    const { layer } = setup({
      bots: {
        mainBot: Effect.succeed(MAIN.threadId),
        get: (id) => Effect.succeed(id === MAIN.threadId ? MAIN : undefined),
        list: Effect.succeed([MAIN, EXCEL]),
      },
      threads: {
        getThreadRecords: () => Effect.succeed({ messages: [{ attachments: [stored!] }] } as never),
      },
      computer: {
        putFile: (threadId, name, bytes) =>
          Effect.sync(() => {
            if (computer === "off") return undefined;
            placed.push([threadId, name, new TextDecoder().decode(bytes)]);
            return `inbox/${name}`;
          }),
      },
    });
    return Effect.gen(function* () {
      stored = yield* storeAttachment({
        threadId: MAIN.threadId,
        name: "q3.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: new TextEncoder().encode("sheet"),
      });
      const files = yield* BotFiles.BotFiles;
      const result = yield* files
        .giveFiles(MAIN.threadId, { bot: "excel", files: [stored.id] })
        .pipe(
          Effect.map(({ next: _next, ...given }) => given),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
      assert.deepEqual(result, expected);
      assert.deepEqual(placed, computer === "on" ? [[EXCEL.threadId, "q3.xlsx", "sheet"]] : []);
    }).pipe(Effect.provide(layer));
  },
);

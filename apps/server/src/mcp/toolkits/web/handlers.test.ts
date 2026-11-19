import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BotRecordings from "../../../bots/BotRecordings.ts";
import * as WebBrowser from "../../../bots/WebBrowser.ts";
import * as Accounts from "../../../connections/Accounts.ts";
import * as BotSecrets from "../../../secrets/BotSecrets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WebHandlers from "./handlers.ts";
import { WebToolkit } from "./tools.ts";

const BOT = ThreadId.make("bot-reader");
const STORY = "https://news.test/story";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  botThreadId: BOT,
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

it.effect(
  "web_browse logs which engine read a page and drops a Firecrawl read on an account call",
  () =>
    Effect.gen(function* () {
      const forgotten: ThreadId[] = [];
      const logged: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(WebBrowser.WebBrowser)({
          browse: (_bot, input) =>
            Effect.succeed({
              page: { url: input.url ?? STORY, snapshot: "Story" },
              via: "firecrawl" as const,
            }),
          forget: (bot) => Effect.sync(() => void forgotten.push(bot)),
        }),
        Layer.mock(Accounts.Accounts)({
          browse: () => Effect.succeed({ url: "https://olx.ua/", title: "OLX", snapshot: "Inbox" }),
        }),
        Layer.mock(BotSecrets.BotSecrets)({
          redactor: () => Effect.succeed((text: string) => text),
        }),
        Layer.mock(BotRecordings.BotRecordings)({
          record: (step) => Effect.sync(() => void logged.push(step.detail)),
        }),
        McpToolAccessTestkit.liveThreadsLayer,
      );
      const toolkit = yield* WebToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(WebHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const browse = (input: Parameters<typeof toolkit.handle<"web_browse">>[1]) =>
        toolkit
          .handle("web_browse", input)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provide(dependencies),
          );

      yield* browse({ action: "open", url: STORY });
      assert.deepEqual(logged, [`${STORY} · ${STORY} · via firecrawl`]);
      assert.deepEqual(forgotten, []);
      yield* browse({ action: "open", url: "https://olx.ua/", account: "olx.ua" });
      assert.deepEqual(forgotten, [BOT]);
    }),
);

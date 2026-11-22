import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
const OTHER = "https://other.test/page";
const CHECKED = "https://checked.test/";

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
  "web_browse logs which engine read a page; an account call or request_login drops a Firecrawl read; a standalone bot searches on Firecrawl and reads pages",
  () =>
    Effect.gen(function* () {
      const forgotten: ThreadId[] = [];
      const logged: string[] = [];
      const browsed: Array<typeof WebBrowser.WebBrowseInput.Type> = [];
      const searches: Array<boolean | undefined> = [];
      // The tab host is down: a snapshot fails unless it pages what an open just read.
      let tabDown = false;
      const dependencies = Layer.mergeAll(
        Layer.mock(WebBrowser.WebBrowser)({
          browse: (_bot, input) =>
            tabDown && input.action === "snapshot" && browsed.at(-1)?.action !== "open"
              ? Effect.sync(() => void browsed.push(input)).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: "The browser is unavailable.",
                      }),
                    ),
                  ),
                )
              : Effect.sync(() => {
                  browsed.push(input);
                  return {
                    page: {
                      url: input.url ?? STORY,
                      snapshot: "Story",
                      nextOffset: 5,
                      note: "refs",
                    },
                    via: "firecrawl" as const,
                    ...(input.url === CHECKED
                      ? { challenge: { vendor: "cloudflare" as const, label: "Cloudflare check" } }
                      : {}),
                  };
                }),
          search: (_bot, _query, options) =>
            Effect.sync(() => {
              searches.push(options?.firecrawl);
              return { url: "", snapshot: "1. Story" };
            }),
          forget: (bot) => Effect.sync(() => void forgotten.push(bot)),
        }),
        Layer.mock(Accounts.Accounts)({
          browse: () => Effect.succeed({ url: "https://olx.ua/", title: "OLX", snapshot: "Inbox" }),
          requestLogin: () => Effect.succeed("Sign-in sheet sent."),
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
      const call = <Name extends "web_browse" | "web_read" | "web_search" | "request_login">(
        name: Name,
        input: Parameters<typeof toolkit.handle<Name>>[1],
        as = scope,
      ) =>
        toolkit
          .handle(name, input)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, as),
            Effect.provide(dependencies),
          );

      yield* call("web_browse", { action: "open", url: STORY });
      assert.deepEqual(logged, [`${STORY} · ${STORY} · via firecrawl`]);
      assert.deepEqual(forgotten, []);
      yield* call("web_browse", { action: "open", url: "https://olx.ua/", account: "olx.ua" });
      assert.deepEqual(forgotten, [BOT]);
      yield* call("request_login", { site: "olx.ua", reason: "Read the seller's reply" });
      assert.deepEqual(forgotten, [BOT, BOT]);

      const standalone = { ...scope, standalone: true as const };
      yield* call("web_search", { query: "kernel" });
      yield* call("web_search", { query: "kernel" }, standalone);
      yield* call(
        "web_search",
        { query: "kernel" },
        { ...scope, allowedToolNames: new Set(["web_search", "web_read"]) },
      );
      assert.deepEqual(searches, [false, true, undefined]);
      browsed.length = 0;
      const logs = logged.length;
      const [read] = yield* call("web_read", { url: STORY }, standalone);
      yield* call("web_read", { url: STORY, offset: 5 }, standalone);
      yield* call("web_read", { url: OTHER, offset: 5 }, standalone);
      assert.deepEqual(browsed, [
        { action: "open", url: STORY },
        { action: "snapshot", offset: 5 },
        { action: "snapshot", offset: 5 },
        { action: "open", url: OTHER },
        { action: "snapshot", offset: 5 },
      ]);
      tabDown = true;
      browsed.length = 0;
      const [fresh] = yield* call("web_read", { url: OTHER, offset: 5 }, standalone);
      assert.deepEqual(browsed, [
        { action: "snapshot", offset: 5 },
        { action: "open", url: OTHER },
        { action: "snapshot", offset: 5 },
      ]);
      assert.deepEqual(fresh?.result, { url: STORY, snapshot: "Story", nextOffset: 5 });
      tabDown = false;
      const stopped = yield* call("web_read", { url: CHECKED }, standalone).pipe(Effect.flip);
      assert.include(stopped.message, "read with web_read");
      assert.notInclude(stopped.message, "computer_shell");
      assert.deepEqual(read?.result, { url: STORY, snapshot: "Story", nextOffset: 5 });
      assert.lengthOf(logged, logs);
    }),
);

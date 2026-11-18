import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotRecord,
  EnvironmentId,
  type MailAccount,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  oauthClientMissing,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Notifications from "../bots/BotNotifications.ts";
import * as BotStore from "../bots/BotStore.ts";
import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./ConnectionStore.ts";
import * as MailAccounts from "./MailAccounts.ts";
import * as Vault from "./VaultClient.ts";

const inbox: BotRecord = {
  name: "Inbox",
  persona: "Inbox",
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  threadId: ThreadId.make("inbox"),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-14T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
};

const main: BotRecord = { ...inbox, name: "Main", threadId: ThreadId.make("main") };

const account = (id: string, address: string): MailAccount => ({
  id,
  service: "gmail",
  botThreadId: inbox.threadId,
  address,
  connectedAt: "2026-11-14T00:00:00Z",
  lastUsedAt: null,
  error: null,
});

const scopeOf = (bot: BotRecord): McpInvocationContext.McpInvocationScope => ({
  ...scope,
  botThreadId: bot.threadId,
  thread: { ...scope.thread!, threadId: bot.threadId },
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  botThreadId: inbox.threadId,
  client: undefined,
  thread: {
    threadId: inbox.threadId,
    providerSessionId: "session",
    providerInstanceId: inbox.modelSelection.instanceId,
  },
};

/**
 * MailAccounts with Inbox granted Gmail and two accounts in the faked vault; calls are recorded.
 * Without an OAuth client the vault refuses connect links.
 */
const setup = (options: { readonly oauthClient?: boolean } = {}) => {
  const ops: Array<{ op: unknown; accountId: unknown; args: unknown }> = [];
  const launched: Array<string> = [];
  const accounts = [account("a-home", "home@example.com"), account("a-work", "work@example.org")];
  const layer = MailAccounts.layer.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-mail-" }),
        Layer.mock(BotStore.BotStore)({
          owner: (id) => Effect.succeed([inbox, main].find((bot) => bot.threadId === id)),
          get: (id) => Effect.succeed([inbox, main].find((bot) => bot.threadId === id)),
          mainBot: Effect.succeed(main.threadId),
          wake: () => Effect.undefined,
          startWake: () => Effect.void,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input.initialMessage?.text ?? "");
              return { threadId: input.threadId } as never;
            }),
        }),
        Layer.mock(Notifications.BotNotifications)({
          notify: () => Effect.succeed({ delivered: 1, failed: 0, postedInChat: true }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(undefined as never),
          getThreadRecords: () => Effect.succeed({ messages: [], runs: [] } as never),
        }),
        Layer.mock(Vault.VaultClient)({
          call: (path, body) =>
            path === "/link" && options.oauthClient === false
              ? Effect.fail(
                  new Vault.VaultCallError({
                    message: oauthClientMissing("gmail"),
                    unavailable: false,
                  }),
                )
              : Effect.sync(() => {
                  const fields = body as Record<string, unknown>;
                  if (path === "/state") return { oauthAccounts: accounts } as never;
                  if (path === "/oauth/disconnect") {
                    accounts.splice(
                      accounts.findIndex((a) => a.id === fields.accountId),
                      1,
                    );
                    return {} as never;
                  }
                  if (path !== "/oauth/op") return {} as never;
                  ops.push({ op: fields.op, accountId: fields.accountId, args: fields.args });
                  return (
                    fields.op === "draft_get"
                      ? {
                          draftId: "r-1",
                          messageId: "m1",
                          to: "anna@example.com",
                          cc: "",
                          bcc: "hidden@example.net",
                          subject: "Tuesday",
                        }
                      : { id: "sent" }
                  ) as never;
                }),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );
  const grantGmail = Effect.gen(function* () {
    const store = yield* Store.ConnectionStore;
    yield* store.mutate((file) => ({
      ...file,
      settings: {
        ...file.settings,
        gmail: { ...file.settings.gmail, bots: [inbox.threadId, main.threadId] },
      },
    }));
  });
  return { layer, ops, launched, grantGmail };
};

it.effect("a send waits for the user's confirm, and a confirm sends that draft once", () => {
  const { layer, ops, launched, grantGmail } = setup();
  return Effect.gen(function* () {
    yield* grantGmail;
    const mail = yield* MailAccounts.MailAccounts;
    yield* mail.requestSend(scope, "Work@Example.org", "r-1");
    assert.deepEqual(
      ops.map((o) => o.op),
      ["draft_get"],
    );
    const [request] = (yield* mail.state).sends;
    assert.deepInclude(request, {
      status: "pending",
      accountId: "a-work",
      draftId: "r-1",
      messageId: "m1",
      to: "anna@example.com",
      cc: "",
      bcc: "hidden@example.net",
    });

    assert.match((yield* Effect.flip(mail.decideSend("forged", true))).message, /already answered/);
    const sent = yield* mail.decideSend(request!.id, true);
    assert.strictEqual(sent.status, "sent");
    assert.deepEqual(ops.slice(1), [
      { op: "send", accountId: "a-work", args: { draftId: "r-1", messageId: "m1" } },
    ]);
    assert.match(launched[0] ?? "", /Sent to anna@example.com, hidden@example.net/);
    // A second tap or a replayed request sends nothing more.
    assert.match(
      (yield* Effect.flip(mail.decideSend(request!.id, true))).message,
      /already answered/,
    );
    assert.lengthOf(ops, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("Don't send and a disconnect both leave the draft unsent", () => {
  const { layer, ops, grantGmail } = setup();
  return Effect.gen(function* () {
    yield* grantGmail;
    const mail = yield* MailAccounts.MailAccounts;
    yield* mail.requestSend(scope, "home@example.com", "r-1");
    const [first] = (yield* mail.state).sends;
    assert.strictEqual((yield* mail.decideSend(first!.id, false)).status, "denied");

    yield* mail.requestSend(scope, "home@example.com", "r-1");
    const second = (yield* mail.state).sends.find((s) => s.status === "pending")!;
    yield* mail.disconnect("a-home");
    assert.match(
      (yield* Effect.flip(mail.decideSend(second.id, true))).message,
      /already answered/,
    );
    assert.deepEqual(
      ops.map((o) => o.op),
      ["draft_get", "draft_get"],
    );
    assert.deepEqual(
      (yield* mail.state).accounts.map((a) => a.address),
      ["work@example.org"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("names the bot's accounts when it asks for one it does not have", () => {
  const { layer, ops, grantGmail } = setup();
  return Effect.gen(function* () {
    const mail = yield* MailAccounts.MailAccounts;
    assert.match(
      (yield* Effect.flip(mail.call(scope, "home@example.com", "search", {}))).message,
      /has not given Inbox Gmail/,
    );
    yield* grantGmail;
    const error = yield* Effect.flip(mail.call(scope, "dad@example.com", "search", {}));
    assert.match(error.message, /Yours: home@example.com, work@example.org/);
    yield* mail.call(scope, "home@example.com", "search", { query: "is:unread" });
    assert.deepEqual(ops, [{ op: "search", accountId: "a-home", args: { query: "is:unread" } }]);
  }).pipe(Effect.provide(layer));
});

it.effect("without an OAuth client, a bot is sent to Main and Main keeps the owner's step", () => {
  const { layer, grantGmail } = setup({ oauthClient: false });
  return Effect.gen(function* () {
    yield* grantGmail;
    const mail = yield* MailAccounts.MailAccounts;
    const bot = (yield* Effect.flip(mail.connectLink(scope, "gmail"))).message;
    assert.equal(bot, MailAccounts.connectNotSetUp("gmail", "Main"));
    assert.notMatch(bot, /OAuth|Connections|paste/);
    assert.equal(
      (yield* Effect.flip(mail.connectLink(scopeOf(main), "gmail"))).message,
      oauthClientMissing("gmail"),
    );
  }).pipe(Effect.provide(layer));
});

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotRecord,
  type BotSecret,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Notifications from "../bots/BotNotifications.ts";
import * as BotRecordings from "../bots/BotRecordings.ts";
import * as BotStore from "../bots/BotStore.ts";
import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as BotSecrets from "../secrets/BotSecrets.ts";
import * as Accounts from "./Accounts.ts";
import * as Store from "./ConnectionStore.ts";
import * as Vault from "./VaultClient.ts";

const research: BotRecord = {
  name: "Research",
  persona: "Research",
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  threadId: ThreadId.make("research"),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-06T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
};
const WAKE = ThreadId.make("research-wake");
const second: BotRecord = {
  ...research,
  name: "Agents",
  threadId: ThreadId.make("agents"),
};

const scope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  botThreadId: research.threadId,
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: research.modelSelection.instanceId,
  },
});

const setup = (
  asked: { createdBy: "user" | "agent"; scheduled?: boolean },
  vaultDown: ReadonlyArray<string> = [],
) => {
  const pushes: string[] = [];
  const dispatched: Array<{ threadId: ThreadId; text: string; createdBy: string }> = [];
  const wakes = new Map<ThreadId, BotStore.Wake>();
  const launched: Array<{ threadId: ThreadId; text: string; createdBy: string }> = [];
  const vaultCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const signedIn = new Set<string>();
  const used = new Set<string>();
  const botSignedIn = new Set<string>();
  const forgotten: Array<string> = [];
  const actPage: Record<string, unknown> = {};
  /** Runs inside the vault's `/account/act`, as a user's change that lands during a typing. */
  const duringAct: { effect: Effect.Effect<void> } = { effect: Effect.void };
  /** Hosts the bot holds a saved login for, and its unanswered secret cards. */
  const logins = new Set<string>();
  const cards: Array<BotSecret> = [];
  const layer = Accounts.layer.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-accounts-" }),
        Layer.mock(BotStore.BotStore)({
          owner: (id) =>
            Effect.succeed(
              id === research.threadId || id === WAKE || wakes.has(id) ? research : undefined,
            ),
          get: (id) =>
            Effect.succeed(
              id === research.threadId ? research : id === second.threadId ? second : undefined,
            ),
          wake: (id) => Effect.succeed(wakes.get(id)),
          startWake: (wake) =>
            Effect.sync(() => void wakes.set(wake.threadId, { ...wake, startedAt: 0 })),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push({
                threadId: input.threadId!,
                text: input.initialMessage?.text ?? "",
                createdBy: input.createdBy,
              });
              return { threadId: input.threadId } as never;
            }),
        }),
        Layer.mock(BotRecordings.BotRecordings)({
          forget: (used) =>
            Effect.sync(() => void forgotten.push("site" in used ? used.site : used.secret.name)),
        }),
        Layer.mock(Notifications.BotNotifications)({
          notify: (_, text) =>
            Effect.sync(() => {
              pushes.push(text);
              return { delivered: 1, failed: 0, postedInChat: true };
            }),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ activeRunId: RunId.make("run") } as never),
          getThreadRecords: (_threadId, fields) =>
            Effect.succeed(
              ((fields as ReadonlyArray<string>).includes("runs")
                ? { runs: [{ id: RunId.make("run"), userMessageId: MessageId.make("asked") }] }
                : {
                    messages: [
                      {
                        id: MessageId.make("asked"),
                        createdBy: asked.createdBy,
                        ...(asked.scheduled
                          ? { scheduledTaskId: ScheduledTaskId.make("watch") }
                          : {}),
                      },
                    ],
                  }) as never,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "message.dispatch")
                dispatched.push({
                  threadId: command.threadId,
                  text: command.text,
                  createdBy: command.createdBy,
                });
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(BotSecrets.BotSecrets)({
          removeSite: (site) => Effect.sync(() => void forgotten.push(`logins ${site}`)),
          hasLogin: (_bot, hosts) => Effect.succeed(hosts.some((host) => logins.has(host))),
          list: Effect.sync(() => [...cards]),
          remove: (id) =>
            Effect.sync(
              () => void cards.splice(0, cards.length, ...cards.filter((c) => c.id !== id)),
            ),
        }),
        Layer.mock(Vault.VaultClient)({
          call: (path, body) =>
            vaultDown.includes(path)
              ? Effect.fail(new Vault.VaultCallError({ message: "No answer.", unavailable: true }))
              : (path === "/account/act" ? duringAct.effect : Effect.void).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const fields = body as Record<string, unknown>;
                      vaultCalls.push({ path, body: fields });
                      if (path === "/sheet/close" && fields.done === true)
                        signedIn.add(String(fields.site));
                      if (path === "/account/revoke") signedIn.delete(String(fields.site));
                      if (path === "/state")
                        return {
                          accounts: [...signedIn].map((site) => ({
                            site,
                            createdAt: "2026-11-06T00:00:00Z",
                            signedInAt: "2026-11-06T00:00:00Z",
                            lastUsedAt: botSignedIn.has(site)
                              ? "2026-11-06T00:00:00Z"
                              : used.has(site)
                                ? "2026-11-06T01:00:00Z"
                                : null,
                          })),
                        } as never;
                      if (path === "/account/act") {
                        used.add(String(fields.site));
                        // A bot's own sign-in sets signedInAt and lastUsedAt from one time.
                        if (fields.signIn === true) {
                          signedIn.add(String(fields.site));
                          botSignedIn.add(String(fields.site));
                        }
                        return {
                          url: "https://olx.ua/",
                          title: "OLX",
                          snapshot: "page",
                          ...actPage,
                        } as never;
                      }
                      return {} as never;
                    }),
                  ),
                ),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );
  return {
    layer,
    pushes,
    dispatched,
    launched,
    vaultCalls,
    forgotten,
    actPage,
    duringAct,
    logins,
    cards,
  };
};

const cloudflare = { vendor: "cloudflare", label: "Cloudflare check" } as const;

const browse = (threadId: ThreadId, action: "open" | "type", loginHosts: string[] = []) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    return yield* accounts.browse(
      scope(threadId),
      "olx.ua",
      action === "open"
        ? { action: "open", url: "https://olx.ua/" }
        : { action: "type", ref: "e1", text: "Is it still for sale?", submit: true },
      { hasLogin: (hosts) => Effect.succeed(hosts.some((host) => loginHosts.includes(host))) },
    );
  });

it.effect("a login request posts one card and push, and Done grants and wakes the bot", () => {
  const { layer, pushes, launched } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const answer = yield* accounts.requestLogin(scope(research.threadId), {
      site: "www.olx.ua",
      reason: "Message sellers from your account",
      url: "https://www.olx.ua/uk/account/",
    });
    assert.equal(answer, Accounts.loginAsked("olx.ua"));
    yield* accounts.requestLogin(scope(research.threadId), {
      site: "olx.ua",
      reason: "Message sellers from your account",
    });
    const [request, ...more] = yield* accounts.pending;
    assert.deepEqual(more, []);
    assert.deepInclude(request, {
      site: "olx.ua",
      url: "https://www.olx.ua/uk/account/",
      botThreadId: research.threadId,
      writes: true,
    });
    assert.deepEqual(pushes, ["Research needs you to sign in to olx.ua"]);

    yield* accounts.sheetClose("olx.ua", true);
    assert.deepEqual(yield* accounts.pending, []);
    assert.deepEqual((yield* (yield* Store.ConnectionStore).read).accounts["olx.ua"], [
      { botThreadId: research.threadId, scheduledWrites: false },
    ]);
    assert.lengthOf(launched, 1);
    assert.match(
      yield* accounts.requestLogin(scope(research.threadId), { site: "olx.ua", reason: "again" }),
      /already have olx.ua/,
    );
    yield* browse(research.threadId, "open");
    assert.match(
      yield* accounts.requestLogin(scope(research.threadId), { site: "olx.ua", reason: "expired" }),
      /End your turn/,
    );
    assert.lengthOf(yield* accounts.pending, 1);
    assert.deepEqual(pushes, [
      "Research needs you to sign in to olx.ua",
      "Research needs you to sign in to olx.ua",
    ]);
  }).pipe(Effect.provide(layer));
});

/** Android browsers get an app download on Slack's other entry pages. */
const SLACK_SIGN_IN = "https://slack.com/workspace-signin";

it.effect.each([
  {
    named: "192.168.1.27",
    url: "http://192.168.1.27:8099/inbox",
    site: "192.168.1.27:8099",
    opens: "http://192.168.1.27:8099/inbox",
  },
  { named: "olx.ua", url: "https://m.olx.ua/uk/", site: "olx.ua", opens: "https://m.olx.ua/uk/" },
  { named: "olx.ua", url: "https://evil.example/", site: "olx.ua", opens: "https://olx.ua/" },
  { named: "Gmail", url: undefined, site: "mail.google.com", opens: "https://mail.google.com/" },
  {
    named: "gmail.com",
    url: "https://accounts.google.com/signin",
    site: "mail.google.com",
    opens: "https://mail.google.com/",
  },
  {
    named: "Приват24",
    url: undefined,
    site: "next.privat24.ua",
    opens: "https://next.privat24.ua/",
  },
  { named: "slack.com", url: undefined, site: "slack.com", opens: SLACK_SIGN_IN },
  { named: "slack.com", url: "https://slack.com/signin", site: "slack.com", opens: SLACK_SIGN_IN },
  {
    named: "slack.com",
    url: "https://app.slack.com/client/T01/C02",
    site: "slack.com",
    opens: SLACK_SIGN_IN,
  },
  { named: "app.slack.com", url: undefined, site: "app.slack.com", opens: SLACK_SIGN_IN },
  {
    named: "app.slack.com",
    url: "https://app.slack.com/client",
    site: "app.slack.com",
    opens: SLACK_SIGN_IN,
  },
  {
    named: "slack.com",
    url: "https://campus.slack.com/",
    site: "slack.com",
    opens: "https://campus.slack.com/",
  },
])("a request for $named at $url signs in to $site at $opens", ({ named, url, site, opens }) => {
  const { layer } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    yield* accounts.requestLogin(scope(research.threadId), {
      site: named,
      reason: "Reply",
      ...(url === undefined ? {} : { url }),
    });
    assert.deepInclude((yield* accounts.pending)[0], { site, url: opens });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { who: "the user's chat message", thread: research.threadId, writes: true },
  { who: "a wake", thread: WAKE, writes: false },
] as const)(
  "a sign-in asked from $who continues in a hidden wake that may write: $writes",
  ({ thread, writes }) => {
    const { layer, dispatched, launched, vaultCalls } = setup({ createdBy: "user" });
    return Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      yield* accounts.requestLogin(scope(thread), { site: "olx.ua", reason: "Message the seller" });
      yield* accounts.sheetClose("olx.ua", true);
      assert.deepEqual(dispatched, []);
      const [wake, ...more] = launched;
      if (wake === undefined) return assert.fail("No wake was launched.");
      assert.deepEqual(more, []);
      assert.match(wake.threadId, /^bot-wake:/);
      assert.equal(wake.createdBy, "agent");
      assert.include(wake.text, "Signed in to olx.ua");
      assert.include(wake.text, "Message the seller");
      yield* browse(wake.threadId, "type");
      const act = vaultCalls.find((c) => c.path === "/account/act");
      assert.deepInclude(act?.body, { site: "olx.ua", writes });
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  { who: "the user's chat message", thread: research.threadId, asked: "user", writes: true },
  { who: "another bot's message", thread: research.threadId, asked: "agent", writes: false },
  { who: "a schedule in the chat", thread: research.threadId, scheduled: true, writes: false },
  { who: "a wake", thread: WAKE, asked: "user", writes: false },
  { who: "a wake with writes on schedules", thread: WAKE, standing: true, writes: true },
] as const)("a run started by $who may write: $writes", (row) => {
  const asked = "asked" in row ? row.asked : "user";
  const { layer, vaultCalls } = setup({
    createdBy: asked,
    scheduled: "scheduled" in row,
  });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    yield* accounts.grant({
      site: "olx.ua",
      botThreadId: research.threadId,
      granted: true,
      scheduledWrites: "standing" in row,
    });
    yield* browse(row.thread, "type");
    const act = vaultCalls.find((c) => c.path === "/account/act");
    assert.deepInclude(act?.body, { site: "olx.ua", actor: "Research", writes: row.writes });
  }).pipe(Effect.provide(layer));
});

it.effect("a bot without the grant is refused, and Revoke cuts a granted bot off", () => {
  const { layer, vaultCalls, forgotten } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const before = yield* Effect.flip(browse(research.threadId, "open"));
    assert.equal(before.code, "capability_denied");
    assert.match(before.message, /request_login/);
    const slack = yield* Effect.flip(
      accounts.browse(
        scope(research.threadId),
        "slack.com",
        { action: "open", url: "https://app.slack.com/client" },
        { hasLogin: () => Effect.succeed(false) },
      ),
    );
    assert.match(slack.message, /on the sheet: call request_login with site slack\.com/);
    assert.notMatch(slack.message, /ask_secret/);
    const gmail = yield* Effect.flip(
      accounts.browse(
        scope(research.threadId),
        "gmail.com",
        { action: "open", url: "https://gmail.com/" },
        { hasLogin: () => Effect.succeed(false) },
      ),
    );
    assert.match(gmail.message, /on the sheet: call request_login with site gmail\.com/);

    yield* accounts.grant({ site: "olx.ua", botThreadId: research.threadId, granted: true });
    yield* accounts.origins("olx.ua", ["olx-st.com", "olx.ua"]);
    yield* browse(research.threadId, "open");
    assert.deepInclude(vaultCalls[0]?.body, { origins: ["olx-st.com"] });
    yield* accounts.signOut("olx.ua");
    yield* accounts.revoke("olx.ua");
    const after = yield* Effect.flip(browse(research.threadId, "open"));
    assert.equal(after.code, "capability_denied");
    assert.deepEqual(
      vaultCalls.map((c) => c.path),
      ["/account/act", "/account/sign-out", "/account/revoke"],
    );
    assert.deepEqual(forgotten, ["logins olx.ua", "olx.ua", "logins olx.ua"]);
    assert.deepEqual((yield* (yield* Store.ConnectionStore).read).origins, {});
  }).pipe(Effect.provide(layer));
});

/** A bot whose tool list is `tools`, as BotTools scopes its MCP calls. */
const withTools = (tools: ReadonlyArray<string>) => ({
  ...scope(research.threadId),
  allowedToolNames: new Set(tools),
});

it.effect.each([
  { name: "no saved login", site: "olx.ua", tools: ["ask_secret"], login: false, refused: true },
  { name: "a saved login", site: "olx.ua", tools: ["ask_secret"], login: true, refused: false },
  {
    name: "a sheet-first host",
    site: "mail.google.com",
    tools: ["ask_secret"],
    login: false,
    refused: false,
  },
  {
    name: "a host that signs in only through Google",
    site: "youtube.com",
    tools: ["ask_secret"],
    login: false,
    refused: false,
  },
  {
    name: "a workspace that signs in through SSO",
    site: "slack.com",
    tools: ["ask_secret"],
    login: false,
    refused: false,
  },
  { name: "no ask_secret", site: "olx.ua", tools: ["web_browse"], login: false, refused: false },
])("request_login with $name", ({ site, tools, login, refused }) => {
  const { layer, logins } = setup({ createdBy: "user" });
  if (login) logins.add(site);
  return Effect.gen(function* () {
    const ask = (yield* Accounts.Accounts).requestLogin(withTools(tools), {
      site,
      reason: "Sign in",
    });
    if (refused)
      assert.match(
        (yield* Effect.flip(ask)).message,
        /Use the login card for olx\.ua first: call ask_secret with site olx\.ua and kind login/,
      );
    else assert.equal(yield* ask, Accounts.loginAsked(site));
  }).pipe(Effect.provide(layer));
});

it.effect("the card's page choice opens a sheet request that lets request_login through", () => {
  const { layer, cards, launched, pushes } = setup({ createdBy: "user" });
  const card = (id: string, kind: "username" | "password"): BotSecret => ({
    id,
    botThreadId: research.threadId,
    name: `olx-${kind}`,
    label: "OLX",
    reason: "Check the seller's reply",
    site: "olx.ua",
    kind,
    request: "r1",
    requestedAt: "2026-11-15T00:00:00Z",
    savedAt: null,
    lastUsedAt: null,
  });
  cards.push(card("u", "username"), card("p", "password"));
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const ask = accounts.requestLogin(withTools(["ask_secret"]), { site: "olx.ua", reason: "x" });
    assert.match((yield* Effect.flip(ask)).message, /login card/);

    const { site, requestId } = yield* accounts.choosePage("p");
    assert.equal(site, "olx.ua");
    assert.deepEqual(cards, []);
    const [request] = yield* accounts.pending;
    assert.deepInclude(request, {
      id: requestId,
      site,
      botThreadId: research.threadId,
      writes: true,
    });
    assert.deepEqual(pushes, []);
    assert.equal(yield* ask, Accounts.loginAsked("olx.ua"));

    yield* accounts.sheetClose("olx.ua", true);
    assert.lengthOf(launched, 1);
    // Disconnect forgets the choice: the next sign-in starts with the card again.
    yield* accounts.revoke("olx.ua");
    assert.match((yield* Effect.flip(ask)).message, /login card/);
  }).pipe(Effect.provide(layer));
});

it.effect("a login the user saved for a bot grants it the account to sign in with", () => {
  const { layer, vaultCalls, duringAct } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const before = yield* Effect.flip(browse(research.threadId, "open", ["rozetka.com.ua"]));
    assert.match(before.message, /ask_secret|request_login/);
    yield* browse(research.threadId, "open", ["olx.ua"]);
    assert.deepInclude(vaultCalls.at(-1)?.body, { signIn: true });
    const file = yield* (yield* Store.ConnectionStore).read;
    assert.deepEqual(file.accounts["olx.ua"], [
      { botThreadId: research.threadId, scheduledWrites: false },
    ]);
    // Signed in by the bot itself, then a wall it cannot pass: the user gets a card.
    assert.equal(
      yield* (yield* Accounts.Accounts).requestLogin(scope(research.threadId), {
        site: "olx.ua",
        reason: "A device check",
      }),
      Accounts.loginAsked("olx.ua"),
    );

    // A code typed under the grant keeps the account usable after it is spent, until Sign out.
    // A switch the user flips during the typing is kept.
    const accounts = yield* Accounts.Accounts;
    const store = yield* Store.ConnectionStore;
    const typeCode = accounts.browse(
      scope(research.threadId),
      "olx.ua",
      { action: "type", ref: "e1", text: "", submit: false },
      {
        secret: { id: "key", name: "olx-key", site: "olx.ua", kind: "code" },
        hasLogin: () => Effect.succeed(true),
      },
    );
    duringAct.effect = accounts
      .grant({
        site: "olx.ua",
        botThreadId: research.threadId,
        granted: true,
        scheduledWrites: true,
      })
      .pipe(Effect.orDie);
    yield* typeCode;
    assert.deepEqual((yield* store.read).accounts["olx.ua"], [
      { botThreadId: research.threadId, scheduledWrites: true, codeTyped: true },
    ]);
    duringAct.effect = Effect.void;
    yield* browse(research.threadId, "open");
    assert.deepInclude(vaultCalls.at(-1)?.body, { signIn: true });
    yield* accounts.signOut("olx.ua");
    yield* browse(research.threadId, "open");
    assert.notProperty(vaultCalls.at(-1)?.body, "signIn");

    // A Disconnect during the typing is not undone by the mark.
    duringAct.effect = store
      .mutate(({ accounts: { "olx.ua": _gone, ...rest }, ...file }) => ({
        ...file,
        accounts: rest,
      }))
      .pipe(Effect.orDie, Effect.asVoid);
    yield* typeCode;
    assert.isUndefined((yield* store.read).accounts["olx.ua"]);
  }).pipe(Effect.provide(layer));
});

it.effect("an account connected before origins existed gets none on a later grant", () => {
  const { layer, vaultCalls } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const store = yield* Store.ConnectionStore;
    yield* store.mutate((file) => ({
      ...file,
      accounts: {
        "drive.google.com": [{ botThreadId: research.threadId, scheduledWrites: false }],
      },
    }));
    yield* (yield* Accounts.Accounts).grant({
      site: "drive.google.com",
      botThreadId: second.threadId,
      granted: true,
    });
    assert.isUndefined((yield* store.read).origins["drive.google.com"]);
    yield* (yield* Accounts.Accounts).browse(scope(research.threadId), "drive.google.com", {
      action: "open",
      url: "https://drive.google.com/",
    });
    assert.deepEqual(vaultCalls[0]?.body.origins, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a Disconnect the vault did not carry out keeps the account and its grants", () => {
  const { layer, forgotten } = setup({ createdBy: "user" }, ["/account/revoke"]);
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    yield* accounts.grant({ site: "olx.ua", botThreadId: research.threadId, granted: true });
    yield* Effect.flip(accounts.revoke("olx.ua"));
    yield* browse(research.threadId, "open");
    assert.deepEqual(forgotten, []);
    assert.deepEqual(Object.keys((yield* (yield* Store.ConnectionStore).read).accounts), [
      "olx.ua",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a common site's bots may load its other hosts until the user sets their own", () => {
  const { layer, vaultCalls } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    yield* accounts.grant({
      site: "drive.google.com",
      botThreadId: research.threadId,
      granted: true,
    });
    assert.deepEqual((yield* (yield* Store.ConnectionStore).read).origins["drive.google.com"], [
      "docs.google.com",
    ]);
    const open = accounts.browse(scope(research.threadId), "drive.google.com", {
      action: "open",
      url: "https://drive.google.com/",
    });
    yield* open;
    assert.deepEqual((yield* (yield* Store.ConnectionStore).read).origins["drive.google.com"], [
      "docs.google.com",
    ]);
    yield* accounts.origins("drive.google.com", []);
    yield* open;
    assert.deepEqual(
      vaultCalls.map((c) => c.body.origins),
      [["docs.google.com"], []],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a check in the account's page stops the bot until the user passes it in the sheet",
  () => {
    const { layer, pushes, launched, actPage } = setup({ createdBy: "user" });
    return Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      yield* accounts.grant({ site: "olx.ua", botThreadId: research.threadId, granted: true });
      actPage.challenge = cloudflare;
      for (const _ of [1, 2]) {
        const stopped = yield* Effect.flip(browse(research.threadId, "open"));
        assert.equal(stopped.code, "capability_denied");
        assert.match(stopped.message, /Cloudflare check that needs a person\. Never try to solve/);
      }
      assert.deepEqual(pushes, ["Research needs you to pass a Cloudflare check on olx.ua"]);
      const [request, ...more] = yield* accounts.pending;
      assert.deepEqual(more, []);
      assert.deepInclude(request, {
        site: "olx.ua",
        check: { label: "Cloudflare check", browser: "account" },
      });

      yield* accounts.sheetClose("olx.ua", true);
      assert.deepEqual(yield* accounts.pending, []);
      assert.lengthOf(launched, 1);
      assert.include(
        launched[0]?.text,
        "[Passed the check on olx.ua] The user passed the Cloudflare check",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a hard block page is a tool error, not a check request or a push", () => {
  const { layer, pushes } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const stop = yield* accounts.requestCheck(scope(research.threadId), {
      url: "https://www.olx.ua/uk/list/q-rtx-3090/",
      challenge: { vendor: "blocked", label: "access denied page" },
      browser: "computer",
    });
    assert.match(stop, /olx\.ua blocks this browser[\s\S]*Use web_browse/);
    assert.deepEqual(yield* accounts.pending, []);
    assert.deepEqual(pushes, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a check on the bot computer's screen ends with Done, not with the sign-in sheet", () => {
  const { layer, launched } = setup({ createdBy: "user" });
  return Effect.gen(function* () {
    const accounts = yield* Accounts.Accounts;
    const stop = yield* accounts.requestCheck(scope(research.threadId), {
      url: "https://shop.example/item/1",
      challenge: cloudflare,
      browser: "computer",
    });
    assert.match(stop, /shop\.example shows a Cloudflare check/);
    yield* accounts.sheetClose("shop.example", true);
    const [request] = yield* accounts.pending;
    assert.deepInclude(request, {
      site: "shop.example",
      check: { label: "Cloudflare check", browser: "computer" },
    });
    assert.deepEqual(launched, []);

    yield* accounts.checkDone(request!.id);
    yield* accounts.checkDone(request!.id);
    assert.deepEqual(yield* accounts.pending, []);
    assert.deepEqual(
      launched.map((l) => l.text.split("\n")[0]),
      [
        "[Passed the check on shop.example] The user passed the Cloudflare check on https://shop.example/item/1.",
      ],
    );
    assert.deepEqual((yield* (yield* Store.ConnectionStore).read).accounts["shop.example"], []);
  }).pipe(Effect.provide(layer));
});

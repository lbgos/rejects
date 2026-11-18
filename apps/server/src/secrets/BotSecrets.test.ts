import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotRecord,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Notifications from "../bots/BotNotifications.ts";
import * as BotRecordings from "../bots/BotRecordings.ts";
import * as BotStore from "../bots/BotStore.ts";
import * as ServerConfig from "../config.ts";
import * as ConnectionStore from "../connections/ConnectionStore.ts";
import * as Vault from "../connections/VaultClient.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as BotSecrets from "./BotSecrets.ts";

const bot = (name: string): BotRecord => ({
  name,
  persona: name,
  dailyTokenCap: 100,
  modelSelection: { instanceId: ProviderInstanceId.make("deepseek"), model: "flash" },
  threadId: ThreadId.make(name.toLowerCase()),
  projectId: ProjectId.make("bots"),
  createdAt: "2026-11-08T00:00:00Z",
  notifiedAt: null,
  unread: false,
  lastNotification: null,
});
const shopper = bot("Shopper");
const other = bot("Other");
const reader = { ...bot("Reader"), tools: ["web_browse", "ask_secret"] };
const desktop = { ...bot("Desktop"), tools: ["computer_browser", "computer_shell", "ask_secret"] };
const VALUE = 'p@ss "w0rd"/ä-91';

const scope = (owner: BotRecord): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("local"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  botThreadId: owner.threadId,
  client: undefined,
  thread: {
    threadId: owner.threadId,
    providerSessionId: "session",
    providerInstanceId: owner.modelSelection.instanceId,
  },
});

const setup = () => {
  const pushes: string[] = [];
  const launched: string[] = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  const vaultCalls: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
  /** Kept passwords the vault says a site refused. */
  const refusedIds = new Set<string>();
  const vaultDown = new Set<string>();
  const layer = BotSecrets.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ConnectionStore.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-secrets-" }),
        Layer.mock(BotStore.BotStore)({
          owner: (id) =>
            Effect.succeed([shopper, other, reader, desktop].find((b) => b.threadId === id)),
          get: (id) =>
            Effect.succeed([shopper, other, reader, desktop].find((b) => b.threadId === id)),
          wake: (id) => Effect.succeed(new Map<ThreadId, BotStore.Wake>().get(id)),
          startWake: () => Effect.void,
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input.initialMessage?.text ?? "");
              return { threadId: input.threadId } as never;
            }),
        }),
        Layer.mock(Vault.VaultClient)({
          call: (path, body) =>
            vaultDown.has(path)
              ? Effect.fail(new Vault.VaultCallError({ message: "No answer.", unavailable: true }))
              : Effect.sync(() => {
                  const fields = body as Record<string, unknown>;
                  if (path === "/login/failed")
                    return { failed: refusedIds.has(String(fields.id)) } as never;
                  vaultCalls.push({ path, body: fields });
                  return {} as never;
                }),
        }),
        Layer.mock(Notifications.BotNotifications)({
          notify: (_, text) =>
            Effect.sync(() => {
              pushes.push(text);
              return { delivered: 1, failed: 0, postedInChat: true };
            }),
        }),
        Layer.mock(BotRecordings.BotRecordings)({
          forget: (used) =>
            Effect.sync(() => void forgotten.push("secret" in used ? used.secret.name : used.site)),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ activeRunId: RunId.make("run") } as never),
          getThreadRecords: (_threadId, fields) =>
            Effect.succeed(
              ((fields as ReadonlyArray<string>).includes("runs")
                ? { runs: [{ id: RunId.make("run"), userMessageId: MessageId.make("asked") }] }
                : {
                    messages: [{ id: MessageId.make("asked"), createdBy: "user", text: "войди" }],
                  }) as never,
            ),
        }),
        Logger.layer(
          [
            Logger.make(
              ({ message, cause }) => void logs.push(`${String(message)} ${String(cause)}`),
            ),
          ],
          { mergeWithExisting: false },
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );
  return { layer, pushes, launched, forgotten, logs, vaultCalls, refusedIds, vaultDown };
};

it.effect("a site secret goes to the vault, and nothing the bot, the server or a log sees", () => {
  const { layer, pushes, launched, forgotten, logs, vaultCalls } = setup();
  return Effect.gen(function* () {
    const secrets = yield* BotSecrets.BotSecrets;
    const login = (site: string) =>
      secrets.ask(scope(shopper), {
        name: "olx",
        label: "OLX sign-in",
        reason: "Sign in to OLX for your order",
        site,
        kind: "login",
      });
    const asked = yield* login("www.olx.ua");
    assert.match(asked, /End your turn/);
    assert.match(asked, /never ask for them in chat/);
    yield* login("olx.ua");
    const [name, request, ...more] = yield* secrets.list;
    assert.deepEqual(more, []);
    assert.deepInclude(request, { name: "olx-password", site: "olx.ua", savedAt: null });
    assert.equal(pushes.length, 1);
    assert.match(
      (yield* Effect.flip(secrets.typed(shopper.threadId, "olx-password"))).message,
      /no saved secret/,
    );

    yield* secrets.save(name!.id, "me@example.com");
    yield* secrets.save(request!.id, VALUE);
    assert.deepEqual(vaultCalls.at(-1), {
      path: "/login/set",
      body: { id: request!.id, site: "olx.ua", kind: "password", value: VALUE },
    });
    assert.lengthOf(launched, 1);
    assert.include(launched[0], '"olx-username" into the sign-in name field and "olx-password"');

    const typed = yield* secrets.typed(shopper.threadId, "olx-password");
    assert.deepEqual(typed, {
      id: request!.id,
      name: "olx-password",
      site: "olx.ua",
      kind: "password",
    });
    assert.isTrue(yield* secrets.hasLogin(shopper.threadId, ["olx.ua"]));
    assert.isFalse(yield* secrets.hasLogin(shopper.threadId, ["rozetka.com.ua"]));
    assert.isFalse(yield* secrets.hasLogin(other.threadId, ["olx.ua"]));
    assert.match(
      (yield* Effect.flip(secrets.forShell(shopper.threadId, "olx-password"))).message,
      /only typed on olx.ua/,
    );
    assert.match(
      (yield* Effect.flip(secrets.typed(other.threadId, "olx-password"))).message,
      /no saved secret/,
    );

    const { secretsDir, stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    for (const file of yield* fs.readDirectory(secretsDir)) assert.notMatch(file, /^bot-secret-/);
    const metadata = yield* fs.readFileString(`${stateDir}/bot-secrets.json`);

    yield* secrets.remove(request!.id);
    assert.deepEqual(vaultCalls.at(-1), { path: "/login/remove", body: { id: request!.id } });
    assert.deepEqual(
      (yield* secrets.list).map((s) => s.name),
      ["olx-username"],
    );
    assert.deepEqual(forgotten, ["olx-password"]);
    assert.match(
      (yield* Effect.flip(secrets.typed(shopper.threadId, "olx-password"))).message,
      /no saved secret/,
    );

    const seen = [asked, ...pushes, ...launched, ...logs, metadata, JSON.stringify(typed)].join(
      "\n",
    );
    for (const form of [VALUE, encodeURIComponent(VALUE), JSON.stringify(VALUE).slice(1, -1)])
      assert.notInclude(seen, form);
  }).pipe(Effect.provide(layer));
});

it.effect("a code is asked again after it is typed; Disconnect deletes the site's logins", () => {
  const { layer, pushes, vaultCalls, vaultDown } = setup();
  return Effect.gen(function* () {
    const secrets = yield* BotSecrets.BotSecrets;
    const askCode = secrets.ask(scope(shopper), {
      name: "olx-code",
      label: "OLX code",
      reason: "The code OLX sent you",
      site: "olx.ua",
      kind: "code",
    });
    yield* askCode;
    const code = (yield* secrets.list).find((s) => s.name === "olx-code")!;
    yield* secrets.save(code.id, "481516");
    assert.deepInclude(vaultCalls[0]!.body, { kind: "code" });
    const typed = yield* secrets.typed(shopper.threadId, "olx-code");
    yield* secrets.spent(typed);
    assert.deepEqual(yield* secrets.list, []);
    assert.match(yield* askCode, /Asked the user/);
    assert.equal(pushes.length, 2);

    assert.match(
      (yield* Effect.flip(
        secrets.ask(scope(shopper), { name: "x", label: "x", reason: "y", kind: "code" }),
      )).message,
      /kind is for a site/,
    );

    for (const [name, site] of [
      ["olx", "olx.ua"],
      ["olx-m", "m.olx.ua"],
      ["rozetka", "rozetka.com.ua"],
    ] as const) {
      yield* secrets.ask(scope(shopper), {
        name,
        label: name,
        reason: "sign in",
        site,
        kind: "login",
      });
      for (const asked of (yield* secrets.list).filter((s) => s.site === site && s.request))
        yield* secrets.save(asked.id, "hunter2-value");
    }
    // A value the vault could not delete keeps its entry, so Remove can be tried again.
    const rozetka = (yield* secrets.list).find((s) => s.name === "rozetka-password")!;
    vaultDown.add("/login/remove");
    assert.match((yield* Effect.flip(secrets.remove(rozetka.id))).message, /Not removed/);
    assert.include(
      (yield* secrets.list).map((s) => s.name),
      "rozetka-password",
    );
    vaultDown.clear();
    vaultCalls.length = 0;
    yield* secrets.removeSite("olx.ua");
    // The unanswered code card for the site goes too.
    assert.deepEqual(
      (yield* secrets.list).map((s) => s.name),
      ["rozetka-username", "rozetka-password"],
    );
    assert.deepEqual(
      vaultCalls.map((c) => c.path),
      Array.from({ length: 5 }, () => "/login/remove"),
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a lone name or password only next to a saved half; a login replaces unanswered cards",
  () => {
    const { layer, pushes, refusedIds, vaultCalls } = setup();
    return Effect.gen(function* () {
      const secrets = yield* BotSecrets.BotSecrets;
      const ask = (name: string, kind?: "username" | "password" | "login" | "code") =>
        secrets.ask(scope(shopper), {
          name,
          label: name,
          reason: "Sign in",
          site: "olx.ua",
          ...(kind === undefined ? {} : { kind }),
        });
      for (const kind of ["username", "password", undefined] as const)
        assert.match(
          (yield* Effect.flip(ask("olx-field", kind))).message,
          /no sign-in for olx.ua, so ask once with kind login.* not a sign-in.* is kind code/,
        );
      assert.deepEqual(yield* secrets.list, []);
      // A single value that is not a sign-in gets its own card, and a later login leaves it.
      assert.match(yield* ask("olx-key", "code"), /Asked the user/);

      yield* ask("olx", "login");
      const [key, user, pass] = yield* secrets.list;
      yield* secrets.save(pass!.id, "hunter2-value");
      assert.match(
        yield* ask("olx-pass-2", "password"),
        /already have the saved password for olx.ua: secretRef "olx-password"/,
      );
      assert.match(yield* ask("olx-password", "password"), /already have secret "olx-password"/);
      assert.match(yield* ask("olx-name", "username"), /Asked the user/);
      refusedIds.add(pass!.id);
      assert.match(yield* ask("olx-password", "password"), /Asked the user/);
      assert.equal(pushes.length, 4);

      // Unanswered cards for the host become the new login card; the extra one is removed.
      yield* ask("olx2", "login");
      const card = yield* secrets.list;
      assert.deepEqual(
        card.map((s) => [s.id, s.name]),
        [
          [key!.id, "olx-key"],
          [user!.id, "olx2-username"],
          [pass!.id, "olx2-password"],
        ],
      );
      assert.equal(card[1]!.request, card[2]!.request);
      assert.equal(vaultCalls.at(-1)?.path, "/login/remove");
      assert.equal(pushes.length, 4);

      assert.match(
        (yield* Effect.flip(secrets.ask(scope(reader), { name: "key", label: "Key", reason: "x" })))
          .message,
        /computer_shell, which you do not have/,
      );
      assert.match(
        (yield* Effect.flip(
          secrets.ask(scope(desktop), {
            name: "pw",
            label: "pw",
            reason: "Sign in",
            site: "olx.ua",
            kind: "password",
          }),
        )).message,
        /web_browse and account, which you do not have/,
      );

      // A sheet-first host gets no sign-in card; a one-time code still gets one.
      const slack = (kind?: "password" | "login" | "code") =>
        secrets.ask(scope(shopper), {
          name: "slack",
          label: "Slack",
          reason: "Read the workspace",
          site: "campus.slack.com",
          ...(kind === undefined ? {} : { kind }),
        });
      for (const kind of ["login", "password", undefined] as const)
        assert.match(
          (yield* Effect.flip(slack(kind))).message,
          /campus\.slack\.com signs in on the sheet.*call request_login with site campus\.slack\.com/,
        );
      // An alias of a sheet-first site is refused the same way.
      assert.match(
        (yield* Effect.flip(
          secrets.ask(scope(shopper), {
            name: "gmail",
            label: "Gmail",
            reason: "Read the mail",
            site: "gmail.com",
            kind: "login",
          }),
        )).message,
        /gmail\.com signs in on the sheet/,
      );
      assert.match(yield* slack("code"), /Asked the user/);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a login is one card, one push and one wake, and its save closes the sheet card", () => {
  const { layer, pushes, launched, refusedIds } = setup();
  return Effect.gen(function* () {
    const secrets = yield* BotSecrets.BotSecrets;
    const connections = yield* ConnectionStore.ConnectionStore;
    const sheet = (id: string, botThreadId: ThreadId, site: string) => ({
      id,
      site,
      url: `https://${site}/`,
      reason: "Sign in",
      botThreadId,
      writes: true,
      createdAt: "2026-11-15T00:00:00Z",
    });
    yield* connections.mutate((file) => ({
      ...file,
      loginRequests: [
        sheet("mine", shopper.threadId, "olx.ua"),
        sheet("other-bot", other.threadId, "olx.ua"),
        sheet("other-site", shopper.threadId, "rozetka.com.ua"),
      ],
    }));
    const login = (name = "olx") =>
      secrets.ask(scope(shopper), {
        name,
        label: "OLX login",
        reason: "Sign in",
        site: "www.olx.ua",
        kind: "login",
      });
    assert.match(yield* login(), /one private card .*secretRef "olx-username" .*"olx-password"/);
    yield* login();
    const card = yield* secrets.list;
    assert.deepEqual(
      card.map((s) => [s.name, s.kind]),
      [
        ["olx-username", "username"],
        ["olx-password", "password"],
      ],
    );
    assert.equal(card[0]!.request, card[1]!.request);
    assert.isDefined(card[0]!.request);
    assert.equal(pushes.length, 1);

    yield* secrets.save(card[0]!.id, "me@example.com");
    assert.equal(launched.length, 0);
    yield* secrets.save(card[1]!.id, "hunter2-value");
    assert.equal(launched.length, 1);
    assert.match(launched[0]!, /"olx-username" into the sign-in name field and "olx-password"/);
    assert.deepEqual(
      (yield* connections.read).loginRequests.map((r) => r.id),
      ["other-bot", "other-site"],
    );

    assert.match(yield* login("olx2"), /already have the saved sign-in for (www\.)?olx\.ua/);
    refusedIds.add(card[1]!.id);
    assert.match(
      yield* login("olx2"),
      /saved sign-in name .*Ask only for the password: .*kind password and name "olx-password"/,
    );
    assert.match((yield* Effect.flip(login("x".repeat(56)))).message, /keep it to 55 characters/);
    assert.equal(pushes.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("a site secret saved on the server before the vault moves there on its first use", () => {
  const { layer, vaultCalls } = setup();
  return Effect.gen(function* () {
    const secrets = yield* BotSecrets.BotSecrets;
    yield* secrets.ask(scope(shopper), {
      name: "olx",
      label: "OLX sign-in",
      reason: "Sign in",
      site: "olx.ua",
      kind: "login",
    });
    const request = (yield* secrets.list).find((s) => s.name === "olx-password");
    yield* secrets.save(request!.id, VALUE);
    const store = yield* ServerSecretStore.ServerSecretStore;
    yield* store.set(`bot-secret-${request!.id}`, new TextEncoder().encode("legacy-value"));
    vaultCalls.length = 0;
    yield* secrets.typed(shopper.threadId, "olx-password");
    assert.deepEqual(vaultCalls, [
      {
        path: "/login/set",
        body: { id: request!.id, site: "olx.ua", kind: "password", value: "legacy-value" },
      },
    ]);
    assert.isTrue((yield* store.get(`bot-secret-${request!.id}`))._tag === "None");
  }).pipe(Effect.provide(layer));
});

it.effect("a secret without a site goes only to shell commands", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const secrets = yield* BotSecrets.BotSecrets;
    yield* secrets.ask(scope(shopper), {
      name: "openai-key",
      label: "OpenAI key",
      reason: "Transcribe the call recordings",
    });
    const [request] = yield* secrets.list;
    assert.match((yield* Effect.flip(secrets.save(request!.id, "12"))).message, /at least 3/);
    yield* secrets.save(request!.id, "sk-test-123456");
    assert.equal(yield* secrets.forShell(shopper.threadId, "openai-key"), "sk-test-123456");
    const redact = yield* secrets.redactor(shopper.threadId);
    const page = `- text: sk-test-123456\n- link -> https://x.example/?k=${encodeURIComponent("sk-test-123456")}`;
    assert.equal(redact(page).split("[secret openai-key]").length - 1, 2);
    assert.equal((yield* secrets.redactor(other.threadId))("- text: hello"), "- text: hello");
    assert.match(
      (yield* Effect.flip(secrets.typed(shopper.threadId, "openai-key"))).message,
      /shell commands only/,
    );
    assert.match(
      yield* secrets.ask(scope(shopper), { name: "openai-key", label: "x", reason: "y" }),
      /already have secret "openai-key"/,
    );
  }).pipe(Effect.provide(layer));
});

import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";
import { readableByPeers, sealedBy } from "../bots/sealed.ts";
import { botScope, botToolNames, withToolVisibility, withWorkerModel } from "./BotTools.ts";
import * as Invocation from "./McpInvocationContext.ts";

const client = { protocolVersion: "2025-06-18", capabilities: {} };

const visible = (name: string, allowedToolNames?: ReadonlySet<string>) => {
  const scope: Invocation.McpInvocationScope = {
    environmentId: EnvironmentId.make("local"),
    requestNamespace: "test",
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    ...(allowedToolNames ? { allowedToolNames } : {}),
    client: undefined,
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
  };
  return Effect.sync(() =>
    Context.getOrUndefined(
      withToolVisibility(name, Context.empty()),
      McpSchema.EnabledWhen,
    )?.(client),
  ).pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
};

const tools = [
  "web_search",
  "web_browse",
  "video_transcript",
  "request_login",
  "computer_browser",
  "computer_shell",
  "lab_shell",
  "t3_thread_list",
  "t3_environment_links",
  "cortex_read",
  "notify_user",
  "offer_replies",
  "react",
  "status",
  "hand_off",
  "bridge_read",
  "bridge_watch",
  "bridge_start",
  "bridge_cancel",
  "t3_thread_send",
  "delegate_task",
  "cortex_search",
  "cortex_record",
  "cortex_add_source",
  "mail_search",
  "mail_read",
  "slack_unread",
  "inbox_alerts",
  "connect_account",
  "gmail_send",
  "music_search",
  "music_download",
  "music_status",
  "t3_thread_wait",
  "give_files",
  "send_feedback",
  "propose_bots",
  "bot_create",
  "show_ui",
  "bot_admin_create",
  "send_telegram",
  "read_skill",
  "write_skill",
  "delete_skill",
  "html_render",
  "t3_theme_set",
] as const;

it.effect.each([
  {
    who: "an agent",
    allowed: undefined,
    sees: [
      "t3_thread_list",
      "t3_environment_links",
      "cortex_read",
      "notify_user",
      "t3_thread_send",
      "delegate_task",
      "cortex_search",
      "cortex_record",
      "cortex_add_source",
      "t3_thread_wait",
      "html_render",
      "t3_theme_set",
    ],
  },
  {
    who: "a bot without the bridge",
    allowed: botToolNames(),
    sees: [
      "web_search",
      "web_browse",
      "video_transcript",
      "request_login",
      "computer_browser",
      "computer_shell",
      "t3_thread_list",
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "t3_thread_send",
      "delegate_task",
      "cortex_search",
      "cortex_record",
      "cortex_add_source",
      "send_telegram",
      "read_skill",
      "write_skill",
      "delete_skill",
      "html_render",
    ],
  },
  {
    who: "a bot while no Telegram owner is paired",
    allowed: botToolNames({ telegramLinked: false }),
    sees: [
      "web_search",
      "web_browse",
      "video_transcript",
      "request_login",
      "computer_browser",
      "computer_shell",
      "t3_thread_list",
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "t3_thread_send",
      "delegate_task",
      "cortex_search",
      "cortex_record",
      "cortex_add_source",
      "read_skill",
      "write_skill",
      "delete_skill",
      "html_render",
    ],
  },
  {
    who: "a bot with bridge read",
    allowed: botToolNames({ bridge: "read" }),
    sees: [
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "bridge_read",
      "bridge_watch",
    ],
  },
  {
    who: "a bot with bridge operate",
    allowed: botToolNames({ bridge: "operate" }),
    sees: [
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "bridge_read",
      "bridge_watch",
      "bridge_start",
      "bridge_cancel",
    ],
  },
  {
    who: "a bot holding connections",
    allowed: botToolNames({ readsAccounts: true }),
    sees: [
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "cortex_search",
      "mail_search",
      "mail_read",
      "slack_unread",
      "inbox_alerts",
    ],
  },
  {
    // Granted Gmail: its own accounts' tools stay, whatever its own tool list says.
    who: "a bot granted Gmail with a tool list",
    allowed: botToolNames({ readsAccounts: true, allowed: ["notify_user"], mail: true }),
    sees: ["notify_user", "connect_account", "gmail_send"],
  },
  {
    who: "a bot with the music skill",
    allowed: botToolNames({ skills: ["music"] }),
    sees: [
      "web_search",
      "web_browse",
      "video_transcript",
      "request_login",
      "computer_browser",
      "computer_shell",
      "t3_thread_list",
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "t3_thread_send",
      "delegate_task",
      "cortex_search",
      "cortex_record",
      "cortex_add_source",
      "music_search",
      "music_download",
      "music_status",
      "send_telegram",
      "read_skill",
      "write_skill",
      "delete_skill",
      "html_render",
    ],
  },
  {
    who: "a template bot the owner gave the music skill",
    allowed: botToolNames({ allowed: ["notify_user", "react"], skills: ["music"] }),
    sees: [
      "notify_user",
      "react",
      "music_search",
      "music_download",
      "music_status",
      "read_skill",
      "html_render",
    ],
  },
  {
    who: "a bot holding connections with a bridge grant",
    allowed: botToolNames({ bridge: "operate", readsAccounts: true }),
    sees: [
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "cortex_search",
      "mail_search",
      "mail_read",
      "slack_unread",
      "inbox_alerts",
    ],
  },
  {
    who: "a mail bot from its template",
    allowed: botToolNames({
      allowed: ["web_browse", "request_login", "cortex_read", "notify_user", "react"],
    }),
    sees: [
      "web_browse",
      "request_login",
      "cortex_read",
      "notify_user",
      "react",
      "read_skill",
      "html_render",
    ],
  },
  {
    who: "a main bot from its template",
    allowed: botToolNames({ main: true, allowed: ["notify_user", "react"] }),
    sees: [
      "request_login",
      "notify_user",
      "react",
      "t3_thread_send",
      "t3_thread_wait",
      "give_files",
      "send_feedback",
      "propose_bots",
      "bot_create",
      "show_ui",
      "bot_admin_create",
      "read_skill",
      "write_skill",
      "delete_skill",
      "html_render",
    ],
  },
  {
    // Unsealed with a web tool: it reads and asks other bots, whatever its own tool list says.
    who: "an unsealed web bot from a template",
    allowed: botToolNames({ allowed: ["notify_user", "web_search"], sealed: false }),
    sees: [
      "web_search",
      "t3_thread_list",
      "notify_user",
      "t3_thread_send",
      "t3_thread_wait",
      "html_render",
    ],
  },
  {
    who: "an unsealed paper bot from a template",
    allowed: botToolNames({ allowed: ["notify_user", "computer_shell"], sealed: false }),
    sees: ["computer_shell", "notify_user", "html_render"],
  },
  {
    who: "a sealed bot from a template",
    allowed: botToolNames({ allowed: ["notify_user"], sealed: true }),
    sees: ["notify_user", "html_render"],
  },
  {
    who: "a lead bot from a template",
    allowed: botToolNames({ allowed: ["notify_user", "react"], modelTemplate: "lead" }),
    sees: ["notify_user", "react", "delegate_task", "t3_thread_wait", "html_render"],
  },
  {
    who: "a lead bot holding connections",
    allowed: botToolNames({ readsAccounts: true, modelTemplate: "lead" }),
    sees: [
      "cortex_read",
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "cortex_search",
      "mail_search",
      "mail_read",
      "slack_unread",
      "inbox_alerts",
    ],
  },
  {
    who: "a bridged bot that wrote skills",
    allowed: botToolNames({
      bridge: "read",
      ownSkills: [{ name: "x", description: "When x", body: "x", updatedAt: "" }],
    }),
    sees: [
      "notify_user",
      "offer_replies",
      "react",
      "status",
      "hand_off",
      "bridge_read",
      "bridge_watch",
      "read_skill",
    ],
  },
  {
    who: "a music bot",
    allowed: botToolNames({ bridge: "operate", readsAccounts: true, kind: "music" }),
    sees: [
      "web_search",
      "notify_user",
      "react",
      "music_search",
      "music_download",
      "music_status",
      "read_skill",
    ],
  },
])("lists $who its tools", ({ allowed, sees }) =>
  Effect.gen(function* () {
    const shown = yield* Effect.forEach(tools, (name) => visible(name, allowed));
    assert.deepEqual(
      tools.filter((_, index) => shown[index] === true),
      sees,
    );
  }),
);

it.effect("wakes and workers act as their bot, with its tools", () =>
  Effect.gen(function* () {
    const owners: Record<string, string> = {
      study: "study",
      "study-wake": "study",
      agents: "agents",
      "agents-wake": "agents",
      "agents-worker": "agents",
      "inbox-wake": "inbox",
      "music-wake": "music",
      "homelab-wake": "homelab",
      "manager-wake": "manager",
      "main-wake": "main",
      fable: "fable",
    };
    const bots = {
      owner: (id: ThreadId) =>
        Effect.succeed(
          owners[id]
            ? {
                threadId: ThreadId.make(owners[id]),
                ...(owners[id] === "music" ? { kind: "music" as const } : {}),
                ...(owners[id] === "homelab" ? { skills: ["music" as const] } : {}),
                ...(owners[id] === "fable"
                  ? {
                      standalone: true as const,
                      tools: ["web_search", "web_read", "react", "web_browse", "video_transcript"],
                    }
                  : {}),
              }
            : undefined,
        ),
      mainBot: Effect.succeed(ThreadId.make("main")),
      bridged: (id: ThreadId) => Effect.sync(() => bridgedIds.has(id)),
      wake: (id: ThreadId) => Effect.succeed(id.endsWith("-wake") ? { threadId: id } : undefined),
    };
    const bridgedIds = new Set(["agents", "manager"]);
    const heldIds = new Set(["inbox"]);
    const bridge = Option.some({
      access: (id: ThreadId) =>
        Effect.sync(() => (bridgedIds.has(id) ? ("operate" as const) : undefined)),
    });
    const connections = Option.some({
      held: (id: ThreadId) => Effect.sync(() => heldIds.has(id)),
      grantsOf: (id: ThreadId) => Effect.succeed(id === "inbox" ? (["slack"] as const) : []),
    });
    const scope = (id: string) =>
      botScope(
        ThreadId.make(id),
        bots,
        bridge,
        connections,
        Effect.succeed(true),
        Effect.succeed("homelab"),
      );

    assert.deepEqual(yield* scope("study-wake"), {
      botThreadId: ThreadId.make("study"),
      allowedToolNames: botToolNames({ sealed: false }),
    });
    assert.deepEqual(yield* scope("agents-wake"), {
      botThreadId: ThreadId.make("agents"),
      allowedToolNames: botToolNames({ bridge: "operate" }),
    });
    assert.equal((yield* scope("agents-worker"))?.botThreadId, ThreadId.make("agents"));
    assert.deepEqual(yield* scope("inbox-wake"), {
      botThreadId: ThreadId.make("inbox"),
      allowedToolNames: botToolNames({ readsAccounts: true }),
    });
    assert.deepEqual(yield* scope("manager-wake"), {
      botThreadId: ThreadId.make("manager"),
      allowedToolNames: botToolNames({ bridge: "operate" }),
    });
    assert.deepEqual(yield* scope("music-wake"), {
      botThreadId: ThreadId.make("music"),
      allowedToolNames: botToolNames({ kind: "music" }),
    });
    assert.deepEqual(yield* scope("homelab-wake"), {
      botThreadId: ThreadId.make("homelab"),
      allowedToolNames: botToolNames({ skills: ["music"], sealed: false, lab: true }),
    });
    // Only the bot lab.json names holds the lab shell, and never a sealed one.
    assert.isTrue((yield* scope("homelab-wake"))!.allowedToolNames.has("lab_shell"));
    for (const other of ["study-wake", "main-wake", "music-wake"])
      assert.isFalse((yield* scope(other))!.allowedToolNames.has("lab_shell"));
    assert.isFalse(botToolNames({ readsAccounts: true, lab: true }).has("lab_shell"));
    assert.deepEqual(yield* scope("main-wake"), {
      botThreadId: ThreadId.make("main"),
      allowedToolNames: botToolNames({ main: true, sealed: false }),
    });
    // Main reaches other bots while it is not sealed; a bridge grant does not seal Main.
    const threadTools = ["t3_thread_send", "t3_thread_read", "t3_thread_wait"];
    const reaches = function* () {
      const tools = (yield* scope("main-wake"))!.allowedToolNames;
      // Main also hands off, for sealed bots and when the user wants that bot's own chat.
      assert.isTrue(tools.has("hand_off"));
      return threadTools.filter((tool) => tools.has(tool));
    };
    assert.deepEqual(yield* reaches(), threadTools);
    bridgedIds.add("main");
    assert.deepEqual(yield* reaches(), threadTools);
    bridgedIds.delete("main");
    heldIds.add("main");
    assert.deepEqual(yield* reaches(), []);
    heldIds.delete("main");
    // Other unsealed bots get the peer tools; a sealed bot gets none of them.
    const peerReads = ["t3_thread_list", "t3_thread_read", "t3_thread_send", "t3_thread_wait"];
    const reads = function* (id: string) {
      const tools = (yield* scope(id))!.allowedToolNames;
      return peerReads.filter((tool) => tools.has(tool));
    };
    assert.deepEqual(yield* reads("study-wake"), peerReads);
    for (const sealed of ["inbox-wake", "agents-wake", "music-wake"])
      assert.deepEqual(yield* reads(sealed), []);
    // A standalone bot keeps only its talking and search tools, even with a web tool listed, and
    // is closed both ways: Main and peers are refused it, and it reads no peer.
    assert.deepEqual(yield* scope("fable"), {
      botThreadId: ThreadId.make("fable"),
      standalone: true,
      allowedToolNames: new Set(["web_search", "web_read", "video_transcript", "react"]),
    });
    const fable = (yield* bots.owner(ThreadId.make("fable")))!;
    assert.equal(yield* sealedBy(fable, bots, connections), "the standalone seal");
    assert.isFalse(yield* readableByPeers(fable, bots, connections));
    assert.isUndefined(yield* scope("someone-else"));
  }),
);

it("runs a lead bot's delegate calls on its worker", () => {
  const worker = {
    instanceId: ProviderInstanceId.make("claudeDeepseek"),
    model: "deepseek-v4.1-flash",
  };
  assert.deepEqual(withWorkerModel(undefined, worker), {
    providerInstanceId: worker.instanceId,
    model: worker.model,
  });
  assert.deepEqual(withWorkerModel({ options: [] }, worker), {
    options: [],
    providerInstanceId: worker.instanceId,
    model: worker.model,
  });
  const named = {
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
  };
  assert.deepEqual(withWorkerModel(named, worker), {
    providerInstanceId: worker.instanceId,
    model: worker.model,
  });
  assert.isUndefined(withWorkerModel(undefined, undefined));
});

it.effect.each([
  "delegate_task",
  "task_status",
  "task_cancel",
  "notify_user",
  "send_telegram",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "ask_secret",
  "request_login",
])("a lead bot's worker has no %s, and the bot and its wakes keep it", (tool) =>
  Effect.gen(function* () {
    const owners: Record<string, string> = {
      deep: "deep",
      "deep-wake": "deep",
      "deep-worker": "deep",
    };
    const bots = {
      owner: (id: ThreadId) =>
        Effect.succeed(
          owners[id]
            ? { threadId: ThreadId.make(owners[id]), modelTemplate: "lead" as const }
            : undefined,
        ),
      mainBot: Effect.undefined,
      bridged: () => Effect.succeed(false),
      wake: (id: ThreadId) => Effect.succeed(id === "deep-wake" ? { threadId: id } : undefined),
    };
    const has = function* (id: string) {
      const scope = yield* botScope(ThreadId.make(id), bots, Option.none(), Option.none());
      return scope?.allowedToolNames.has(tool);
    };
    assert.isTrue(yield* has("deep"));
    assert.isTrue(yield* has("deep-wake"));
    assert.isFalse(yield* has("deep-worker"));
  }),
);

it.effect("camofox.json's bots list keeps the Camoufox tools to the bots it names", () =>
  Effect.gen(function* () {
    const bots = {
      owner: (id: ThreadId) => Effect.succeed({ threadId: id }),
      mainBot: Effect.undefined,
      bridged: () => Effect.succeed(false),
      wake: () => Effect.undefined,
    };
    const tools = (id: string, web: ReadonlyArray<string> | undefined) =>
      botScope(
        ThreadId.make(id),
        bots,
        Option.none(),
        Option.none(),
        Effect.succeed(true),
        Effect.undefined,
        Effect.succeed(web),
      ).pipe(Effect.map((scope) => scope!.allowedToolNames));
    const camofox = (set: ReadonlySet<string>) =>
      ["web_search", "web_browse"].filter((tool) => set.has(tool));
    assert.deepEqual(camofox(yield* tools("study", undefined)), ["web_search", "web_browse"]);
    assert.deepEqual(camofox(yield* tools("study", ["fable"])), []);
    assert.deepEqual(camofox(yield* tools("fable", ["fable"])), ["web_search", "web_browse"]);
    // Everything else in the bot's set stays as it was.
    assert.deepEqual(
      [...(yield* tools("study", ["fable"]))],
      [...(yield* tools("study", undefined))].filter(
        (tool) => tool !== "web_search" && tool !== "web_browse",
      ),
    );
    assert.deepEqual(
      [...botToolNames({ standalone: true, web: false })],
      ["video_transcript", "react", "offer_replies", "status"],
    );
  }),
);

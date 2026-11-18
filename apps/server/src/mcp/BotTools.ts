import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { McpSchema } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import type { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import type { CortexToolkit } from "./toolkits/cortex/tools.ts";
import type { WebToolkit } from "./toolkits/web/tools.ts";
import type { MusicToolkit } from "./toolkits/music/tools.ts";
import type { LabToolkit } from "./toolkits/lab/tools.ts";
import type { BotSkillsToolkit } from "./toolkits/botSkills/tools.ts";
import type { VideoToolkit } from "./toolkits/video/tools.ts";
import type {
  ComputerDesktopToolkit,
  ComputerBrowserToolkit,
  ComputerShellToolkit,
} from "./toolkits/computer/tools.ts";

import type { BridgeOperateToolkit, BridgeReadToolkit } from "./toolkits/bridge/tools.ts";
import type { HtmlToolkit } from "./toolkits/html/tools.ts";
import type { BotFilesToolkit } from "./toolkits/botFiles/tools.ts";
import type { ConnectionsToolkit } from "./toolkits/connections/tools.ts";
import type { MailToolkit } from "./toolkits/mail/tools.ts";
import type { SecretsToolkit } from "./toolkits/secrets/tools.ts";
import type {
  BotBridgeAccess,
  BotRecord,
  ModelSelection,
  OrchestratorMcpTarget,
  ThreadId,
} from "@t3tools/contracts";
import type { BotBridge } from "../bots/BotBridge.ts";
import type { ConnectionStore } from "../connections/ConnectionStore.ts";
import { sealedBy } from "../bots/sealed.ts";
import { skillsFor } from "../bots/skills.ts";

export type BotToolName = keyof (typeof OrchestratorToolkit.tools &
  typeof BridgeReadToolkit.tools &
  typeof BridgeOperateToolkit.tools &
  typeof BotFilesToolkit.tools &
  typeof ConnectionsToolkit.tools &
  typeof MailToolkit.tools &
  typeof SecretsToolkit.tools &
  typeof CortexToolkit.tools &
  typeof WebToolkit.tools &
  typeof MusicToolkit.tools &
  typeof LabToolkit.tools &
  typeof BotSkillsToolkit.tools &
  typeof VideoToolkit.tools &
  typeof ComputerDesktopToolkit.tools &
  typeof ComputerBrowserToolkit.tools &
  typeof ComputerShellToolkit.tools &
  typeof HtmlToolkit.tools);

const BOT_TOOL_NAMES = [
  "notify_user",
  "update_memory",
  "memory_search",
  "hand_off",
  "offer_replies",
  "react",
  "status",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "t3_thread_send",
  "t3_thread_list",
  "t3_thread_read",
  "delegate_task",
  "orchestrator_capabilities",
  "task_status",
  "task_cancel",
  "cortex_search",
  "cortex_read",
  "cortex_record",
  "cortex_beliefs",
  "cortex_add_source",
  "web_search",
  "web_browse",
  "video_transcript",
  "request_login",
  "ask_secret",
  "computer_desktop",
  "computer_browser",
  "computer_shell",
  "share_file",
  "send_telegram",
  "write_skill",
  "delete_skill",
] as const satisfies readonly BotToolName[];

/**
 * Charts, whatever a bot's own tool list says. Its pages load nothing from outside (see
 * `offline` in HtmlRender), so a bot that reads files cannot leak them through a chart.
 */
const CHART_TOOL_NAMES = ["html_preview", "html_render"] as const satisfies readonly BotToolName[];

/** A lead waits on each child thread it started, then reads the result with task_status. */
const LEAD_TOOL_NAMES = [
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_thread_wait",
] as const satisfies readonly BotToolName[];
/** A worker does its one task and returns it to its bot: it starts no tasks and reaches no one. */
const WORKER_DENIED_TOOLS: ReadonlySet<string> = new Set([
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
  "lab_shell",
] satisfies BotToolName[]);
const MAIN_TOOL_NAMES = [
  "give_files",
  "send_feedback",
  "propose_bots",
  "bot_create",
  "show_ui",
  "request_login",
  "bot_admin_skill",
  "bot_admin_create",
  "bot_admin_update",
  "write_skill",
  "delete_skill",
] as const satisfies readonly BotToolName[];
/** How Main hands another bot work and reads its answer; see `botReach` in OrchestratorMcpService. */
const MAIN_THREAD_TOOL_NAMES = [
  "t3_thread_send",
  "t3_thread_read",
  "t3_thread_wait",
] as const satisfies readonly BotToolName[];
const MAIN_THREAD_TOOLS: ReadonlySet<string> = new Set(MAIN_THREAD_TOOL_NAMES);
/** Tools that reach the web: a bot holding one could already send its own chat out. */
const WEB_TOOL_NAMES = [
  "web_search",
  "web_browse",
  "computer_browser",
  "computer_desktop",
] as const satisfies readonly BotToolName[];
export const holdsWebTool = (tools: ReadonlySet<string>) =>
  WEB_TOOL_NAMES.some((tool) => tools.has(tool));
/** An unsealed bot with a web tool reads and asks the bots `readableByPeers` opens, whatever its tool list. */
const PEER_TOOL_NAMES = [
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_send",
  "t3_thread_wait",
] as const satisfies readonly BotToolName[];

/** A bot granted the bridge keeps only tools that bring in nothing from outside, so what it proposes for the user's machines comes from the user and from what it reads there. */
const BRIDGED_BOT_TOOL_NAMES = [
  "notify_user",
  "update_memory",
  "memory_search",
  "hand_off",
  "offer_replies",
  "react",
  "status",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
] as const satisfies readonly BotToolName[];
const BRIDGE_READ_TOOL_NAMES = [
  "bridge_list",
  "bridge_read",
  "bridge_models",
  "bridge_watch",
  "bridge_unwatch",
] as const satisfies readonly BotToolName[];
const BRIDGE_OPERATE_TOOL_NAMES = [
  "bridge_start",
  "bridge_send",
  "bridge_cancel",
] as const satisfies readonly BotToolName[];

const CONNECTION_TOOL_NAMES = [
  "connections_list",
  "mail_search",
  "mail_read",
  "slack_unread",
  "slack_read",
  "inbox_alerts",
] as const satisfies readonly BotToolName[];

/** A bot's own mail accounts; listed while the user grants it Gmail, whatever its tool list says. */
const MAIL_TOOL_NAMES = [
  "connect_account",
  "mail_accounts",
  "gmail_search",
  "gmail_read",
  "gmail_labels",
  "gmail_sort",
  "gmail_draft",
  "gmail_send",
] as const satisfies readonly BotToolName[];

/**
 * A bot that reads Gmail or Slack gets nothing that carries data out: no web, shell, other threads, bridge or Cortex writes.
 * Site accounts are different: a bot uses them through its web tools (see `Accounts.ts`).
 */
const CONNECTED_BOT_TOOLS: ReadonlySet<string> = new Set([
  ...BRIDGED_BOT_TOOL_NAMES,
  "cortex_search",
  "cortex_read",
  ...CONNECTION_TOOL_NAMES,
] satisfies BotToolName[]);

const MUSIC_TOOL_NAMES = [
  "music_search",
  "music_download",
  "music_status",
] as const satisfies readonly BotToolName[];
const MUSIC_BOT_TOOLS: ReadonlySet<string> = new Set([
  "notify_user",
  "react",
  "web_search",
  ...MUSIC_TOOL_NAMES,
] satisfies BotToolName[]);

const BOT_TOOLS: ReadonlySet<string> = new Set(BOT_TOOL_NAMES);
const READ_BRIDGE_BOT_TOOLS: ReadonlySet<string> = new Set([
  ...BRIDGED_BOT_TOOL_NAMES,
  ...BRIDGE_READ_TOOL_NAMES,
]);
const OPERATE_BRIDGE_BOT_TOOLS: ReadonlySet<string> = new Set([
  ...READ_BRIDGE_BOT_TOOLS,
  ...BRIDGE_OPERATE_TOOL_NAMES,
]);

const withSkills = (tools: ReadonlySet<string>, own: boolean): ReadonlySet<string> =>
  own || skillsFor((tool) => tools.has(tool)).length > 0
    ? new Set([...tools, "read_skill" satisfies BotToolName])
    : tools;

export const botToolNames = (
  options: {
    readonly bridge?: BotBridgeAccess | undefined;
    readonly readsAccounts?: boolean | undefined;
    readonly kind?: BotRecord["kind"];
    readonly main?: boolean | undefined;
    /** See `sealedBy`. A sealed bot gets no thread tools; only `false` adds the peer reads. */
    readonly sealed?: boolean | undefined;
    readonly allowed?: ReadonlyArray<string> | undefined;
    readonly skills?: BotRecord["skills"] | undefined;
    readonly modelTemplate?: BotRecord["modelTemplate"] | undefined;
    readonly ownSkills?: BotRecord["ownSkills"] | undefined;
    readonly telegramLinked?: boolean | undefined;
    /** The user granted the bot Gmail: it connects and manages its own accounts. */
    readonly mail?: boolean | undefined;
    /** `lab.json` names this bot: it holds `lab_shell`. */
    readonly lab?: boolean | undefined;
  } = {},
): ReadonlySet<string> => {
  const { bridge, readsAccounts, main, allowed, skills, modelTemplate } = options;
  const own = (options.ownSkills?.length ?? 0) > 0;
  const withoutUnlinkedTelegram = (set: ReadonlySet<string>): ReadonlySet<string> =>
    options.telegramLinked === false ? new Set([...set].filter((t) => t !== "send_telegram")) : set;
  if (options.kind === "music") return withSkills(withoutUnlinkedTelegram(MUSIC_BOT_TOOLS), own);
  const base = readsAccounts
    ? CONNECTED_BOT_TOOLS
    : bridge === "operate"
      ? OPERATE_BRIDGE_BOT_TOOLS
      : bridge === "read"
        ? READ_BRIDGE_BOT_TOOLS
        : BOT_TOOLS;
  // A sealed Main gets no thread tools.
  const mainLacks = (t: string) => options.sealed === true && MAIN_THREAD_TOOLS.has(t);
  const tools = new Set(
    [...base].filter(
      (t) => (allowed === undefined || allowed.includes(t)) && !(main && mainLacks(t)),
    ),
  );
  const extra = [
    ...(skills?.includes("music") ? MUSIC_TOOL_NAMES : []),
    ...(base === BOT_TOOLS ? CHART_TOOL_NAMES : []),
    // A lab shell carries data out, so bridged and account-reading bots never get one.
    ...(options.lab && base === BOT_TOOLS ? (["lab_shell"] satisfies BotToolName[]) : []),
    ...(options.mail && readsAccounts ? MAIL_TOOL_NAMES : []),
    ...(main ? MAIN_TOOL_NAMES : []),
    ...(main && !options.sealed ? MAIN_THREAD_TOOL_NAMES : []),
    ...(options.sealed === false && holdsWebTool(tools) ? PEER_TOOL_NAMES : []),
    // Bridged and account-reading bots get no worker: it would carry what they read elsewhere.
    ...(modelTemplate === "lead" && base === BOT_TOOLS ? LEAD_TOOL_NAMES : []),
  ];
  return withSkills(withoutUnlinkedTelegram(new Set([...tools, ...extra])), own);
};

/** Children one bot runs at once, in a run the user's own message started; any other run gets one. */
export const BOT_ACTIVE_TASKS_MAX = 5;

export const withWorkerModel = (
  target: OrchestratorMcpTarget | undefined,
  worker: ModelSelection | undefined,
): OrchestratorMcpTarget | undefined =>
  worker === undefined
    ? target
    : { ...target, providerInstanceId: worker.instanceId, model: worker.model };

export const botScope = Effect.fn("BotTools.botScope")(function* (
  threadId: ThreadId,
  bots: {
    readonly owner: (
      id: ThreadId,
    ) => Effect.Effect<
      | Pick<BotRecord, "threadId" | "kind" | "skills" | "tools" | "modelTemplate" | "ownSkills">
      | undefined
    >;
    readonly mainBot: Effect.Effect<ThreadId | undefined>;
    readonly bridged: (id: ThreadId) => Effect.Effect<boolean>;
    readonly wake: (id: ThreadId) => Effect.Effect<unknown>;
  },
  bridge: Option.Option<Pick<BotBridge["Service"], "access">>,
  connections: Option.Option<Pick<ConnectionStore["Service"], "held" | "grantsOf">>,
  telegramLinked: Effect.Effect<boolean> = Effect.succeed(true),
  labBot: Effect.Effect<string | undefined> = Effect.undefined,
) {
  const bot = yield* bots.owner(threadId);
  if (!bot) return undefined;
  const access = Option.isSome(bridge) ? yield* bridge.value.access(bot.threadId) : undefined;
  const readsAccounts = Option.isSome(connections) && (yield* connections.value.held(bot.threadId));
  const mail =
    Option.isSome(connections) &&
    (yield* connections.value.grantsOf(bot.threadId)).includes("gmail");
  const main = (yield* bots.mainBot) === bot.threadId;
  const sealed = (yield* sealedBy(bot, bots, connections)) !== undefined;
  const linked = yield* telegramLinked;
  // A thread in the bot's family that is neither its chat nor a wake is a delegated worker.
  const worker = threadId !== bot.threadId && (yield* bots.wake(threadId)) === undefined;
  const tools = botToolNames({
    bridge: access,
    readsAccounts,
    kind: bot.kind,
    main,
    sealed,
    allowed: bot.tools,
    skills: bot.skills,
    modelTemplate: bot.modelTemplate,
    ownSkills: bot.ownSkills,
    telegramLinked: linked,
    mail,
    lab: (yield* labBot) === bot.threadId,
  });
  return {
    botThreadId: bot.threadId,
    allowedToolNames: worker
      ? new Set([...tools].filter((tool) => !WORKER_DENIED_TOOLS.has(tool)))
      : tools,
  };
});

const BOT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "update_memory",
  "memory_search",
  "hand_off",
  "offer_replies",
  "react",
  "status",
  "web_search",
  "web_browse",
  "video_transcript",
  "request_login",
  "ask_secret",
  "computer_desktop",
  "computer_browser",
  "computer_shell",
  "lab_shell",
  ...MUSIC_TOOL_NAMES,
  ...BRIDGE_READ_TOOL_NAMES,
  ...BRIDGE_OPERATE_TOOL_NAMES,
  ...CONNECTION_TOOL_NAMES,
  ...MAIL_TOOL_NAMES,
  "give_files",
  "send_feedback",
  "propose_bots",
  "bot_create",
  "show_ui",
  "bot_admin_skill",
  "bot_admin_create",
  "bot_admin_update",
  "share_file",
  "send_telegram",
  "read_skill",
  "write_skill",
  "delete_skill",
] satisfies BotToolName[]);

/** Effect checks EnabledWhen for both discovery and calls, on the authenticated request fiber. */
export const withToolVisibility = (name: string, annotations: Context.Context<never>) => {
  const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen);
  return Context.add(annotations, McpSchema.EnabledWhen, (client) => {
    const fiber = Fiber.getCurrent();
    const scope =
      fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
    return (
      scope !== undefined &&
      (scope.allowedToolNames === undefined
        ? !BOT_ONLY_TOOL_NAMES.has(name)
        : scope.allowedToolNames.has(name)) &&
      (enabledWhen === undefined || enabledWhen(client))
    );
  });
};

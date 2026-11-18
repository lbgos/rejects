import {
  BOT_TEMPLATES,
  ChatAttachmentId,
  OrchestratorMcpFailure,
  SETUP_TEMPLATE_IDS,
  ShowUiInput,
  ThreadId,
  UiTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BotAdmin from "../../../bots/BotAdmin.ts";
import * as BotFeedback from "../../../bots/BotFeedback.ts";
import * as BotFiles from "../../../bots/BotFiles.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as BotSetup from "../../../bots/BotSetup.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  BotAdmin.BotAdmin,
  BotFeedback.BotFeedback,
  BotFiles.BotFiles,
  BotSetup.BotSetup,
  HtmlRender.HtmlRender,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];

const templateList = SETUP_TEMPLATE_IDS.map(
  (id) => `${id} (${BOT_TEMPLATES.find((t) => t.id === id)?.text.en.purpose ?? ""})`,
).join("; ");

export const BotFilesToolkit = Toolkit.make(
  Tool.make("give_files", {
    description:
      "Copy files the user sent you, by their ids from <bot_files>, into another bot's inbox/ unopened. Sends no message: name the returned paths in the task you t3_thread_send to that bot.",
    parameters: Schema.Struct({
      bot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
      files: Schema.Array(ChatAttachmentId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    }),
    success: Schema.Struct({
      bot: Schema.String,
      threadId: ThreadId,
      files: Schema.Array(Schema.String),
      next: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Give a bot files")
    .annotate(Tool.Destructive, false),
  Tool.make("send_feedback", {
    description: `Save a problem report for the maintainers, who read this inbox: a tool or the app failed or got in the way, yours, another bot's note or an error the user passes on. Say what failed and what you tried, in ${BotFeedback.FEEDBACK_MAX_CHARS} characters or fewer. Never include the user's files, messages or other personal content. from: the bot the problem came from (default you).`,
    parameters: Schema.Struct({
      text: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(BotFeedback.FEEDBACK_MAX_CHARS),
      ),
      from: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
    }),
    success: Schema.Struct({ sent: Schema.String, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Send feedback")
    .annotate(Tool.Destructive, false),
  Tool.make("propose_bots", {
    description: `Offer the user bots from templates before you create any. The user gets Create and Not now buttons under your message; bot_create makes only the bots of your latest proposal, once they tap Create. Templates: ${templateList}.`,
    parameters: Schema.Struct({
      templates: Schema.Array(Schema.Literals(SETUP_TEMPLATE_IDS)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(SETUP_TEMPLATE_IDS.length),
      ),
    }),
    success: Schema.Struct({
      proposalId: Schema.String,
      bots: Schema.Array(Schema.String),
      next: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Propose bots")
    .annotate(Tool.Destructive, false),
  Tool.make("bot_create", {
    description:
      "Create one bot of your propose_bots proposal, after the user tapped its Create button. It starts on a small example by itself and answers in its own chat.",
    parameters: Schema.Struct({ template: Schema.Literals(SETUP_TEMPLATE_IDS) }),
    success: Schema.Struct({
      bot: Schema.String,
      example: Schema.NullOr(Schema.String),
      next: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Create a bot")
    .annotate(Tool.Destructive, false),
  Tool.make("show_ui", {
    description:
      "Highlight a place in the app for the user, with `text` as a one-sentence tip in the chat language; they dismiss it. On a phone they get a Show button when the place is on another screen. Targets: dictation (the microphone in the message box: tap and speak instead of typing), notifications (this device's bot notifications in Settings), accounts (the You page, where connected accounts show), bots (the bot list), new_bot (the button that makes a bot), settings. Several calls in one reply show one after another.",
    parameters: ShowUiInput,
    success: Schema.Struct({ shown: UiTarget, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Show in the app")
    .annotate(Tool.Destructive, false),
  Tool.make("share_file", {
    description:
      "Give the user a file you made, by its path in your work dir, up to 50 MB. It shows in this chat and reaches them in Telegram.",
    parameters: Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
      caption: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
    }),
    success: Schema.Struct({ shared: Schema.String, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Share a file")
    .annotate(Tool.Destructive, false),
  Tool.make("send_telegram", {
    description:
      "The only way to Telegram (notify_user never goes there). Send the user's Telegram text, a file from your work dir (path), a public file URL, or a chart or other visual as a PNG photo (html: a complete self-contained page, rendered 800 px wide at 2x, up to 4000 px tall, loading nothing from outside; check it with html_preview first; put the key figures in caption). Give exactly one of text, path, url, html. Up to 50 MB, photos 10 MB, captions 1024 characters.",
    parameters: Schema.Struct({
      text: Schema.optional(Schema.String.check(Schema.isMaxLength(12000))),
      path: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
      url: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
      html: Schema.optional(Schema.String.check(Schema.isMaxLength(512_000))),
      kind: Schema.optional(Schema.Literals(["photo", "video", "document"])),
      caption: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
    }),
    success: Schema.Struct({ sent: Schema.String, next: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Send to Telegram")
    .annotate(Tool.Destructive, false),
  Tool.make("bot_admin_skill", {
    description:
      "The models, icons and bots on this server, for bot_admin_create and bot_admin_update.",
    success: BotAdmin.BotAdminSkill,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Bot setup rules")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("bot_admin_create", {
    description:
      "Create a bot. Call bot_admin_skill first, and pick an icon from its icons that fits the bot's job.",
    parameters: BotAdmin.BotAdminCreateInput,
    success: BotAdmin.BotAdminSaved,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Create a bot")
    .annotate(Tool.Destructive, false),
  Tool.make("bot_admin_update", {
    description:
      "Change a bot; only the fields given change, an icon included. Call bot_admin_skill first.",
    parameters: BotAdmin.BotAdminUpdateInput,
    success: BotAdmin.BotAdminSaved,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Change a bot")
    .annotate(Tool.Destructive, false),
);

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as BotAdmin from "../../../bots/BotAdmin.ts";
import * as BotFeedback from "../../../bots/BotFeedback.ts";
import * as BotFiles from "../../../bots/BotFiles.ts";
import * as BotSetup from "../../../bots/BotSetup.ts";
import type { BotAttachmentError } from "../../../bots/attachments.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { toFailure } from "../html/handlers.ts";
import { BotFilesToolkit } from "./tools.ts";

const asBot = Effect.fn("BotFilesTools.asBot")(function* <A>(
  use: (
    files: BotFiles.BotFiles["Service"],
    botThreadId: Invocation.McpThreadCaller["threadId"],
    turn: Invocation.McpThreadCaller["threadId"],
  ) => Effect.Effect<A, BotAttachmentError>,
) {
  const scope = yield* Invocation.requireThreadScope(
    yield* Invocation.McpInvocationContext,
    "bot files",
  );
  return yield* use(
    yield* BotFiles.BotFiles,
    scope.botThreadId ?? scope.thread.threadId,
    scope.thread.threadId,
  ).pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
});

const asMain = Effect.fn("BotFilesTools.asMain")(function* <A>(
  use: (
    admin: BotAdmin.BotAdmin["Service"],
    caller: Invocation.McpThreadCaller["threadId"],
  ) => Effect.Effect<A, OrchestratorMcpFailure>,
) {
  const scope = yield* Invocation.requireThreadScope(
    yield* Invocation.McpInvocationContext,
    "bot admin",
  );
  return yield* use(yield* BotAdmin.BotAdmin, scope.thread.threadId);
});

/** Telegram shows 800 CSS px at 2x as 1600 px; with the 4000 px capture cap that stays under its 10000 px sum. */
const TELEGRAM_PHOTO_WIDTH = 800;
const TELEGRAM_PHOTO_SCALE = 2;

/** The bot's page as PNG bytes. Offline: a bot's page loads nothing from outside, as in html_render. */
const renderTelegramPhoto = Effect.fn("BotFilesHandlers.renderTelegramPhoto")(function* (
  html: string,
  others: ReadonlyArray<string | undefined>,
) {
  if (others.some((value) => value?.trim()))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Give exactly one of text, path, url or html.",
    });
  const htmlRender = yield* HtmlRender.HtmlRender;
  const { png } = yield* htmlRender
    .preview({ html, width: TELEGRAM_PHOTO_WIDTH, scale: TELEGRAM_PHOTO_SCALE, offline: true })
    .pipe(Effect.mapError(toFailure));
  return Buffer.from(png, "base64");
});

export const layer = Access.toLayer(BotFilesToolkit, {
  give_files: Access.actsAsCaller((input) => asBot((files, id) => files.giveFiles(id, input))),
  share_file: Access.actsAsCaller((input) =>
    asBot((files, id, turn) => files.share(id, turn, input)),
  ),
  send_telegram: Access.actsAsCaller(({ html, ...input }) =>
    Effect.gen(function* () {
      const { allowedToolNames } = yield* Invocation.McpInvocationContext;
      // Telegram fetches a URL itself, so only a bot that already reaches the web may name one.
      const urlAllowed = allowedToolNames === undefined || allowedToolNames.has("web_browse");
      const png =
        html === undefined
          ? undefined
          : yield* renderTelegramPhoto(html, [input.text, input.path, input.url]);
      return yield* asBot((files, id, turn) =>
        files.sendTelegram(id, turn, { ...input, png, urlAllowed }),
      );
    }),
  ),
  send_feedback: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.requireThreadScope(
        yield* Invocation.McpInvocationContext,
        "feedback",
      );
      return yield* (yield* BotFeedback.BotFeedback).send(scope.thread.threadId, input);
    }),
  ),
  bot_admin_skill: Access.actsAsCaller(() => asMain((admin, id) => admin.skill(id))),
  bot_admin_create: Access.actsAsCaller((input) => asMain((admin, id) => admin.create(id, input))),
  bot_admin_update: Access.actsAsCaller((input) => asMain((admin, id) => admin.update(id, input))),
  propose_bots: Access.actsAsCaller(({ templates }) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* BotSetup.BotSetup).propose(scope, templates);
    }),
  ),
  show_ui: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* BotSetup.BotSetup).showUi(scope, input);
    }),
  ),
  bot_create: Access.actsAsCaller(({ template }) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* BotSetup.BotSetup).create(scope, template);
    }),
  ),
});

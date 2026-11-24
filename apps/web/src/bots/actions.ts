import {
  BOTS_ENDPOINTS,
  setReaction,
  type BotReaction,
  type BotSummary,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ScheduledTask,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { openGuestShareDialog } from "../components/chat/guestShareDialogState";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { botRequest } from "../bots/http";
import { t } from "../i18n";
import { readLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { notesChanged, patchBot, refreshBots } from "./state";
import { openBotDialog, openBotPanel } from "./ui";

/** The client offers no delete for built-in bots; the steward is removed through the delete endpoint. */
const isBuiltinBot = (bot: Pick<BotSummary, "threadId">) => bot.threadId.startsWith("builtin:");

export type BotActionId =
  | "run"
  | "pause"
  | "resume"
  | "mute"
  | "unmute"
  | "mark-read"
  | "mark-unread"
  | "schedule"
  | "activity"
  | "memory"
  | "bridge"
  | "screen"
  | "share-guest"
  | "rename"
  | "edit"
  | "delete";

export interface BotAction {
  readonly id: BotActionId;
  readonly label: string;
  readonly icon: string;
  readonly destructive?: boolean;
  readonly separatorBefore?: boolean;
  readonly short?: string;
}

export function botActions(input: {
  readonly bot: Pick<BotSummary, "threadId" | "unread" | "muted">;
  readonly schedules: ReadonlyArray<Pick<ScheduledTask, "enabled">>;
  readonly where: "row" | "header";
  readonly canShareWithGuest?: boolean;
}): BotAction[] {
  const { bot, schedules, where } = input;
  const screen = { id: "screen" as const, label: t("Screen"), icon: "monitor" };
  return [
    ...(where === "header" ? [screen] : []),
    ...(schedules.length === 0
      ? []
      : [
          { id: "run" as const, label: t("Run now"), icon: "zap" },
          schedules.some((s) => s.enabled)
            ? { id: "pause" as const, label: t("Pause schedule"), icon: "pause" }
            : { id: "resume" as const, label: t("Resume schedule"), icon: "play" },
        ]),
    bot.muted
      ? {
          id: "unmute" as const,
          label: t("Unmute notifications"),
          icon: "bell",
          short: t("Unmute"),
        }
      : { id: "mute" as const, label: t("Mute notifications"), icon: "bell-off", short: t("Mute") },
    ...(where === "row"
      ? [
          bot.unread
            ? {
                id: "mark-read" as const,
                label: t("Mark read"),
                icon: "message-badge",
                short: t("Read"),
              }
            : {
                id: "mark-unread" as const,
                label: t("Mark unread"),
                icon: "message-badge",
                short: t("Unread"),
              },
        ]
      : []),
    { id: "schedule", label: t("Schedule"), icon: "clock", separatorBefore: true },
    { id: "activity", label: t("Activity"), icon: "activity" },
    { id: "memory", label: t("Memory"), icon: "brain" },
    { id: "bridge", label: t("Bridge"), icon: "shield-check" },
    ...(where === "row" ? [screen] : []),
    ...(input.canShareWithGuest
      ? [{ id: "share-guest" as const, label: t("Share with guest"), icon: "share" }]
      : []),
    { id: "rename", label: t("Rename"), icon: "pencil", separatorBefore: true },
    { id: "edit", label: t("Edit job and model"), icon: "sliders" },
    ...(isBuiltinBot(bot)
      ? []
      : [
          {
            id: "delete" as const,
            label: t("Delete bot"),
            icon: "trash",
            short: t("Delete"),
            destructive: true,
            separatorBefore: true,
          },
        ]),
  ];
}

export function botSwipeActions(actions: ReadonlyArray<BotAction>) {
  const pick = (...ids: ReadonlyArray<BotActionId>) => actions.find((a) => ids.includes(a.id));
  const present = (list: ReadonlyArray<BotAction | undefined>) =>
    list.filter((a) => a !== undefined);
  return {
    leading: present([pick("mark-read", "mark-unread")]),
    trailing: present([pick("delete"), pick("mute", "unmute")]),
  };
}

function failure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : t("Try again."),
    }),
  );
}

export async function saveNote(
  environmentId: EnvironmentId,
  bot: BotSummary | null,
  id: string | null,
  text: string,
) {
  try {
    await botRequest(environmentId, BOTS_ENDPOINTS.editNote, {
      threadId: bot?.threadId ?? null,
      id,
      text,
    });
  } catch (error) {
    failure(
      bot ? t("Could not save {bot}’s memory", { bot: bot.name }) : t("Could not save your notes"),
      error,
    );
  }
  notesChanged(environmentId);
  if (bot) void refreshBots(environmentId).catch(() => undefined);
}

export async function setNote(
  environmentId: EnvironmentId,
  bot: BotSummary | null,
  id: string,
  change: { readonly pinned?: boolean; readonly retired?: boolean },
) {
  try {
    await botRequest(environmentId, BOTS_ENDPOINTS.setNote, {
      threadId: bot?.threadId ?? null,
      id,
      ...change,
    });
  } catch (error) {
    failure(t("Could not change the note"), error);
  }
  notesChanged(environmentId);
  if (bot && change.retired !== undefined) void refreshBots(environmentId).catch(() => undefined);
}

export async function reactToMessage(
  environmentId: EnvironmentId,
  bot: BotSummary,
  messageId: MessageId,
  emoji: BotReaction | null,
) {
  patchBot(environmentId, bot.threadId, {
    reactions: setReaction(bot.reactions, messageId, emoji),
  });
  try {
    await botRequest(environmentId, BOTS_ENDPOINTS.react, {
      threadId: bot.threadId,
      messageId,
      emoji,
    });
  } catch (error) {
    failure(t("Could not save the reaction"), error);
  }
  await refreshBots(environmentId).catch(() => undefined);
}

export async function saveBotModel(
  environmentId: EnvironmentId,
  bot: BotSummary,
  modelSelection: ModelSelection,
) {
  patchBot(environmentId, bot.threadId, { modelSelection });
  try {
    await botRequest(environmentId, BOTS_ENDPOINTS.update, {
      threadId: bot.threadId,
      name: bot.name,
      persona: bot.persona,
      ...(bot.description === undefined ? {} : { description: bot.description }),
      modelSelection,
      dailyTokenCap: bot.dailyTokenCap,
      ...(bot.starters ? { starters: bot.starters } : {}),
    });
  } catch (error) {
    failure(t("Could not switch {bot}’s model", { bot: bot.name }), error);
  }
  await refreshBots(environmentId).catch(() => undefined);
}

export function useBotActions(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const routeThreadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: true,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: true });
  const open = (bot: BotSummary) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: bot.threadId },
    });
  const run = async (id: BotActionId, bot: BotSummary, schedules: ReadonlyArray<ScheduledTask>) => {
    switch (id) {
      case "run":
        for (const task of schedules) void runNow({ environmentId, input: { id: task.id } });
        return;
      case "mute":
      case "unmute":
        patchBot(environmentId, bot.threadId, { muted: id === "mute" });
        try {
          await botRequest(environmentId, BOTS_ENDPOINTS.mute, {
            threadId: bot.threadId,
            muted: id === "mute",
          });
        } catch (error) {
          failure(
            id === "mute"
              ? t("Could not mute {bot}", { bot: bot.name })
              : t("Could not unmute {bot}", { bot: bot.name }),
            error,
          );
        }
        await refreshBots(environmentId).catch(() => undefined);
        return;
      case "rename":
      case "edit":
        return openBotDialog({
          environmentId,
          threadId: bot.threadId,
          focus: id === "rename" ? "name" : null,
        });
      case "pause":
      case "resume":
        for (const task of schedules)
          void setEnabled({ environmentId, input: { id: task.id, enabled: id === "resume" } });
        return;
      case "schedule":
      case "activity":
      case "memory":
      case "bridge":
      case "screen":
        if (routeThreadId !== bot.threadId) await open(bot);
        return openBotPanel(scopeThreadRef(environmentId, bot.threadId), id);
      case "share-guest":
        return openGuestShareDialog(scopeThreadRef(environmentId, bot.threadId));
      case "mark-read":
      case "mark-unread":
        try {
          await (id === "mark-read"
            ? botRequest(environmentId, BOTS_ENDPOINTS.read, {
                threadId: bot.threadId,
                notifiedAt: bot.notifiedAt,
              })
            : botRequest(environmentId, BOTS_ENDPOINTS.unread, { threadId: bot.threadId }));
          await refreshBots(environmentId);
        } catch (error) {
          failure(t("Could not update the bot"), error);
        }
        return;
      case "delete": {
        const confirmed = await (readLocalApi()?.dialogs.confirm(
          t("Delete {bot}?\nIts conversation and schedules are deleted too.", { bot: bot.name }),
          { variant: "destructive", confirmLabel: t("Delete") },
        ) ?? Promise.resolve(false));
        if (!confirmed) return;
        try {
          await botRequest(environmentId, BOTS_ENDPOINTS.delete, { threadId: bot.threadId });
          await refreshBots(environmentId);
          if (routeThreadId === bot.threadId)
            await navigate({ to: "/bots", search: { thread: undefined } });
        } catch (error) {
          failure(t("Could not delete {bot}", { bot: bot.name }), error);
        }
        return;
      }
    }
  };
  const showContextMenu = async (
    bot: BotSummary,
    schedules: ReadonlyArray<ScheduledTask>,
    position: { x: number; y: number },
    onClose?: () => void,
  ) => {
    const picked = await readLocalApi()?.contextMenu.show(
      botActions({ bot, schedules, where: "row" }),
      position,
    );
    onClose?.();
    if (picked) await run(picked, bot, schedules);
  };
  return { run, showContextMenu };
}

import {
  type BotReaction,
  type BotSummary,
  type MessageId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EllipsisIcon, PauseIcon, WifiOffIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { canShareWithGuestAtom } from "../components/chat/guestShareAvailability";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { useComposerHandleContext } from "../composerHandleContext";
import { BotSecretCards } from "../connections/BotSecretCards";
import { LoginRequestCards } from "../connections/LoginRequests";
import { HolidayWreath } from "../holiday/HolidayWreath";
import { MailSendCards } from "../connections/MailCards";
import { LabChangeCards } from "../connections/LabCards";
import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { botActions, reactToMessage, saveBotModel, useBotActions } from "./actions";
import { BotAvatar } from "./BotAvatar";
import { BotSidePanel } from "./BotOverlays";
import { decideProposal, useBridgeState } from "./BotBridgePanel";
import { BotProposalCard } from "./BotProposalCard";
import { BotStateLabel } from "./BotStateLabel";
import { BOT_ACTION_ICONS } from "./icons";
import { BotThreadContext, BotChromeContext } from "./context";
import {
  botNoticeKey,
  botScheduleLabel,
  formatResume,
  formatWakeIn,
  resolveBotState,
} from "./presentation";
import { setViewingBot, useBot, useBots, useReadOnOpen } from "./state";
import { openBotDialog, openBotPanel, setBotReply } from "./ui";
import { nextWakeAt, useScheduledTasks } from "./useBotTasks";
import { useBotPreferences } from "./preferences";
import { useOnline } from "./useOnline";
import { QuickStart } from "./QuickStart";
import { menuCollisionPadding } from "../safeArea";
import { plural, t } from "../i18n";
import { cn } from "../lib/utils";

export function BotThread({ target, children }: { target: ScopedThreadRef; children: ReactNode }) {
  const { environmentId, threadId } = target;
  const bots = useBots(environmentId);
  const bot = bots.find((b) => b.threadId === threadId);
  useReadOnOpen(environmentId, bot);

  const botThreadId = bot?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the bot list poll which conversation is on screen; leaving it drops its reply
  useEffect(() => {
    if (!botThreadId) return;
    setViewingBot(botThreadId);
    return () => {
      setViewingBot(undefined);
      setBotReply(null);
    };
  }, [botThreadId]);

  // The elements only close over the thread; the components read live bot data themselves.
  const header = <BotHeader target={scopeThreadRef(environmentId, threadId)} />;
  const emptyState = <BotEmptyState target={scopeThreadRef(environmentId, threadId)} />;
  const stopped = bot?.stopped ?? false;
  const tokensToday = bot?.tokensToday ?? 0;
  const dailyTokenCap = bot?.dailyTokenCap ?? 0;
  const botName = bot?.name ?? "";
  const capped = stopped && tokensToday >= dailyTokenCap;
  const resume = formatResume(bot?.resumesAt, capped ? t("tomorrow") : t("within the hour"));
  // The server refuses a stopped bot's turns, so send and resume are off until then.
  const stopNotice = capped
    ? t("Daily cap reached. Resumes {resume}.", { resume })
    : t("Hourly message limit reached. Resumes {resume}.", { resume });
  const sendDisabledReason = stopped ? stopNotice : null;
  // Fetched again when the bot notifies, which it does with every proposal, and after a decision.
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);
  const noticeKey = bot ? botNoticeKey(bot) : null;
  // A saved login closes the bot's sign-in sheet card for that site on the server.
  const [secretsSaved, setSecretsSaved] = useState(0);
  const bridge = useBridgeState(environmentId, noticeKey);
  const proposals =
    bridge?.requests.filter((r) => r.botThreadId === threadId && r.status === "pending") ?? [];
  const decide = (request: (typeof proposals)[number], approve: boolean) => {
    setDeciding({ id: request.id, approve });
    void decideProposal(environmentId, request, approve).finally(() => setDeciding(null));
  };
  // Proposals and sign-in requests read as the bot's last message, so they never cover the chat.
  const timelineEnd = (
    <div className="flex flex-col gap-2 pt-1 pb-2 empty:hidden">
      {proposals.map((request) => (
        <BotProposalCard
          key={request.id}
          request={request}
          environmentLabel={
            bridge?.environments.find((e) => e.environmentId === request.proposal.environmentId)
              ?.label ?? request.proposal.environmentId
          }
          deciding={deciding?.id === request.id ? (deciding.approve ? "approve" : "deny") : null}
          onDecide={(approve) => decide(request, approve)}
          onReview={() => openBotPanel(target, "bridge")}
        />
      ))}
      {bot ? (
        <>
          <LoginRequestCards
            environmentId={environmentId}
            botThreadId={threadId}
            refreshKey={noticeKey === null ? null : `${noticeKey}:${secretsSaved}`}
          />
          <BotSecretCards
            environmentId={environmentId}
            botThreadId={threadId}
            refreshKey={noticeKey}
            onSaved={() => setSecretsSaved((n) => n + 1)}
          />
          <MailSendCards
            environmentId={environmentId}
            botThreadId={threadId}
            refreshKey={noticeKey}
          />
          <LabChangeCards
            environmentId={environmentId}
            botThreadId={threadId}
            refreshKey={noticeKey}
          />
        </>
      ) : null}
    </div>
  );
  const online = useOnline();
  const banner = ((): ComposerBannerStackItem | null => {
    // Losing the network is said at once, where the next message would be typed.
    if (!online)
      return {
        id: "bot-offline",
        variant: "default",
        icon: <WifiOffIcon />,
        title: t("Offline. Reconnects when the network is back."),
      };
    if (!stopped) return null;
    return {
      id: `bot-paused:${threadId}`,
      variant: "default",
      icon: <PauseIcon />,
      title: stopNotice,
      actions: capped ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openBotDialog({ environmentId, threadId, focus: "cap" })}
        >
          {t("Raise cap")}
        </Button>
      ) : undefined,
    };
  })();
  const selectModel = (modelSelection: ModelSelection) => {
    if (bot) void saveBotModel(environmentId, bot, modelSelection);
  };
  const modelSelection = bot?.modelSelection;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const providerDown =
    providers?.find((provider) => provider.instanceId === modelSelection?.instanceId)?.status ===
    "error";
  const chrome = modelSelection
    ? {
        title: botName,
        placeholder: stopped
          ? t("Paused, resumes {resume}", { resume })
          : t("Message {name}", { name: botName }),
        header,
        banner,
        emptyState,
        timelineEnd,
        modelSelection,
        selectModel,
        sendDisabledReason,
        historyFrom: bot?.historyFrom,
        providerDown,
        reactions: bot?.reactions,
        react: (messageId: MessageId, emoji: BotReaction | null) => {
          if (bot) void reactToMessage(environmentId, bot, messageId, emoji);
        },
      }
    : null;

  if (!chrome) return children;
  return (
    <BotThreadContext value={true}>
      <BotChromeContext value={chrome}>
        <div
          data-bot-stopped={stopped || undefined}
          className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {children}
          <BotSidePanel target={target} />
        </div>
      </BotChromeContext>
    </BotThreadContext>
  );
}

function useBotSchedules(target: ScopedThreadRef) {
  return useScheduledTasks(target.environmentId).filter(
    (task) => task.threadId === target.threadId,
  );
}

function BotHeader({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  const schedules = useBotSchedules(target);
  const { run } = useBotActions(target.environmentId);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(target.environmentId));
  if (!bot) return null;
  return (
    <div data-bot-header className="flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <BotAvatar bot={bot} className="size-7 bg-bot-fill ring-0" />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-sm font-medium">{bot.name}</h2>
          <BotHeaderSubtitle target={target} />
        </div>
      </div>
      <div data-bot-header-actions className="flex shrink-0 items-center">
        <BotActionsMenu
          bot={bot}
          schedules={schedules}
          onRun={run}
          canShareWithGuest={canShareWithGuest}
        />
      </div>
    </div>
  );
}

function BotHeaderSubtitle({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  const shell = useThreadShell(target);
  const schedules = useBotSchedules(target);
  if (!bot) return null;
  const state = resolveBotState(
    shell ? resolveSidebarThreadStatus(shell) : "ready",
    bot,
    schedules,
  );
  // The header names the same state as the bot's row in the list; a running turn has no next wake.
  const next = state === "capped" || state === "running" ? null : nextWakeAt(schedules);
  const shown = state === "idle" ? null : state;
  if (!shown && !next) return null;
  return (
    <span className="flex max-w-full items-center gap-1 truncate text-xs leading-4 text-muted-foreground tabular-nums">
      {shown ? <BotStateLabel state={shown} /> : null}
      {shown && next ? <span aria-hidden>·</span> : null}
      {next ? <span>{t("next {time}", { time: formatWakeIn(next) })}</span> : null}
    </span>
  );
}

function BotActionsMenu({
  bot,
  schedules,
  onRun,
  canShareWithGuest,
}: {
  bot: BotSummary;
  schedules: ReturnType<typeof useBotSchedules>;
  onRun: ReturnType<typeof useBotActions>["run"];
  canShareWithGuest: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-pill"
            aria-label={t("Actions for {name}", { name: bot.name })}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup
        data-bot-surface
        data-bot-sheet
        align="end"
        collisionPadding={menuCollisionPadding()}
      >
        {botActions({ bot, schedules, where: "header", canShareWithGuest }).flatMap((action) => {
          const Icon = BOT_ACTION_ICONS[action.icon];
          const item = (
            <MenuItem
              key={action.id}
              variant={action.destructive ? "destructive" : "default"}
              onClick={() => void onRun(action.id, bot, schedules)}
            >
              {Icon ? <Icon /> : null}
              {action.label}
            </MenuItem>
          );
          return action.separatorBefore
            ? [<MenuSeparator key={`${action.id}:separator`} />, item]
            : [item];
        })}
      </MenuPopup>
    </Menu>
  );
}

function BotEmptyState({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  const schedules = useBotSchedules(target);
  const composer = useComposerHandleContext();
  const [preferences] = useBotPreferences(bot?.main ? target.environmentId : null);
  if (!bot) return null;
  const quickStart = bot.main === true && preferences?.experience === "experienced";
  const next = nextWakeAt(schedules);
  const cadence = schedules.find((task) => task.enabled)?.schedule;
  const notes = bot.noteCount ?? 0;
  const facts = [
    cadence
      ? botScheduleLabel(cadence)
      : next
        ? t("next {time}", { time: formatWakeIn(next) })
        : null,
    notes
      ? plural(notes, {
          en: ["{count} note", "{count} notes"],
          uk: ["{count} нотатка", "{count} нотатки", "{count} нотаток"],
          ru: ["{count} заметка", "{count} заметки", "{count} заметок"],
        })
      : null,
  ].filter((fact) => fact !== null);
  return (
    <div
      className={cn(
        "relative flex w-full flex-col items-center px-8 text-center",
        // The quick start is a list to read, so it takes a wider column than a bot's own facts.
        quickStart ? "max-w-xl" : "max-w-md",
      )}
    >
      <HolidayWreath />
      <BotAvatar bot={bot} className="mb-3.5 size-16 bg-bot-fill max-md:size-19" />
      <div className="text-lg font-semibold max-md:text-bot-heading max-md:font-bold">
        {bot.name}
      </div>
      {facts.length > 0 ? (
        <p className="mt-1.5 text-bot-footnote text-muted-foreground">{facts.join(" · ")}</p>
      ) : null}
      {quickStart ? <QuickStart environmentId={target.environmentId} /> : null}
      {!quickStart && bot.starters && bot.starters.length > 0 ? (
        // Full width, so a long starter truncates inside the column instead of widening the row.
        <div className="mt-5 flex w-full flex-wrap justify-center gap-2">
          {bot.starters.map((starter) => (
            <Button
              key={starter}
              variant="secondary"
              size="pill-sm"
              className="max-w-full"
              onClick={() => {
                composer?.current?.insertTextAtEnd(starter);
                composer?.current?.focusAtEnd();
              }}
            >
              <span className="truncate">{starter}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

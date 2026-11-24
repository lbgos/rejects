import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BOTS_ENDPOINTS, type EnvironmentId, type MessageId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import type { TimelineEntry } from "../session-logic";
import { newMessageId } from "../lib/utils";
import { toastManager } from "../components/ui/toast";
import { t } from "../i18n";
import { useComposerDraftStore } from "../composerDraftStore";
import { BotAvatar } from "./BotAvatar";
import { botRequest } from "./http";
import { botTurnOffers } from "./presentation";
import { readBots } from "./state";

/** Create approves the proposal on the server before its text is sent. The buttons leave when they expire (see `botTurnOffers`); one timer re-renders at that moment. */
export function BotTurnOffers({
  environmentId,
  entries,
  onSend,
}: {
  environmentId: EnvironmentId;
  entries: ReadonlyArray<TimelineEntry>;
  onSend: ((text: string, messageId?: MessageId) => Promise<void>) | undefined;
}) {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const { replies, proposal, handOff, expiresAt } = botTurnOffers(entries, now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer is outside React; it re-renders once the buttons expire
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const [approving, setApproving] = useState(false);
  const target = handOff
    ? readBots(environmentId).find(
        (bot) => bot.name.toLowerCase() === handOff.bot.trim().toLowerCase(),
      )
    : undefined;
  const create = async (proposalId: string) => {
    setApproving(true);
    // The message this tap sends: the approval names it, so no other turn can use it.
    const messageId = newMessageId();
    // The nonce only ever reaches this client, so a tool result cannot approve the proposal.
    const pending = await botRequest(environmentId, BOTS_ENDPOINTS.proposal, {}).catch(() => null);
    const approved =
      pending?.id === proposalId &&
      (await botRequest(environmentId, BOTS_ENDPOINTS.approveProposal, {
        proposalId,
        nonce: pending.nonce,
        messageId,
      }).then(
        () => true,
        () => false,
      ));
    setApproving(false);
    if (!approved) {
      toastManager.add({
        type: "error",
        title: t("This proposal is out of date. Ask the bot again."),
      });
      return;
    }
    try {
      await onSend?.(t("Create"), messageId);
    } catch {
      // Keep no approval that its Create message never reached.
      await botRequest(environmentId, BOTS_ENDPOINTS.releaseProposal, { proposalId }).catch(
        () => undefined,
      );
      toastManager.add({
        type: "error",
        title: t("Approved, but the message did not reach the bot. Tap Create again."),
      });
    }
  };
  const buttons =
    proposal === null
      ? replies.map((reply) => ({ label: reply, tap: () => onSend?.(reply) }))
      : [
          { label: t("Create"), tap: () => create(proposal) },
          { label: t("Not now"), tap: () => onSend?.(t("Not now")) },
        ];
  if (!target && buttons.length === 0) return null;
  return (
    <div className="flex flex-col items-start gap-2 pt-1 pb-2">
      {handOff && target ? (
        <button
          type="button"
          data-bot-hand-off
          className="flex w-full items-center gap-3 rounded-lg border p-3 text-start hover:bg-accent max-md:max-w-[88%] max-md:rounded-2xl max-md:border-0 max-md:bg-bot-bubble max-md:px-3.5 max-md:hover:bg-bot-fill md:max-w-md"
          onClick={() => {
            useComposerDraftStore
              .getState()
              .setPrompt(scopeThreadRef(environmentId, target.threadId), handOff.draft);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: target.threadId },
            });
          }}
        >
          <BotAvatar bot={target} className="size-8 max-md:size-10" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium max-md:text-bot-body max-md:font-semibold">
              {t("Open {bot}", { bot: target.name })}
            </span>
            <span className="truncate text-xs text-muted-foreground max-md:text-bot-callout">
              {handOff.draft}
            </span>
          </span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      {buttons.length > 0 && onSend ? (
        <div data-bot-replies className="flex flex-wrap gap-2">
          {buttons.map(({ label, tap }) => (
            <Button
              key={label}
              variant="secondary"
              size="pill-sm"
              className="max-w-full"
              disabled={approving}
              onClick={() => {
                // A background tab may not have run the expiry timer yet.
                if (expiresAt !== null && Date.now() >= expiresAt) return setNow(Date.now());
                void tap();
              }}
            >
              <span className="truncate">{label}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

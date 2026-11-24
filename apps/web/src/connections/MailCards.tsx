import {
  CONNECTIONS_ENDPOINTS,
  type EnvironmentId,
  type MailSendRequest,
  type MailState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { MailIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { botRequest } from "../bots/http";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { usePreparedConnection } from "../state/session";
import { failed } from "./rows";

/** Every bot's mail accounts and send requests, read again whenever `key` changes. */
function useMailState(environmentId: EnvironmentId, key: string | null) {
  const [state, setState] = useState<MailState | null>(null);
  // A cold start renders the bot before the connection is ready; the read waits for it.
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's mail state; key marks when it may have changed
  useEffect(() => {
    if (key === null || !connected) return;
    const controller = new AbortController();
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.mailState, {}, controller.signal).then(
      setState,
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, key, connected]);
  return state;
}

/**
 * Drafts the bot asked to send, at the end of its chat as the bot's message: recipients and
 * subject, Send and Don't send. Only Send here sends; the server refuses any other way.
 */
export function MailSendCards({
  environmentId,
  botThreadId,
  refreshKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  /** Changes when the bot notifies, which `gmail_send` does. */
  readonly refreshKey: string | null;
}) {
  const [handled, setHandled] = useState(0);
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);
  const state = useMailState(
    environmentId,
    refreshKey === null ? null : `${refreshKey}:${handled}`,
  );
  const phone = useMediaQuery("max-md");
  const sends =
    state?.sends.filter((s) => s.botThreadId === botThreadId && s.status === "pending") ?? [];
  if (sends.length === 0) return null;
  const decide = (request: MailSendRequest, approve: boolean) => {
    setDeciding({ id: request.id, approve });
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.mailSendDecide, { id: request.id, approve })
      .then(() => undefined, failed)
      .finally(() => {
        setDeciding(null);
        setHandled((n) => n + 1);
      });
  };
  const size = phone ? "pill" : "sm";
  return (
    <>
      {sends.map((request) => {
        const busy = deciding?.id === request.id ? deciding : null;
        return (
          <div
            key={request.id}
            data-mail-send
            className="flex w-full max-w-[88%] flex-col rounded-2xl bg-bot-bubble px-3.75 pt-3.5 pb-3.75 md:max-w-md md:rounded-lg md:border md:bg-transparent md:p-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere max-md:text-bot-body max-md:font-semibold">
                {request.subject || t("(no subject)")}
              </span>
            </div>
            {/* Every recipient in full: the tap sends to all of them. */}
            <div className="mt-0.5 text-xs wrap-anywhere text-muted-foreground max-md:text-bot-callout">
              {request.to ? <p>{t("To {to}", { to: request.to })}</p> : null}
              {request.cc ? <p>{t("Cc {cc}", { cc: request.cc })}</p> : null}
              {request.bcc ? <p>{t("Bcc {bcc}", { bcc: request.bcc })}</p> : null}
              <p>{t("From {from}", { from: request.address })}</p>
            </div>
            <div className="mt-3.5 flex gap-2 md:mt-2.5">
              <Button
                size={size}
                className="max-md:flex-1"
                disabled={deciding !== null}
                onClick={() => decide(request, true)}
              >
                {busy?.approve ? t("Sending…") : t("Send")}
              </Button>
              <Button
                size={size}
                variant="secondary"
                className="max-md:flex-1"
                disabled={deciding !== null}
                onClick={() => decide(request, false)}
              >
                {t("Don’t send")}
              </Button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The bot's connected mail accounts, read once per mount and after each disconnect. */
export function useMailAccounts(environmentId: EnvironmentId, botThreadId: ThreadId | null) {
  const [handled, setHandled] = useState(0);
  const state = useMailState(environmentId, botThreadId === null ? null : String(handled));
  return {
    accounts: state?.accounts.filter((a) => a.botThreadId === botThreadId) ?? [],
    refresh: () => setHandled((n) => n + 1),
  };
}

/** Each account with Disconnect, which revokes its grant and deletes its token. */
export function MailAccountsList({
  environmentId,
  accounts,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly accounts: MailState["accounts"];
  readonly onChange: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const disconnect = (id: string) => {
    setRemoving(id);
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.mailDisconnect, { id })
      .then(() => undefined, failed)
      .finally(() => {
        setRemoving(null);
        onChange();
      });
  };
  return (
    <ul className="space-y-1 text-xs max-md:text-bot-footnote">
      {accounts.map((account) => (
        <li key={account.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {account.address}
            {account.error ? <span className="text-destructive"> · {account.error}</span> : null}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={removing !== null}
            onClick={() => disconnect(account.id)}
          >
            {removing === account.id ? t("Disconnecting…") : t("Disconnect")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

import {
  type EnvironmentId,
  LAB_ENDPOINTS,
  type LabChangeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { botRequest } from "../bots/http";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { usePreparedConnection } from "../state/session";
import { failed } from "./rows";

/**
 * Changes the bot proposed for a lab host, at the end of its chat: the host, the bot's one line
 * and the whole script. Only Run here runs it, once, as root; the server refuses any other way.
 */
export function LabChangeCards({
  environmentId,
  botThreadId,
  refreshKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  /** Changes when the bot notifies, which a proposed change does. */
  readonly refreshKey: string | null;
}) {
  const [handled, setHandled] = useState(0);
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean } | null>(null);
  const [requests, setRequests] = useState<ReadonlyArray<LabChangeRequest>>([]);
  const phone = useMediaQuery("max-md");
  // A cold start renders the bot before the connection is ready; the read waits for it.
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const key = refreshKey === null ? null : `${refreshKey}:${handled}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's lab requests; the key marks when they may have changed
  useEffect(() => {
    if (key === null || !connected) return;
    const controller = new AbortController();
    botRequest(environmentId, LAB_ENDPOINTS.state, {}, controller.signal).then(
      (state) => setRequests(state.requests),
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, key, connected]);
  const pending = requests.filter((r) => r.botThreadId === botThreadId && r.status === "pending");
  if (pending.length === 0) return null;
  const decide = (request: LabChangeRequest, approve: boolean) => {
    setDeciding({ id: request.id, approve });
    botRequest(environmentId, LAB_ENDPOINTS.decide, { id: request.id, approve })
      .then(() => undefined, failed)
      .finally(() => {
        setDeciding(null);
        setHandled((n) => n + 1);
      });
  };
  const size = phone ? "pill" : "sm";
  return (
    <>
      {pending.map((request) => {
        const busy = deciding?.id === request.id ? deciding : null;
        return (
          <div
            key={request.id}
            data-lab-change
            className="flex w-full max-w-[88%] flex-col rounded-3xl bg-bot-bubble px-3.75 pt-3.5 pb-3.75 md:max-w-md md:rounded-lg md:border md:bg-transparent md:p-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere max-md:text-bot-body max-md:font-semibold">
                {request.why}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground max-md:text-bot-callout">
              {t("Runs once as root on {host}", { host: request.host })}
            </p>
            {/* The whole script: the tap runs exactly this text. */}
            <pre className="mt-2 max-h-64 overflow-y-auto font-mono text-xs whitespace-pre-wrap wrap-anywhere">
              {request.script}
            </pre>
            <div className="mt-3.5 flex gap-2 md:mt-2.5">
              <Button
                size={size}
                className="max-md:flex-1"
                disabled={deciding !== null}
                onClick={() => decide(request, true)}
              >
                {busy?.approve ? t("Running…") : t("Run")}
              </Button>
              <Button
                size={size}
                variant="secondary"
                className="max-md:flex-1"
                disabled={deciding !== null}
                onClick={() => decide(request, false)}
              >
                {t("Don’t run")}
              </Button>
            </div>
          </div>
        );
      })}
    </>
  );
}

import {
  CONNECTIONS_ENDPOINTS,
  type EnvironmentId,
  type LoginRequest,
  siteName,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { botRequest } from "../bots/http";
import { ShieldAlertIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t, uiLanguage } from "../i18n";
import { usePreparedConnection } from "../state/session";
import { openBotPanel } from "../bots/ui";
import { failed } from "./rows";
import { SignInSheet } from "./SignInSheet";
import { SiteIcon } from "./SiteIcon";

function useLoginRequests(environmentId: EnvironmentId, botThreadId: string, key: string | null) {
  const [requests, setRequests] = useState<ReadonlyArray<LoginRequest>>([]);
  // A cold start renders the bot chat before the connection is ready; requests wait for it.
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's pending requests; key marks when they may have changed
  useEffect(() => {
    if (key === null || !connected) return;
    const controller = new AbortController();
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.loginRequests, {}, controller.signal).then(
      (all) => setRequests(all.filter((r) => r.botThreadId === botThreadId)),
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, botThreadId, key, connected]);
  return requests;
}

export function LoginRequestCards({
  environmentId,
  botThreadId,
  refreshKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  readonly refreshKey: string | null;
}) {
  const [handled, setHandled] = useState(0);
  const requests = useLoginRequests(
    environmentId,
    botThreadId,
    refreshKey === null ? null : `${refreshKey}:${handled}`,
  );
  const [opening, setOpening] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const phone = useMediaQuery("max-md");
  if (requests.length === 0 && sheet === null) return null;

  const signIn = (request: LoginRequest) => {
    setOpening(request.id);
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetOpen, {
      site: request.site,
      requestId: request.id,
    })
      .then(() => setSheet(request.site), failed)
      .finally(() => setOpening(null));
  };
  const dismiss = (request: LoginRequest) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.loginDismiss, { id: request.id }).then(
      () => setHandled((n) => n + 1),
      failed,
    );
  const checked = (request: LoginRequest) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.checkDone, { id: request.id }).then(
      () => setHandled((n) => n + 1),
      failed,
    );
  const size = phone ? "pill" : "sm";

  return (
    <>
      {requests.map((request) => {
        const onScreen = request.check?.browser === "computer";
        return (
          <div
            key={request.id}
            data-login-request
            className="flex w-full max-w-[88%] flex-col rounded-3xl bg-bot-bubble px-3.75 pt-3.5 pb-3.75 md:max-w-md md:rounded-lg md:border md:bg-transparent md:p-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              {request.check ? (
                <ShieldAlertIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <SiteIcon site={request.site} className="max-md:size-4" />
              )}
              <span className="truncate text-sm font-medium max-md:text-bot-body max-md:font-semibold">
                {request.check
                  ? t("Pass the check on {site}", { site: request.site })
                  : t("Sign in to {site}", { site: siteName(request.site, uiLanguage) })}
              </span>
            </div>
            {request.reason ? (
              <p className="mt-0.5 line-clamp-2 text-xs break-words text-muted-foreground max-md:text-bot-callout">
                {request.reason}
              </p>
            ) : null}
            <div className="mt-3.5 flex gap-2 md:mt-2.5">
              {onScreen ? (
                <>
                  <Button
                    size={size}
                    className="max-md:flex-1"
                    onClick={() =>
                      openBotPanel(scopeThreadRef(environmentId, botThreadId), "screen")
                    }
                  >
                    {t("Screen")}
                  </Button>
                  <Button
                    size={size}
                    variant="secondary"
                    className="max-md:flex-1"
                    onClick={() => void checked(request)}
                  >
                    {t("Done")}
                  </Button>
                </>
              ) : (
                <Button
                  size={size}
                  className="max-md:flex-1"
                  disabled={opening !== null}
                  onClick={() => signIn(request)}
                >
                  {opening === request.id
                    ? t("Opening…")
                    : request.check
                      ? t("Open")
                      : t("Sign in")}
                </Button>
              )}
              <Button
                size={size}
                variant="secondary"
                className="max-md:flex-1"
                onClick={() => void dismiss(request)}
              >
                {t("Not now")}
              </Button>
            </div>
          </div>
        );
      })}
      {/* The sheet covers the lower 60% of a phone: room under the card lets the chat follow it
          up, so the request stays readable above the sheet. */}
      {sheet === null ? null : (
        <div aria-hidden className="md:hidden" style={{ height: "calc(60dvh - 3rem)" }} />
      )}
      {sheet === null
        ? null
        : createPortal(
            <SignInSheet
              environmentId={environmentId}
              site={sheet}
              onClose={() => {
                setSheet(null);
                setHandled((n) => n + 1);
              }}
            />,
            document.body,
          )}
    </>
  );
}

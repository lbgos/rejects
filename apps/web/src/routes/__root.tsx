import {
  Outlet,
  Link,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { ClientSettingsGate } from "../components/ClientSettingsGate";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { GuestShareDialogHost } from "../components/chat/GuestShareControls";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { DevReplayHost } from "../components/DevReplayHost";
import { RelayClientInstallDialog } from "../components/cloud/RelayClientInstallDialog";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ChatGptWelcomeCoordinator } from "../components/settings/ChatGptWelcomeCoordinator";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import { ViewportDebug } from "../components/ViewportDebug";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isChunkLoadError } from "../lib/chunkReloadGuard";
import { UseInAnotherAppDialogHost } from "../components/mcp/UseInAnotherAppDialog";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { useBotTabHostActive } from "../bots/BotTabHost";
import { GUEST_PAGE_PATH } from "../guestPage";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Guest links open on the owner's tunnel host in a browser with no T3 session, and must
    // not trigger pairing or an environment connection.
    if (location.pathname === GUEST_PAGE_PATH) {
      return {
        authGateState: {
          status: "guest",
        } as const,
      };
    }

    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isLocalEnvironmentDisabled() || isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    if (authGateState.status === "authenticated") {
      // Idempotent, so every navigation can ask for it.
      void configureClientTracing();
    }
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}.
        </p>
        <Button render={<Link to="/" replace />}>Back to bots</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  // Above every branch: app services raise toasts for the whole page, so the surface they write to
  // must not unmount when the root switches branches (for example /pair to the app shell).
  // On a phone the bots app raises toasts from the bottom, clear of the title and the tab bar.
  const phoneBots = useBotTabHostActive();
  return (
    <ToastProvider position={phoneBots ? "bottom-center" : "top-right"}>
      <AnchoredToastProvider>
        <RootRouteBranch />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteBranch() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  if (pathname === GUEST_PAGE_PATH) return <Outlet />;

  if (pathname === "/pair") {
    return <Outlet />;
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <>
      <ChatGptWelcomeCoordinator />
      <ViewportDebug />
      <ClientSettingsGate>
        <RelayClientInstallDialog />
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <GuestShareDialogHost />
        <UseInAnotherAppDialogHost />
        {import.meta.env.DEV && primaryEnvironmentAuthenticated ? <DevReplayHost /> : null}
        {appShell}
        {/* Keep the theme editor above the router so drafts survive navigation. */}
        <ThemeEditorHost />
      </ClientSettingsGate>
    </>
  );
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <StandalonePage>
      <StandalonePageHeader title="Something went wrong." description={message} />

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            isChunkLoadError(error) ? window.location.reload() : void router.invalidate()
          }
        >
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload app
        </Button>
        <CopyErrorButton report={report} />
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(report)}>
      {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

// Use only pathname to keep query tokens off the clipboard.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

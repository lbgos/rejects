import { workspaceAreaProps } from "../lib/workspaceFocus";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useRouterState,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMessages } from "gt-react";
import { ChevronLeftIcon, RotateCcwIcon } from "lucide-react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useBotTabHostActive } from "../bots/BotTabHost";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import {
  AppRouteModal,
  AppRouteModalClose,
  AppRouteModalPhoneClose,
} from "../components/AppRouteModal";
import {
  SettingsBreadcrumb,
  settingsBreadcrumbLabel,
} from "../components/settings/SettingsBreadcrumb";
import { SettingsIndexScreen } from "../components/settings/SettingsIndexScreen";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import {
  SettingsPageContainer,
  SettingsPhoneBarContext,
} from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      data-settings-restore
      aria-label="Restore device defaults"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      Restore device defaults
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Reconnect {scope.label} to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const contentArea = workspaceAreaProps("settings", 1, "Settings content");
  // The rendered route's location: a tab switch's view transition snapshots this screen after the
  // pending location has moved on, and the old screen has to stay the one shown.
  const location = useRouterState({
    select: ({ resolvedLocation, location }) => resolvedLocation ?? location,
  });
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const m = useMessages();
  const phone = useMediaQuery("max-md");
  const pageLabel = settingsBreadcrumbLabel(location.pathname);
  const phoneIndex = phone && location.pathname === "/settings";
  const tabHost = useBotTabHostActive();

  // In the bots app the index is the Settings tab, which BotTabHost keeps mounted.
  if (phoneIndex && tabHost) return null;
  if (phoneIndex) {
    return (
      <AppRouteModal label="Settings">
        <SettingsIndexScreen close={<AppRouteModalPhoneClose />} />
      </AppRouteModal>
    );
  }
  return (
    <AppRouteModal label="Settings">
      <div className="relative flex min-h-0 flex-1">
        {phone ? null : <SettingsSidebarNav pathname={location.pathname} />}
        <div {...contentArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            data-settings-page-header
            className="relative flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2 max-md:mt-1 max-md:h-11 max-md:gap-1 max-md:border-b-0 max-md:ps-0 max-md:pe-4"
          >
            {phone ? (
              <>
                {/* A pushed page: the chat header's back button, the page title centered. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="z-10 ms-3"
                  aria-label="Back to settings"
                  render={<Link to="/settings" />}
                >
                  <ChevronLeftIcon />
                </Button>
                <h1 className="pointer-events-none absolute inset-x-18 truncate text-center text-bot-body font-semibold">
                  {pageLabel ? m(pageLabel) : "Settings"}
                </h1>
              </>
            ) : (
              <SettingsBreadcrumb pathname={location.pathname} />
            )}
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {/* A phone's bar holds the page's own action; its reset is a row at the page's end. */}
              {phone ? (
                <div ref={setActionSlot} data-settings-bar-action className="contents" />
              ) : location.pathname === "/settings/general" ? (
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              ) : null}
              {phone ? null : <AppRouteModalClose />}
            </div>
          </header>
          <div key={`${contentScopeKey}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
            <SettingsPhoneBarContext
              value={
                phone && pageLabel
                  ? {
                      titles: [pageLabel, m(pageLabel)],
                      actionSlot,
                      onRestored: () => setRestoreSignal((value) => value + 1),
                    }
                  : null
              }
            >
              <SettingsScopeBoundary pathname={location.pathname}>
                <Outlet />
              </SettingsScopeBoundary>
            </SettingsPhoneBarContext>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers" || pathname === "/settings/secrets"}
      deviceOnly={SETTINGS_DEVICE_ONLY_PATHS.has(pathname)}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      if (window.matchMedia("(width >= 48rem)").matches) {
        throw redirect({ to: "/settings/general", replace: true });
      }
      return;
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});

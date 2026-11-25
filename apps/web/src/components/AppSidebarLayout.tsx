import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Link,
  useLocation,
  useRouter,
  useRouterState,
  type AnyRouter,
} from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "./ui/button";

import { moveWorkspaceFocus, workspaceAreaProps } from "../lib/workspaceFocus";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "../hooks/showThreadUndoNotice";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode } from "../hooks/useSettings";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { BackgroundThreadAnnouncer } from "./BackgroundThreadAnnouncer";
import { BotOverlays } from "../bots/BotOverlays";
import { BOT_TAB_TRANSITION } from "../bots/BotTabBar";
import { BotTabHost } from "../bots/BotTabHost";
import { UiSpotlight } from "../bots/UiSpotlight";
import { BotsSidebar } from "../bots/BotsSidebar";
import { needsFirstRun } from "../bots/firstRun.logic";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useBotsMode } from "../bots/mode";
import { useBots, useBotsLoaded } from "../bots/state";
import { useBotUi } from "../bots/ui";
import "../bots/bots.css";
import { SidebarBrandWidthProbe } from "./sidebar/SidebarChrome";
import { isAppModalPage } from "./sidebar/mainAppLocation";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useMobileSidebarSheetMounted,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { resolveThreadRouteRef } from "../threadRoutes";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

// Cache the synchronous fullscreen IPC read until subscription.
let windowFullscreenSnapshot: boolean | null = null;

function macosDesktopBridge() {
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return window.desktopBridge ?? null;
}

function subscribeToWindowFullscreen(onChange: () => void): () => void {
  const bridge = macosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    windowFullscreenSnapshot = fullscreen;
    onChange();
  });
  // The window may have changed state between the first render and this subscription.
  windowFullscreenSnapshot = bridge.getWindowFullscreenState();
  return () => {
    unsubscribe();
    windowFullscreenSnapshot = null;
  };
}

function readWindowFullscreen(): boolean {
  if (windowFullscreenSnapshot === null) {
    const getWindowFullscreenState = macosDesktopBridge()?.getWindowFullscreenState;
    windowFullscreenSnapshot =
      typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
  }
  return windowFullscreenSnapshot;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function isKeybindingCaptureTarget(event: KeyboardEvent) {
  return event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]");
}

function readRoutePanelsOpen(router: AnyRouter) {
  const routeThreadRef = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
  if (!routeThreadRef) return { terminalOpen: false, previewOpen: false };
  return {
    terminalOpen: selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      routeThreadRef,
    ).terminalOpen,
    previewOpen:
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
      "preview",
  };
}

function registerNavigationHistoryCommands(router: AnyRouter): () => void {
  return registerCommands(
    {
      "navigation.back": (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.history.back();
      },
      "navigation.forward": (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.history.forward();
      },
    },
    {
      when: (event) => !isKeybindingCaptureTarget(event),
      context: () => readRoutePanelsOpen(router),
    },
  );
}

// Capture phase, so F6 also leaves widgets that swallow keys, such as the terminal.
function registerWorkspaceFocusCommands(router: AnyRouter): () => void {
  const move = (direction: 1 | -1) => (event: KeyboardEvent) => {
    if (event.isComposing) return false;
    // Inside a dialog the move is refused, but the key is still consumed.
    event.preventDefault();
    event.stopPropagation();
    moveWorkspaceFocus(direction);
  };
  const disposers = [
    registerCommands(
      { "workspace.focusNext": move(1), "workspace.focusPrevious": move(-1) },
      {
        capture: true,
        when: (event) => !isKeybindingCaptureTarget(event),
        context: () => readRoutePanelsOpen(router),
      },
    ),
    // A focused desktop browser forwards the keys; its renderer focus is stale.
    registerMenuAction("workspace.focusNext", () => moveWorkspaceFocus(1, "panel")),
    registerMenuAction("workspace.focusPrevious", () => moveWorkspaceFocus(-1, "panel")),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

// A held key undoes once. Module state: undoing an archive navigates, and the
// hold must survive whatever that re-renders.
let heldUndoKey: string | null = null;

// Undoes the thread actions in the sidebar's notice. Settings and Usage own
// mod+z while open. Captured so mod+z reaches it before the composer's own
// undo handler consumes the key.
function registerThreadUndoCommands(
  router: AnyRouter,
  readSidebarVisible: () => boolean,
): () => void {
  const threadSidebarShown = () => !isAppModalPage(router.state.location.pathname);
  const unregister = registerCommands(
    {},
    {
      capture: true,
      when: threadSidebarShown,
      onKeyDown: (event) => {
        // Cancel a held key's repeats so they cannot fall through to the
        // editor's own undo, even after the last notice is gone.
        if (event.repeat) {
          if (event.code !== heldUndoKey) return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        // A modifier tapped mid-hold leaves the held key repeating.
        if (!MODIFIER_KEYS.has(event.key)) heldUndoKey = null;
        const command = resolveShortcutCommand(
          event,
          appAtomRegistry.get(primaryServerKeybindingsAtom),
          {
            context: {
              terminalFocus: isTerminalFocused(),
              previewFocus: isPreviewFocused(),
              ...readRoutePanelsOpen(router),
              // A collapsed sidebar hides the notice, so text fields keep their own undo.
              editableFocus:
                isEditableFocused(event.target) &&
                !(readSidebarVisible() && threadUndoClaimsShortcut()),
              modelPickerOpen: isModelPickerOpen(),
            },
          },
        );
        if (command !== "thread.undo") {
          if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
          return false;
        }
        if (isCommandPaletteOpen() || isModelPickerOpen()) return false;
        if (!undoLatestThreadAction()) return false;
        heldUndoKey = event.code;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    },
  );
  // Pastes from a menu, dictation and drops edit text without a keypress.
  const onInput = () => {
    if (threadSidebarShown()) releaseThreadUndoShortcut();
  };
  window.addEventListener("input", onInput, true);
  return () => {
    unregister();
    window.removeEventListener("input", onInput, true);
  };
}

/** Keyboard and menu commands that live as long as the app shell. */
function registerAppShellCommands(router: AnyRouter, shellElement: Element): () => void {
  // The provider mirrors the visibility it renders onto its wrapper, so the
  // committed state is readable when a key arrives.
  const readSidebarVisible = () =>
    shellElement.closest('[data-slot="sidebar-wrapper"]')?.getAttribute("data-sidebar-state") ===
    "expanded";
  const disposers = [
    registerThreadUndoCommands(router, readSidebarVisible),
    registerNavigationHistoryCommands(router),
    registerWorkspaceFocusCommands(router),
    registerMenuAction("open-settings", () => {
      if (!/^\/settings(\/|$)/.test(router.state.location.pathname)) {
        const desktop = window.matchMedia("(width >= 48rem)").matches;
        void router.navigate({
          to: desktop ? "/settings/general" : "/settings",
          viewTransition: desktop ? BOT_TAB_TRANSITION : false,
        });
      }
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function SidebarControl({ showSidebar }: { readonly showSidebar: boolean }) {
  const router = useRouter();
  // The rendered route, as useBotsMode reads it, so a view transition's snapshot of the old
  // screen never gains the new screen's back button.
  const shown = useRouterState({
    select: ({ resolvedLocation, location }) => {
      const { pathname, searchStr } = resolvedLocation ?? location;
      if (isAppModalPage(pathname)) return "settings";
      if (pathname === "/connections") return searchStr === "" ? "you" : "you-detail";
      return null;
    },
  });
  const connectionsDetail = shown === "you-detail";
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile } = useSidebar();
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  const isSidebarVisible = useSidebarVisibility();
  const botsMode = useBotsMode();
  const botPageOpen = useBotUi((ui) => ui.panel !== null || ui.dialog !== null);
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener that toggles the sidebar on its shortcut
  useEffect(() => {
    // A hidden sidebar would still save the toggle, so the shortcut does nothing without one.
    if (!showSidebar) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event, window.getSelection()) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B only to bold selected text;
        // the toggle stays available everywhere else.
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, showSidebar, toggleSidebar]);

  // The control lives as long as the shell, so it carries the shell's commands. Created
  // once so re-renders never re-register them.
  const [appShellCommandsRef] = useState(
    () => (node: HTMLDivElement | null) =>
      node === null ? undefined : registerAppShellCommands(router, node),
  );

  return (
    <div
      ref={appShellCommandsRef}
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        (mobileSidebarSheetMounted || (isMobile && botPageOpen)) && "hidden",
      )}
      data-sidebar-control=""
    >
      {/* On a phone the tab screens (Bots, You, Settings) have no back; a bot chat or a detail page does. */}
      {isMobile && botsMode.active ? (
        botsMode.home || shown === "you" || shown === "settings" ? null : (
          <Button
            variant="ghost"
            size="icon-pill"
            className="pointer-events-auto"
            aria-label={connectionsDetail ? "Back to connections" : "Back to bots"}
            render={
              connectionsDetail ? (
                <Link to="/connections" viewTransition={{ types: ["bots-pop"] }} />
              ) : (
                <Link
                  to="/bots"
                  search={{ thread: undefined }}
                  viewTransition={{ types: ["bots-pop"] }}
                />
              )
            }
          >
            <ChevronLeftIcon />
          </Button>
        )
      ) : isMobile && showSidebar ? (
        // A coding page on a phone: the way back to the bots app, then its list of threads.
        <div className="pointer-events-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-pill"
            data-phone-bar-disc
            aria-label="Back to bots"
            render={<Link to="/bots" search={{ thread: undefined }} />}
          >
            <ChevronLeftIcon />
          </Button>
          <SidebarTrigger variant="ghost" data-phone-bar-disc aria-label="Threads" />
        </div>
      ) : showSidebar ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTrigger
                variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
                className={cn(
                  "pointer-events-auto",
                  isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
                )}
                aria-label="Toggle main sidebar"
              />
            }
          />
          <TooltipPopup side="bottom">
            Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function AppSidebarLayout({
  children,
  showSidebar: sidebarWanted = true,
}: {
  children: ReactNode;
  showSidebar?: boolean;
}) {
  const botsMode = useBotsMode();
  // First run is a page of its own, as on a phone: the sidebar has no bots to list until setup
  // has made the main bot.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const setupBots = useBots(primaryEnvironmentId);
  const botsLoaded = useBotsLoaded(primaryEnvironmentId);
  const settingUp = botsMode.home && botsLoaded && needsFirstRun(setupBots);
  const showSidebar = sidebarWanted && !settingUp;
  // bots.css keys off this attribute, not `:root:has()`: Chromium restyles the whole document for a
  // root `:has()` on every DOM change, such as a streamed paragraph or the working timer's tick.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors bots mode onto <html>, outside React's tree, before paint
  useLayoutEffect(() => {
    if (!botsMode.active) return;
    document.documentElement.setAttribute("data-bots-app", "");
    return () => document.documentElement.removeAttribute("data-bots-app");
  }, [botsMode.active]);
  const sidebarArea = workspaceAreaProps("sidebar", 0, "Bots");
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // A clamped drag may not change width, so viewport changes need a separate subscription.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const sidebarMinimumWidth = resolveThreadSidebarMinimumWidth(brandWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth, sidebarMinimumWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive && !botsMode.active ? "true" : "false"}
        data-bots-mode={botsMode.active ? "true" : undefined}
        defaultOpen
        storageKey="chat_thread_sidebar_open"
        style={sidebarProviderStyle}
      >
        {showSidebar ? (
          <>
            <SidebarBrandWidthProbe isElectron={isElectron} onWidthChange={setBrandWidth} />
            {botsMode.active ? (
              // iOS 26+ draws a soft blur over the web view's top edge unless a full-width opaque
              // fixed element sits there; with one it fills the edge with that colour (WebKit 301756).
              // It stays hit-testable so the edge finds it, not the translucent chat header under it.
              <div
                aria-hidden
                data-top-edge
                className="fixed inset-x-0 top-0 z-50 h-1.5 bg-background md:hidden"
              />
            ) : null}
            <Sidebar
              side="left"
              collapsible="offcanvas"
              data-app-sidebar=""
              {...sidebarArea}
              role="navigation"
              aria-label="Bots"
              resizable={{
                maxWidth: sidebarMaximumWidth,
                minWidth: sidebarMinimumWidth,
                shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                  nextWidth <= currentWidth ||
                  wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
                storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
                onResize: setSidebarWidth,
              }}
              style={windowControlsInsetStyle}
            >
              <BotsSidebar />
              <SidebarRail onDoubleClick={resetSidebarWidth} />
            </Sidebar>
          </>
        ) : null}
        {children}
        <BackgroundThreadAnnouncer />
        {botsMode.active ? <BotOverlays /> : null}
        <BotTabHost />
        <UiSpotlight />
        <SidebarControl showSidebar={showSidebar} />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}

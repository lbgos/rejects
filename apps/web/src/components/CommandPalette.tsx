import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  ClockIcon,
  MessageSquareIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  TextSearchIcon,
  UserIcon,
} from "lucide-react";
import { BotAvatar } from "../bots/BotAvatar";
import { useBotsMode } from "../bots/mode";
import { useBots } from "../bots/state";
import { openBotDialog, openBotPanel } from "../bots/ui";
import { t } from "../i18n";
import { openThreadFind } from "./chat/threadFindStore";
import { dispatchPreviewAction } from "./preview/previewActionBus";
import { previewBridge } from "./preview/previewBridge";
import {
  useDeferredValue,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../lib/workspaceFocus";
import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  useAnyEnvironmentHiding,
  useEnvironmentThreadRefs,
  useHiddenThreadKeys,
} from "../state/entities";
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  ADDON_ICON_CLASS,
  buildRootGroups,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  buildNestedSearchItems,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { useCommandPaletteThreadItems } from "./CommandPaletteThreadItems";
import { useCommandPaletteThemeItems } from "./CommandPaletteThemeItems";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { openUseInAnotherApp } from "./mcp/UseInAnotherAppDialog";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { primaryServerKeybindingsAtom } from "../state/server";
import { resolveShortcutCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { threadRecentUse } from "@t3tools/shared/paletteSearch";

/** The submenu an open intent starts in; its groups resolve while rendering. */
function openIntentView(intent: CommandPaletteOpenIntent | null): CommandPaletteView | null {
  return intent?.kind === "change-theme"
    ? {
        addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "themes", label: "Change theme", items: [] }],
      }
    : null;
}

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <ThreadContextDragGhost />
      <CommandDialog open={state.open} onOpenChange={setOpen}>
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          session={state.session}
          openIntent={state.openIntent}
          setOpen={setOpen}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden"
      data-command-palette="true"
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        // Behind the Settings modal the composer is inert and cannot take focus.
        if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      <OpenCommandPaletteDialog
        key={props.session}
        openIntent={props.openIntent}
        setOpen={props.setOpen}
      />
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { setOpen } = props;
  // Keyed by palette session: the intent only seeds this mount.
  const [linkedThreadSearch] = useState(() =>
    props.openIntent?.kind === "search" ? props.openIntent : null,
  );
  // Rows were captured when the palette opened; drop any hidden since then.
  const hiddenKeys = useHiddenThreadKeys();
  const linkedEnvironmentId = linkedThreadSearch?.linkedThreads?.environmentId ?? null;
  const hidingAnywhere = useAnyEnvironmentHiding();
  const linkedThreadRefs = useEnvironmentThreadRefs(linkedEnvironmentId);
  const [searchState, dispatchSearch] = useReducer(reduceCommandPaletteSearchState, null, () => {
    const view = openIntentView(props.openIntent);
    return view
      ? { query: "", views: [{ view, parentQuery: "" }] }
      : createCommandPaletteSearchState(linkedThreadSearch?.query ?? "");
  });
  const { query, views: viewStack } = searchState;
  const setQuery = (query: string) => dispatchSearch({ type: "query", query });
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // A pushed view drops the typed highlight until the user moves it again.
  const highlightClearedRef = useRef(viewStack.length > 0);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bots = useBots(primaryEnvironmentId);
  const botsMode = useBotsMode();
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const routeTarget = useThreadRouteTarget();
  const activeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { changeThemeItem, changeAppearanceItem, themeEditorItem } = useCommandPaletteThemeItems();
  const currentView = viewStack.at(-1)?.view ?? null;
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing: false });

  const activeThreadPreviewOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, activeThreadRef) === "preview",
  );
  const supportsThreadFind =
    environments.find((environment) => environment.environmentId === activeThreadRef?.environmentId)
      ?.serverConfig?.threadFind === true;

  const {
    threadItems: allThreadItems,
    threadMessageItems,
    now: searchNow,
    isSearchPending: isThreadSearchPending,
  } = useCommandPaletteThreadItems({
    activeThread: activeThreadRef
      ? { environmentId: activeThreadRef.environmentId, id: activeThreadRef.threadId }
      : null,
    threadSearchQuery,
  });
  // Recent means used recently: written in or opened, whichever is later. The
  // open chat would always lead that list, so it is left out.
  const activeThreadValue = activeThreadRef
    ? `thread:${activeThreadRef.environmentId}:${activeThreadRef.threadId}`
    : null;
  const recentThreadItems = allThreadItems
    .filter((item) => item.value !== activeThreadValue)
    .toSorted(
      (left, right) =>
        (right.threadSearch ? threadRecentUse(right.threadSearch) : 0) -
        (left.threadSearch ? threadRecentUse(left.threadSearch) : 0),
    )
    .slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useStableCallback((view: CommandPaletteView): void => {
    dispatchSearch({ type: "push", view });
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  });

  function popView(): void {
    dispatchSearch({ type: "back" });
    setHighlightedItemValue(null);
  }

  function handleQueryChange(nextQuery: string): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (activeThreadKey !== null && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current chat",
      searchTerms: ["find", "search", "messages"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        openThreadFind(activeThreadKey);
      },
    });
  }

  if (activeThreadPreviewOpen && previewBridge) {
    actionItems.push({
      kind: "action",
      value: "find-in-browser-page",
      title: "Find on page in browser",
      searchTerms: ["find", "search", "browser", "preview", "page"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "preview.find",
      run: async () => {
        dispatchPreviewAction("find");
      },
    });
  }

  actionItems.push(changeThemeItem);
  actionItems.push(changeAppearanceItem);
  actionItems.push(themeEditorItem);

  actionItems.push({
    kind: "action",
    value: "action:use-in-another-app",
    searchTerms: [
      "mcp",
      "connector",
      "another app",
      "poke",
      "claude",
      "chatgpt",
      "grok",
      "muse",
      "instinct",
      "openclaw",
      "hermes",
    ],
    title: "Use rejects in another app (MCP)",
    icon: <PlugIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openUseInAnotherApp(activeThreadRef?.environmentId ?? null);
    },
  });

  for (const direction of [1, -1] as const) {
    const title = direction === 1 ? "Focus Next Workspace Area" : "Focus Previous Workspace Area";
    actionItems.push({
      kind: "action",
      value: `action:workspace-focus:${direction}`,
      title,
      searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
      icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious",
      run: async () => {
        queueWorkspaceFocusFromPalette(direction);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  const botItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  // The route names the open chat; a bot's thread is not always among the loaded threads.
  const openThreadId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const openBot = openThreadId ? bots.find((bot) => bot.threadId === openThreadId) : undefined;
  if (primaryEnvironmentId !== null) {
    const environmentId = primaryEnvironmentId;
    // The bot form and a bot's panels are drawn by the bots app, so a command opens it first.
    const inBotsApp = async () => {
      if (!botsMode.active) await navigate({ to: "/bots", search: { thread: undefined } });
    };
    if (bots.length > 0) {
      botItems.push({
        kind: "submenu",
        value: "action:open-bot",
        searchTerms: ["bot", "open", "chat", "switch"],
        title: t("Open bot…"),
        icon: <BotIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <BotIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "open-bot",
            label: t("Bots"),
            items: bots.map((bot) => ({
              kind: "action" as const,
              value: `bot:${bot.threadId}`,
              searchTerms: ["bot", bot.name, bot.description ?? ""],
              title: bot.name,
              ...(bot.description ? { description: bot.description } : {}),
              icon: <BotAvatar bot={bot} className="size-5 shrink-0" />,
              run: async () => {
                await navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: bot.threadId },
                });
              },
            })),
          },
        ],
      });
    }
    botItems.push({
      kind: "action",
      value: "action:new-bot",
      searchTerms: ["new bot", "create bot", "add bot", "assistant"],
      title: t("New bot"),
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await inBotsApp();
        openBotDialog({ environmentId, threadId: null, focus: null });
      },
    });
    if (openBot) {
      const target = scopeThreadRef(environmentId, openBot.threadId);
      botItems.push({
        kind: "action",
        value: "action:bot-details",
        searchTerms: ["schedule", "activity", "memory", "notes", "runs", openBot.name],
        title: t("Schedule and memory"),
        description: openBot.name,
        icon: <ClockIcon className={ITEM_ICON_CLASS} />,
        run: async () => openBotPanel(target, "schedule"),
      });
      botItems.push({
        kind: "action",
        value: "action:bot-edit",
        searchTerms: ["edit bot", "rename", "model", "job", "limit", openBot.name],
        title: t("Edit bot"),
        description: openBot.name,
        icon: <SlidersHorizontalIcon className={ITEM_ICON_CLASS} />,
        run: async () => openBotDialog({ environmentId, threadId: openBot.threadId, focus: null }),
      });
    }
    botItems.push({
      kind: "action",
      value: "action:you",
      searchTerms: ["you", "accounts", "notes", "sign-ins", "nightly check", "telegram"],
      title: t("You"),
      icon: <UserIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/connections" });
      },
    });
  }

  // Bots are opened from their own group, so they stay out of the recent threads.
  const botThreadValues = new Set(
    bots.map((bot) => `thread:${primaryEnvironmentId}:${bot.threadId}`),
  );
  const rootGroups = buildRootGroups({
    botItems,
    actionItems,
    recentThreadItems: recentThreadItems.filter((item) => !botThreadValues.has(item.value)),
  });
  // Every setting goes to the palette's own matcher, so settings get the same
  // word starts and typo tolerance as chats.
  const settingsSearchItems: CommandPaletteActionItem[] = settingsForThisPlatform(
    availableSettingsSearchItems,
  ).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
    title: item.title,
    description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
  const activeGroups =
    currentView?.groups[0]?.value === "themes"
      ? changeThemeItem.groups
      : currentView?.groups[0]?.value === "appearance"
        ? changeAppearanceItem.groups
        : (currentView?.groups ?? rootGroups);

  const isLinkedThreadSearch =
    linkedThreadSearch?.linkedThreads !== undefined && deferredQuery === linkedThreadSearch.query;
  const displayedGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    ...(deferredQuery.trim().length > 0
      ? {
          allOptions: {
            rootGroups,
            nestedItems: buildNestedSearchItems(actionItems, deferredQuery),
          },
        }
      : {}),
    projectSearchItems: [],
    settingsSearchItems,
    threadSearchItems:
      isLinkedThreadSearch && linkedThreadSearch?.linkedThreads
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            threads: visibleLinkedThreads(
              linkedThreadSearch.linkedThreads.threads,
              linkedThreadSearch.linkedThreads.environmentId,
              linkedThreadRefs,
              hiddenKeys,
              hidingAnywhere,
            ),
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : allThreadItems,
    threadMessageItems: isLinkedThreadSearch ? [] : threadMessageItems,
    now: searchNow,
  });
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const isSubmenu = paletteMode === "submenu";

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === "Enter") {
        // Confirming an IME candidate must not select a row.
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      }
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    });
    // ChatView ignores shortcuts while the palette is open, so intercept find here.
    if (command === "chat.find" && activeThreadKey !== null) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      if (supportsThreadFind) openThreadFind(activeThreadKey);
      else
        toastManager.add({
          id: "thread-find-unavailable",
          title: "Chat search is unavailable on this server.",
          description: "Update the server to enable it.",
        });
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;

    const firstItemValue = resultRows.itemValues[0];
    if (event.key === "ArrowDown" && highlightClearedRef.current && firstItemValue) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
        true,
      );
      return;
    }

    // Virtualization may unmount the highlighted row; handle Enter directly instead of Base UI's click.
    if (event.key === "Enter") {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushPaletteView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  return (
    <CommandPaletteContent
      key={viewStack.length}
      aria-label="Command palette"
      autoHighlight="always"
      footerTrailing={
        isThreadSearchPending && !isLinkedThreadSearch ? (
          // In the footer, so the list keeps its height while message results may
          // still arrive below it.
          <span className="text-muted-foreground text-xs">Searching messages…</span>
        ) : null
      }
      inputProps={{
        placeholder: getCommandPaletteInputPlaceholder(paletteMode),
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(
            resultListRef.current,
            rowIndex,
            eventDetails.index === 0,
          );
        }
      }}
      onValueChange={(nextQuery) => handleQueryChange(nextQuery)}
      showBackHint={isSubmenu}
      value={query}
    >
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(isThreadSearchPending ? { emptyStateMessage: "Searching chat messages…" } : {})}
      />
    </CommandPaletteContent>
  );
}

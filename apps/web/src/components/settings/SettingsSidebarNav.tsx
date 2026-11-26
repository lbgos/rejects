import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CalendarClockIcon,
  InfoIcon,
  MessageSquareTextIcon,
  KeyRoundIcon,
  MicIcon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { resolveEventKeys } from "@t3tools/shared/keybindings";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  revealSettingsSearchTarget,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { handleSettingsSectionKeyDown } from "./settingsSectionNavigation";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { rememberBackPage } from "../../bots/backPage";

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": WrenchIcon,
  "/settings/voice": MicIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/chat": MessageSquareTextIcon,
  "/settings/providers": BotIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/access": ShieldCheckIcon,
  "/settings/secrets": KeyRoundIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/about": InfoIcon,
};

// Detail pages without a nav entry highlight the page that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/maintenance",
  "/settings/open-source-licenses": "/settings/about",
};

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

export function SettingsSidebarNav({ pathname, header }: { pathname: string; header?: ReactNode }) {
  const gt = useGT();
  const m = useMessages();
  const navArea = workspaceAreaProps("settings-nav", 0, gt("Settings sections"));
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const phone = useMediaQuery("max-md");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const navPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
  const availableItems = useAvailableSettingsSearchItems();
  const searchableItems = availableItems.filter((item) =>
    navPaths.includes(SETTINGS_DETAIL_PAGE_PARENTS[item.to] ?? item.to),
  );
  const results = searchSettings(query, searchableItems, m);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the find and slash search shortcuts
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const eventKeys = resolveEventKeys(event);
      const isFindShortcut =
        eventKeys.has("f") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      // Shift is allowed only when the layout types "/" with it (German Shift+7); Shift on
      // the physical Slash key types "?" or "," instead.
      const isSlashShortcut =
        eventKeys.has("/") &&
        (event.key === "/" || !event.shiftKey) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSectionClick = (to: SettingsPath) => {
    if (phone) rememberBackPage();
    const viewTransition = phone
      ? { types: ["bots-push"] }
      : to === pathname
        ? false
        : SETTINGS_DETAIL_PAGE_PARENTS[pathname] === to
          ? { types: ["bots-settings-pop"] }
          : { types: ["bots-settings-tab"] };
    void navigate({
      to,
      hash: "",
      replace: !phone,
      hashScrollIntoView: false,
      viewTransition,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    const targetId = item.targetId ?? item.id;
    revealSettingsSearchTarget(targetId);
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    if (phone) rememberBackPage();
    void navigate({
      to: item.to,
      hash: targetId,
      replace: !phone,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
      viewTransition: phone
        ? { types: ["bots-push"] }
        : item.to !== pathname
          ? { types: ["bots-settings-tab"] }
          : false,
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <nav
      {...navArea}
      role="navigation"
      className="flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-e-0 max-md:bg-transparent"
    >
      <SidebarContent className="overflow-x-hidden">
        {header}
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div data-settings-search-row className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground max-md:h-11">
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                <SidebarInput
                  ref={searchInputRef}
                  nativeInput
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setActiveResultIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={gt("Search")}
                  aria-label={gt("Search settings")}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isSearching && hasResults}
                  aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                  aria-activedescendant={
                    isSearching && results[activeResultIndex]
                      ? `settings-search-result-${results[activeResultIndex].id}`
                      : undefined
                  }
                  className="min-w-0 flex-1"
                />
                {isSearching ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    className="shrink-0"
                    aria-label={gt("Clear settings search")}
                    onClick={() => {
                      clearSearch();
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : phone ? null : (
                  <Kbd>/</Kbd>
                )}
              </div>
              {phone && isSearching ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.blur();
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                <T>No settings found</T>
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? gt("Settings search results") : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem
                    key={item.id}
                    role="presentation"
                    ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                  >
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">
                          {m(item.title)}
                        </span>
                        <span className="block truncate text-2xs text-sidebar-muted-foreground/75">
                          {m(SETTINGS_SECTION_LABELS[item.to])}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div className="flex flex-col gap-4">
                <div
                  onKeyDown={handleSettingsSectionKeyDown}
                  className="flex flex-col gap-4 max-md:gap-2"
                >
                  {SETTINGS_NAV_GROUPS.map((group, index) => (
                    <div
                      key={group.heading}
                      className="flex flex-col gap-1 max-md:border-t max-md:border-sidebar-border max-md:pt-2 max-md:first:border-t-0 max-md:first:pt-0"
                    >
                      <h3
                        id={`settings-nav-group-${index}`}
                        className={cn(
                          "px-2 text-xs font-medium text-sidebar-muted-foreground/80",
                          group.headingHidden ? "sr-only" : "max-md:sr-only",
                        )}
                      >
                        {m(group.heading)}
                      </h3>
                      {/* The heading stays outside the group it names so NVDA does not read the name twice. */}
                      <div role="group" aria-labelledby={`settings-nav-group-${index}`}>
                        <SidebarMenu>
                          {group.paths.map((to) => {
                            const Icon = SETTINGS_SECTION_ICONS[to];
                            const isActive = activePath === to || activePath.startsWith(`${to}/`);
                            return (
                              <SidebarMenuItem key={to}>
                                <SidebarMenuButton
                                  data-settings-section={to}
                                  aria-current={isActive ? "page" : undefined}
                                  isActive={isActive}
                                  variant={phone ? "strong" : "default"}
                                  size={phone ? "lg" : "default"}
                                  onClick={() => handleSectionClick(to)}
                                >
                                  <Icon />
                                  <span className="min-w-0 flex-1 truncate">
                                    {m(SETTINGS_SECTION_LABELS[to])}
                                  </span>
                                  {phone ? <ChevronRightIcon /> : null}
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            );
                          })}
                        </SidebarMenu>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="max-md:hidden">
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        <Suspense fallback={null}>
          <T3ConnectSidebarAvatar />
        </Suspense>
      </SidebarFooter>
    </nav>
  );
}

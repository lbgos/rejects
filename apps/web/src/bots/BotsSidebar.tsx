import { EnvironmentId } from "@t3tools/contracts";
import { SearchIcon, SettingsIcon, SquarePenIcon, UserIcon, XIcon } from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { isElectron } from "../env";
import { SidebarChromeHeader, SidebarUtilityItem } from "../components/sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { Button } from "../components/ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
} from "../components/ui/sidebar";
import { t } from "../i18n";
import { usePrimaryEnvironmentId } from "../state/environments";
import { BotList } from "./BotList";
import { BOT_TAB_TRANSITION } from "./BotTabBar";
import { noteTabSwitch } from "./tabTransitionProbe";
import { openBotDialog } from "./ui";

export function BotsSidebar() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const params = useParams({ strict: false });
  const environmentId = params.environmentId
    ? EnvironmentId.make(params.environmentId)
    : primaryEnvironmentId;
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                <SidebarInput
                  nativeInput
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t("Search")}
                  aria-label={t("Search bots")}
                  className="min-w-0 flex-1"
                />
                {query ? (
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    className="shrink-0"
                    aria-label={t("Clear search")}
                    onClick={() => setQuery("")}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              {environmentId ? (
                <SidebarHeaderIconButton
                  label={t("New bot")}
                  data-ui-target="new_bot"
                  onClick={() => openBotDialog({ environmentId, threadId: null, focus: null })}
                >
                  <SquarePenIcon />
                </SidebarHeaderIconButton>
              ) : null}
            </div>
          </SidebarGroup>
        }
      >
        {environmentId ? (
          <BotList
            environmentId={environmentId}
            selectedThreadId={params.threadId ?? null}
            query={query}
          />
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="flex-row items-center">
          <SidebarUtilityItem
            icon={<UserIcon />}
            label={t("You")}
            uiTarget="accounts"
            onClick={() => {
              noteTabSwitch("sidebar", "you");
              void navigate({ to: "/connections", viewTransition: BOT_TAB_TRANSITION });
            }}
          />
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label={t("Settings")}
            uiTarget="settings"
            onClick={() => {
              noteTabSwitch("sidebar", "settings");
              // The page the /settings redirect lands on here: a redirect drops the transition.
              void navigate({
                to: window.matchMedia("(width >= 48rem)").matches
                  ? "/settings/general"
                  : "/settings",
                viewTransition: BOT_TAB_TRANSITION,
              });
            }}
          />
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

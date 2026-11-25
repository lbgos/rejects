import { useRouterState, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { SettingsIndexScreen } from "../components/settings/SettingsIndexScreen";
import { ConnectionsScreen } from "../connections/ConnectionsScreen";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePrimaryEnvironmentId } from "../state/environments";
import { BotTabBar, type BotTab } from "./BotTabBar";
import { BotsHome } from "./BotsHome";
import { EnvironmentConnecting } from "./EnvironmentConnecting";
import { useBotsMode } from "./mode";

const TABS: readonly BotTab[] = ["bots", "you", "settings"];

type TabSlideDir = "forward" | "back";

/** True where BotTabHost draws the tab screens, so their routes render nothing. */
export function useBotTabHostActive() {
  const phone = useMediaQuery("max-md");
  const { active } = useBotsMode();
  return phone && active;
}

/**
 * The phone's three tab screens, kept mounted so each is drawn with its data before it shows, and
 * the tab bar, which sits outside them and never moves. A tab switch slides the outgoing and
 * incoming screens together in the matching direction (bots.css); leaving for a chat or a detail
 * page hides them at once so the push or pop view transition owns the move.
 */
export function BotTabHost() {
  const active = useBotTabHostActive();
  return active ? <TabScreens /> : null;
}

function TabScreens() {
  const environmentId = usePrimaryEnvironmentId();
  // The rendered route, so a push or pop's snapshot of the old screen stays that screen.
  const screen = useRouterState({
    select: ({ resolvedLocation, location }) => {
      const { pathname, searchStr } = resolvedLocation ?? location;
      if (pathname === "/bots") return "bots";
      if (pathname === "/connections") return searchStr === "" ? "you" : "you-detail";
      if (pathname === "/settings") return "settings";
      return null;
    },
  });
  const pane: BotTab | null = screen === "you-detail" ? "you" : screen;
  const thread = useSearch({ strict: false, select: (search) => search.thread });
  // Only a switch between two tab screens slides; arriving from or leaving for a chat or detail
  // page is instant here, since the push or pop view transition already animates it.
  const [slide, setSlide] = useState<{
    readonly pane: BotTab | null;
    readonly leaving: BotTab | null;
    readonly dir: TabSlideDir | null;
    readonly seq: number;
  }>({ pane, leaving: null, dir: null, seq: 0 });
  if (slide.pane !== pane) {
    const switching = slide.pane !== null && pane !== null;
    setSlide({
      pane,
      leaving: switching ? slide.pane : null,
      dir: switching ? (TABS.indexOf(pane) > TABS.indexOf(slide.pane) ? "forward" : "back") : null,
      seq: slide.seq + 1,
    });
  }

  return (
    <div data-bot-tab-host data-tab={pane ?? "none"} data-dir={slide.dir ?? undefined}>
      {TABS.map((id) => (
        <div
          key={id}
          data-bot-tab-pane={id}
          data-active={pane === id}
          data-leaving={slide.leaving === id || undefined}
          inert={pane !== id}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || slide.leaving !== id) return;
            const finishedSeq = slide.seq;
            setSlide((current) =>
              current.seq === finishedSeq ? { ...current, leaving: null, dir: null } : current,
            );
          }}
          className="fixed inset-0 flex h-dvh min-h-0 flex-col overflow-hidden"
        >
          {id === "bots" ? (
            <BotsHome thread={thread} />
          ) : id === "you" ? (
            environmentId ? (
              <ConnectionsScreen environmentId={environmentId} visible={pane === "you"} />
            ) : (
              <EnvironmentConnecting />
            )
          ) : (
            <SettingsIndexScreen />
          )}
        </div>
      ))}
      {screen === "bots" || screen === "you" || screen === "settings" ? (
        <BotTabBar active={screen} />
      ) : null}
    </div>
  );
}

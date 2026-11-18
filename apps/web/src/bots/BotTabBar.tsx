import { useNavigate } from "@tanstack/react-router";
import type { UiTarget } from "@t3tools/contracts";
import { MessageCircleIcon, SlidersHorizontalIcon, UserIcon } from "lucide-react";
import { t } from "../i18n";
import { noteTabSwitch } from "./tabTransitionProbe";

export type BotTab = "bots" | "you" | "settings";

/** The desktop sidebar's You and Settings cross-fade the main area (bots.css). */
export const BOT_TAB_TRANSITION = { types: ["bots-tab"] };

/** The phone's tab bar; BotTabHost draws it outside the tab screens, so a switch never moves it. */
export function BotTabBar({ active }: { active: BotTab }) {
  const navigate = useNavigate();
  const tabs = [
    {
      id: "bots",
      label: t("Bots"),
      Icon: MessageCircleIcon,
      to: "/bots",
      target: "bots" satisfies UiTarget,
    },
    {
      id: "you",
      label: t("You"),
      Icon: UserIcon,
      to: "/connections",
      target: "accounts" satisfies UiTarget,
    },
    {
      id: "settings",
      label: t("Settings"),
      Icon: SlidersHorizontalIcon,
      to: "/settings",
      target: "settings" satisfies UiTarget,
    },
  ] as const;
  return (
    <nav
      data-bots-tab-bar
      aria-label={t("Bots app")}
      className="fixed start-4 bottom-[max(calc(env(safe-area-inset-bottom)-0.5rem),0.75rem)] z-20"
    >
      <div className="surface-glass flex h-15.5 items-center gap-0.5 rounded-full border border-border/60 px-1.5 shadow-sm">
        {tabs.map(({ id, label, Icon, to, target }) => (
          <button
            key={id}
            type="button"
            data-ui-target={target}
            aria-current={id === active ? "page" : undefined}
            onClick={() => {
              if (id === active) return;
              noteTabSwitch(active, id);
              void navigate({ to });
            }}
            className="flex h-13 w-21 cursor-pointer flex-col items-center justify-center gap-px rounded-full text-2xs font-semibold text-foreground/90 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:scale-[0.96] active:bg-foreground/12 aria-[current=page]:bg-foreground/12 aria-[current=page]:text-foreground"
          >
            <Icon aria-hidden strokeWidth={1.75} className="size-6" />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

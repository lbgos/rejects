import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { BotList } from "./BotList";
import { EnvironmentConnecting } from "./EnvironmentConnecting";
import { FirstRun } from "./FirstRun";
import { needsFirstRun } from "./firstRun.logic";
import { botActivityAt } from "./presentation";
import { useBots, useBotsLoaded } from "./state";
import { openBotDialog } from "./ui";
import { useOnline } from "./useOnline";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

export function BotsHome({ thread }: { thread?: string | undefined }) {
  const environmentId = usePrimaryEnvironmentId();
  const bots = useBots(environmentId);
  const navigate = useNavigate();
  const phone = useMediaQuery("max-md");
  const online = useOnline();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // While searching, the page fits above the keyboard so the last results can scroll into view.
  useVisualViewportHeight(phone && searching);
  const shells = useThreadShells();
  const lastMessageAt = (bot: (typeof bots)[number]) =>
    botActivityAt(
      bot,
      shells.find((shell) => shell.id === bot.threadId && shell.environmentId === environmentId)
        ?.source,
    );
  const requested = bots.find((b) => b.threadId === thread);
  // Until setup has made the main bot, the home page is setup: nothing is opened in its place.
  const setup = useBotsLoaded(environmentId) && needsFirstRun(bots);
  const target =
    requested || phone || setup
      ? requested
      : bots.toSorted((a, b) => lastMessageAt(b) - lastMessageAt(a))[0];
  const targetThreadId = target?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the router on the selected bot when the bot list arrives
  useEffect(() => {
    if (targetThreadId && environmentId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: targetThreadId },
        replace: true,
      });
  }, [environmentId, navigate, targetThreadId]);
  if (!environmentId) return <EnvironmentConnecting />;
  if (setup && !requested) return <FirstRun environmentId={environmentId} />;
  if (!phone) return target ? null : <NoBots environmentId={environmentId} />;
  return (
    <div
      data-back-page
      data-bots-page
      data-bot-searching={searching || undefined}
      className="relative flex h-full max-h-[var(--app-height,100dvh)] min-h-0 flex-col bg-background pt-safe text-foreground"
    >
      {searching ? (
        <BotSearchBar
          query={query}
          setQuery={setQuery}
          onClose={() => {
            setQuery("");
            setSearching(false);
          }}
        />
      ) : (
        <header className="mt-1 flex h-11 shrink-0 items-center justify-end bg-background px-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("New bot")}
            data-ui-target="new_bot"
            onClick={() => openBotDialog({ environmentId, threadId: null, focus: null })}
          >
            <SquarePenIcon />
          </Button>
        </header>
      )}
      {/* Pull to refresh moves the title and rows together. */}
      <div data-pull-area className="relative flex min-h-0 flex-1 flex-col">
        {/* Offline shares the title's line, so losing the network never moves the list. */}
        {searching ? null : (
          <div className="flex shrink-0 items-baseline justify-between px-5 pt-5 pb-2">
            <h1 className="text-bot-title font-bold">{t("Bots")}</h1>
            {online ? null : (
              <p className="text-bot-footnote text-muted-foreground">{t("Offline")}</p>
            )}
          </div>
        )}
        <BotList environmentId={environmentId} query={query} />
      </div>
      {searching ? null : (
        <button
          type="button"
          aria-label={t("Search bots")}
          data-bots-tab-search
          className="surface-glass fixed end-4 bottom-[max(calc(env(safe-area-inset-bottom)-0.5rem),0.75rem)] z-20 flex size-15.5 cursor-pointer items-center justify-center rounded-full border border-border/60 text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:scale-[0.96]"
          onClick={() => setSearching(true)}
        >
          <SearchIcon className="size-5.5" />
        </button>
      )}
    </div>
  );
}

function BotSearchBar({
  query,
  setQuery,
  onClose,
}: {
  query: string;
  setQuery: (query: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-1 flex h-11 shrink-0 items-center gap-1 ps-4 pe-2">
      <InputGroup className="flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          type="search"
          aria-label={t("Search bots")}
          placeholder={t("Search")}
          enterKeyHint="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onClose()}
        />
      </InputGroup>
      <Button variant="ghost" onClick={onClose}>
        {t("Cancel")}
      </Button>
    </div>
  );
}

function NoBots({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pe-4",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h1 className="flex-1 text-sm font-medium">{t("Bots")}</h1>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openBotDialog({ environmentId, threadId: null, focus: null })}
        >
          <PlusIcon />
          {t("New bot")}
        </Button>
      </header>
    </main>
  );
}

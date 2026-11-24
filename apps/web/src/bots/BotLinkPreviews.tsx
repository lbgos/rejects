import { BOTS_ENDPOINTS, type EnvironmentId, type LinkPreview } from "@t3tools/contracts";
import { GlobeIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { setWithinBudget } from "@t3tools/shared/sizedCache";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { botRequest } from "./http";
import { messageLinks } from "./presentation";

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: LinkPreview }
  | { readonly status: "failed" };

// The newest cards, so cards scrolled away and back render at once. Images are inlined, so the
// cache is bounded by size; a card mounts again through `load`, which marks it newest.
const PREVIEW_BYTES = 32 * 1024 * 1024;
const previewBytes = (state: PreviewState) =>
  1024 + (state.status === "ready" ? (state.preview.image?.length ?? 0) : 0);
const previews = new Map<string, PreviewState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const store = (key: string, state: PreviewState) => {
  setWithinBudget(previews, key, state, previewBytes, PREVIEW_BYTES);
  for (const listener of listeners) listener();
};
const loading: PreviewState = { status: "loading" };

function load(environmentId: EnvironmentId, url: string) {
  const key = `${environmentId} ${url}`;
  const current = previews.get(key);
  if (current && current.status !== "failed") {
    previews.delete(key);
    previews.set(key, current);
    return;
  }
  store(key, loading);
  botRequest(environmentId, BOTS_ENDPOINTS.linkPreview, { url }).then(
    (preview) => store(key, { status: "ready", preview }),
    () => store(key, { status: "failed" }),
  );
}

function useLinkPreview(environmentId: EnvironmentId, url: string) {
  const key = `${environmentId} ${url}`;
  const state = useSyncExternalStore(subscribe, () => previews.get(key)) ?? loading;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the card the first time the link is on screen
  useEffect(() => {
    load(environmentId, url);
  }, [environmentId, url]);
  return { state, retry: () => load(environmentId, url) };
}

export function BotLinkPreviews({
  environmentId,
  text,
}: {
  environmentId: EnvironmentId;
  text: string;
}) {
  const links = messageLinks(text);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pt-1 max-md:px-1 md:max-w-md">
      {links.map((url) => (
        <LinkCard key={url} environmentId={environmentId} url={url} />
      ))}
    </div>
  );
}

const CARD =
  "rounded-lg border text-start hover:bg-accent max-md:rounded-2xl max-md:border-0 max-md:bg-bot-bubble max-md:hover:bg-bot-fill";

function LinkCard({ environmentId, url }: { environmentId: EnvironmentId; url: string }) {
  const { state, retry } = useLinkPreview(environmentId, url);
  const parsed = URL.parse(url);
  const host = parsed?.hostname.replace(/^www\./, "") ?? url;
  const preview = state.status === "ready" ? state.preview : null;
  return (
    <div className={cn("flex items-center gap-1 pe-1", CARD)}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-bot-link-card
        className="flex min-h-13 min-w-0 flex-1 items-center gap-3 p-2.5 max-md:min-h-16 max-md:px-3 max-md:py-2.5"
      >
        {/* The page's picture takes the icon's place, so a card keeps its shape when its preview
            arrives and the transcript under it never moves. */}
        {preview?.image ? (
          <img
            src={preview.image}
            alt=""
            className="size-8 shrink-0 rounded-md object-cover max-md:size-10 max-md:rounded-lg"
          />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted max-md:size-10 max-md:bg-bot-fill">
            <GlobeIcon aria-hidden className="size-4 max-md:size-5" />
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium max-md:text-bot-callout max-md:font-semibold">
            {preview?.title ?? host}
          </span>
          {preview?.title || state.status === "failed" ? (
            <span className="truncate text-xs text-muted-foreground max-md:text-bot-footnote">
              {state.status === "failed" ? t("No preview") : host}
            </span>
          ) : null}
        </span>
      </a>
      {state.status === "failed" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("Load the preview again")}
          onClick={retry}
        >
          <RotateCwIcon />
        </Button>
      ) : null}
    </div>
  );
}

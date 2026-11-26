import type { EnvironmentId, ThreadId, UiTarget } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui/button";
import { useSidebar } from "../components/ui/sidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { observeResize } from "../lib/observeResize";
import { t } from "../i18n";
import type { TimelineEntry } from "../session-logic";
import { botUiTips } from "./presentation";
import { useBot } from "./state";
import { currentUiTip, useUiTips } from "./uiTips";

const RING_PADDING = 6;
const TIP_GAP = 12;
const TIP_WIDTH = 288;
const EDGE = 16;
const ARROW_SIZE = 12;
const ARROW_INSET = 16;

/** The first element marked with `target` that is on screen; closed sidebars and hidden layouts have none. */
const findTarget = (target: UiTarget) => {
  for (const element of document.querySelectorAll(`[data-ui-target="${target}"]`)) {
    // A tab screen BotTabHost keeps mounted but hidden still has its layout box.
    if (element.closest('[data-bot-tab-pane][data-active="false"]')) continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    )
      // A modal marks everything outside it inert, so a tip for a place inside one renders there.
      return { element, rect, layer: element.closest('[role="dialog"]') };
  }
  return null;
};

const sameRect = (a: DOMRect, b: DOMRect) =>
  a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/**
 * Where the target is now. Its size comes from the shared ResizeObserver; scroll, resize (of the
 * window and the visual viewport) and the end of a transition (a sidebar or sheet sliding in)
 * move it. A target not mounted yet (another
 * route, a closed sidebar) is looked for again on DOM changes, and only while it is missing.
 */
function useTargetRect(target: UiTarget | null) {
  const [found, setFound] = useState<{
    readonly target: UiTarget;
    readonly rect: DOMRect;
    readonly layer: Element | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a DOM element's position, which lives outside React
  useEffect(() => {
    if (target === null) return;
    let stopResize: (() => void) | null = null;
    let observed: Element | null = null;
    let missing: MutationObserver | null = null;
    const measure = () => {
      const next = findTarget(target);
      if (next?.element !== observed) {
        stopResize?.();
        observed = next?.element ?? null;
        stopResize = observed ? observeResize(observed, measure) : null;
      }
      if (next === null && missing === null) {
        missing = new MutationObserver(measure);
        missing.observe(document.body, { childList: true, subtree: true, attributes: true });
      } else if (next !== null && missing !== null) {
        missing.disconnect();
        missing = null;
      }
      setFound((current) =>
        next === null
          ? null
          : current?.target === target &&
              current.layer === next.layer &&
              sameRect(current.rect, next.rect)
            ? current
            : { target, rect: next.rect, layer: next.layer },
      );
    };
    measure();
    // A tab switch shows or hides kept-alive screens without moving or unmounting anything.
    const panes = new MutationObserver(measure);
    panes.observe(document.body, { subtree: true, attributeFilter: ["data-active"] });
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // The app follows the visual viewport, which the iOS keyboard moves without a window resize.
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    document.addEventListener("transitionend", measure, true);
    document.addEventListener("animationend", measure, true);
    return () => {
      stopResize?.();
      missing?.disconnect();
      panes.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      document.removeEventListener("transitionend", measure, true);
      document.removeEventListener("animationend", measure, true);
    };
  }, [target]);
  return found?.target === target ? found : null;
}

/**
 * The bot's `show_ui` tip, one at a time over the whole app: a ring around the marked place
 * with the tip, under the bot's name, beside it, or, when the place is on another screen, the tip with Show. Got it, or
 * a tap on the place itself, dismisses it. Only the tip takes taps; the ring and dimming do not.
 */
export function UiSpotlight() {
  const tip = useUiTips(currentUiTip);
  const chat = useUiTips((state) => state.chat);
  const bot = useBot(chat?.environmentId ?? null, chat?.threadId ?? null);
  const dismiss = useUiTips((state) => state.dismiss);
  const phone = useMediaQuery("max-md");
  const { setOpen } = useSidebar();
  const navigate = useNavigate();
  const found = useTargetRect(tip?.target ?? null);
  const rect = found?.rect ?? null;
  const target = tip?.target ?? null;
  const tipId = tip?.id ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a tap on the highlighted place, outside this component, also dismisses the tip
  useEffect(() => {
    if (target === null || tipId === null) return;
    const onTap = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`[data-ui-target="${target}"]`))
        dismiss(tipId);
    };
    document.addEventListener("pointerup", onTap, true);
    return () => document.removeEventListener("pointerup", onTap, true);
  }, [target, tipId, dismiss]);
  // Every tip names the bot: model text without a speaker would read as the app's own copy.
  if (tip === null || bot === undefined) return null;

  const reveal = () => {
    if (tip.target === "dictation") {
      if (chat) void navigate({ to: "/$environmentId/$threadId", params: chat });
    } else if (tip.target === "notifications") void navigate({ to: "/settings/general" });
    else if (phone) void navigate({ to: "/bots", search: { thread: undefined } });
    else setOpen(true);
  };

  const width = Math.min(TIP_WIDTH, window.innerWidth - EDGE * 2);
  const below = rect !== null && rect.bottom + TIP_GAP + 140 < window.innerHeight;
  const left =
    rect === null
      ? 0
      : Math.min(
          Math.max(EDGE, rect.left + rect.width / 2 - width / 2),
          window.innerWidth - EDGE - width,
        );
  const tipStyle =
    rect === null
      ? undefined
      : {
          width,
          left,
          ...(below
            ? { top: rect.bottom + RING_PADDING + TIP_GAP }
            : { bottom: window.innerHeight - rect.top + RING_PADDING + TIP_GAP }),
        };
  // The tip's pointer sits under (or over) the middle of the place, kept clear of its corners.
  const pointerLeft =
    rect === null
      ? 0
      : Math.min(
          Math.max(ARROW_INSET, rect.left + rect.width / 2 - left - ARROW_SIZE / 2),
          width - ARROW_INSET - ARROW_SIZE,
        );

  return createPortal(
    <div data-ui-spotlight className="pointer-events-none fixed inset-0 z-[70]">
      {rect === null ? (
        // The place is on another screen: the page dims, so the tip reads as a note about it and
        // not as part of the chat under it.
        <div aria-hidden className="fixed inset-0 bg-bot-sheet-scrim" />
      ) : (
        <div
          aria-hidden
          className="fixed rounded-xl border-2 border-foreground"
          style={{
            // The dimming is the ring's own shadow, so the page under it still takes taps.
            boxShadow: "0 0 0 200vmax rgb(0 0 0 / 0.6)",
            top: rect.top - RING_PADDING,
            left: rect.left - RING_PADDING,
            width: rect.width + RING_PADDING * 2,
            height: rect.height + RING_PADDING * 2,
          }}
        />
      )}
      <div
        role="status"
        style={tipStyle}
        className={
          rect === null
            ? "pointer-events-auto fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] mx-auto max-w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
            : "pointer-events-auto fixed rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        }
      >
        {rect === null ? null : (
          <span
            aria-hidden
            data-ui-spotlight-pointer
            style={{ left: pointerLeft, width: ARROW_SIZE, height: ARROW_SIZE }}
            className={
              below
                ? "absolute -top-1.75 rotate-45 border-t border-l border-border bg-popover"
                : "absolute -bottom-1.75 rotate-45 border-r border-b border-border bg-popover"
            }
          />
        )}
        <p className="text-sm font-semibold text-foreground max-md:text-bot-body">{bot.name}</p>
        <p className="text-sm text-foreground max-md:text-bot-body">{tip.text}</p>
        <div className="mt-2 flex justify-end gap-1">
          {rect === null ? (
            <Button size="sm" variant="ghost" onClick={reveal}>
              {t("Show")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => dismiss(tip.id)}>
            {t("Got it")}
          </Button>
        </div>
      </div>
    </div>,
    found?.layer ?? document.body,
  );
}

/** Hands a bot chat's tips to the spotlight once its turn is over; a running turn clears them. */
export function BotUiTipsPublisher({
  environmentId,
  threadId,
  entries,
  working,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entries: ReadonlyArray<TimelineEntry>;
  working: boolean;
}) {
  const publish = useUiTips((state) => state.publish);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the spotlight store outlives this chat, so a tip stays while a phone leaves it to reach the place
  useEffect(() => {
    publish({ environmentId, threadId }, working ? [] : botUiTips(entries, Date.now()));
  }, [publish, environmentId, threadId, entries, working]);
  return null;
}

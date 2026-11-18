import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useSidebar } from "../components/ui/sidebar";
import { mountBackPage } from "./backPage";
import { EDGE_WIDTH, settleBack } from "./gestures";
import { useBotsMode } from "./mode";
import { swipeLog } from "./swipeDebug";
import { placeGesture, useHorizontalDrag } from "./useHorizontalDrag";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

/**
 * Set once WebKit's own back swipe went back during this gesture: from then on that swipe owns
 * the edge wherever there is a page to go back to, so two pages never slide over two copies.
 */
const NATIVE_KEY = "t3code:native-back-swipe";
let nativeBackSwipe = (() => {
  try {
    return localStorage.getItem(NATIVE_KEY) === "1";
  } catch {
    return false;
  }
})();

/** It moves its parent over a copy of the page it returns to and starts below the header so the back arrow stays tappable. */
export function EdgeSwipeBack({ onBack }: { onBack?: () => void }) {
  const { isMobile } = useSidebar();
  const { active } = useBotsMode();
  const navigate = useNavigate();
  const router = useRouter();
  const strip = useRef<HTMLDivElement>(null);
  const under = useRef<ReturnType<typeof mountBackPage>>(null);
  // From a drag's first move until it settles. Our own back clears it first, so leaving the page
  // while it is set means the browser went back under the finger.
  const dragging = useRef(false);
  // The element the last drag moved; a parent that stays (You's list) is put back on the way out.
  const moved = useRef<HTMLElement | null>(null);
  useVisualViewportHeight(isMobile && active);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the copy and the moved page live outside React; leaving the page puts them back
  useEffect(
    () => () => {
      if (dragging.current) {
        swipeLog("left the page mid-drag: the browser's back swipe; copy removed");
        nativeBackSwipe = true;
        try {
          localStorage.setItem(NATIVE_KEY, "1");
        } catch {
          // Blocked storage: this session still knows.
        }
      }
      if (moved.current) placeGesture(moved.current, "", false);
      under.current?.remove();
    },
    [],
  );
  const place = (offset: number, settle: boolean) => {
    const page = strip.current?.parentElement;
    if (!page) return;
    if (offset > 0 && !dragging.current) {
      dragging.current = true;
      moved.current = page;
      under.current = mountBackPage(page);
      swipeLog(`edge drag: copy ${under.current ? "mounted" : "missing"}`);
    }
    placeGesture(page, offset ? `translateX(${offset}px)` : "", settle);
    under.current?.place(offset, settle);
  };
  const settleHome = () => {
    if (!dragging.current) return;
    swipeLog("edge drag: settle home");
    place(0, true);
    window.setTimeout(() => {
      dragging.current = false;
      under.current?.remove();
      under.current = null;
    }, 200);
  };
  const { consumeClick: _consumeClick, ...drag } = useHorizontalDrag({
    move: (dx) => {
      if (dragging.current || dx > 0) place(Math.max(dx, 0), false);
    },
    end: (dx, vx) => {
      if (!dragging.current) return;
      if (!settleBack(dx, vx, window.innerWidth)) return settleHome();
      swipeLog("edge drag: back");
      place(window.innerWidth, true);
      dragging.current = false;
      if (onBack) onBack();
      else void navigate({ to: "/bots", search: { thread: undefined } });
    },
    cancel: settleHome,
  });
  if (!isMobile || !active || (nativeBackSwipe && router.history.canGoBack())) return null;
  return (
    <div
      ref={strip}
      aria-hidden
      data-edge-swipe-back
      {...drag}
      style={{ width: EDGE_WIDTH, top: "var(--bot-chat-header-height)" }}
      className="fixed bottom-0 left-0 z-30 touch-none"
    />
  );
}

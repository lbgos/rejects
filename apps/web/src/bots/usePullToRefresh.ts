import { useEffect, useEffectEvent, useRef } from "react";
import { lockAxis, PULL_COMMIT_PX, pullOffset } from "./gestures";
import { placeGesture } from "./useHorizontalDrag";

const REFRESHING_PX = 44;
const MIN_REFRESHING_MS = 400;

export function usePullToRefresh(refresh: () => Promise<unknown>) {
  const list = useRef<HTMLUListElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const runRefresh = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- non-passive touchmove listener; React's touch handlers are passive and cannot stop the native overscroll
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let pull = 0;
    let busy = false;
    const mover = el.closest<HTMLElement>("[data-pull-area]") ?? el;
    // The indicator's untransformed top relative to the mover's top, when the mover carries it;
    // measured per gesture so the indicator can sit in the middle of the gap the pull opens.
    let rest = 0;
    let indicatorY = 0;
    const measure = () => {
      const ind = indicator.current;
      if (!ind || !mover.contains(ind)) return;
      rest = ind.getBoundingClientRect().top - indicatorY - mover.getBoundingClientRect().top;
    };
    const place = (offset: number, settle: boolean, state: string) => {
      placeGesture(mover, offset ? `translateY(${offset}px)` : "", settle);
      const ind = indicator.current;
      if (!ind) return;
      const half = ind.offsetHeight / 2;
      indicatorY = mover.contains(ind) ? -offset / 2 - half - rest : offset / 2 - half;
      placeGesture(ind, `translateY(${indicatorY}px)`, settle);
      ind.dataset.state = state;
      ind.style.setProperty(
        "--pull",
        String(state === "refreshing" ? 1 : Math.min(offset / PULL_COMMIT_PX, 1)),
      );
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        !busy && touch && event.touches.length === 1 && el.scrollTop <= 0
          ? { x: touch.clientX, y: touch.clientY }
          : null;
      if (start) measure();
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        if (pull === 0 && lockAxis(dx, dy)) start = null;
        return;
      }
      if (event.cancelable) event.preventDefault();
      pull = pullOffset(dy);
      place(pull, false, pull >= PULL_COMMIT_PX ? "ready" : "pull");
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      const ready = pull >= PULL_COMMIT_PX;
      pull = 0;
      if (!ready) return place(0, true, "pull");
      busy = true;
      place(REFRESHING_PX, true, "refreshing");
      // A fast refresh still shows the spinner long enough to read, not a one-frame flash.
      void Promise.all([
        runRefresh().catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, MIN_REFRESHING_MS)),
      ]).finally(() => {
        busy = false;
        place(0, true, "pull");
      });
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);
  return { list, indicator };
}

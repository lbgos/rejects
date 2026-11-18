import { useRef, type MouseEvent, type TouchEvent } from "react";

const HOLD_MS = 500;
const SLOP_PX = 10;
/** Android sends `contextmenu` for the same hold that fired the timer; one menu per gesture. */
const SAME_GESTURE_MS = 800;

/** iOS fires no `contextmenu` on a long press, so the hold is timed here. The tap that ends a hold is swallowed. */
export function useLongPress(onMenu: (point: { x: number; y: number }) => void) {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const openedAt = useRef(Number.NEGATIVE_INFINITY);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const open = (point: { x: number; y: number }) => {
    const now = performance.now();
    if (now - openedAt.current < SAME_GESTURE_MS) return;
    openedAt.current = now;
    onMenu(point);
  };
  return {
    onTouchStart: (event: TouchEvent) => {
      cancel();
      held.current = false;
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) return;
      const point = { x: touch.clientX, y: touch.clientY };
      origin.current = point;
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        held.current = true;
        open(point);
      }, HOLD_MS);
    },
    onTouchMove: (event: TouchEvent) => {
      const touch = event.touches[0];
      const start = origin.current;
      if (touch && start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP_PX)
        cancel();
    },
    onTouchEnd: (event: TouchEvent) => {
      cancel();
      // Cancels the click a hold would otherwise send to the row or to the menu under the finger.
      if (held.current) event.preventDefault();
    },
    onTouchCancel: cancel,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      if (timer.current !== undefined) held.current = true;
      cancel();
      open({ x: event.clientX, y: event.clientY });
    },
    consumeClick: () => {
      const swallow = held.current;
      held.current = false;
      return swallow;
    },
  };
}

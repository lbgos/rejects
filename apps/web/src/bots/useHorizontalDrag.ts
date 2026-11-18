import { useRef, type PointerEvent } from "react";
import { createDrag } from "./gestures";

export function placeGesture(el: HTMLElement, transform: string, settle: boolean) {
  el.dataset.gestureSettle = String(settle);
  el.style.transform = transform;
}

/**
 * A vertical drag stays the browser's scroll (it cancels the pointer); a horizontal one reports its offset.
 * Callers move their element with `placeGesture` so a drag never re-renders React.
 */
export function useHorizontalDrag(handlers: {
  readonly start?: (event: PointerEvent<HTMLElement>) => boolean;
  readonly move: (dx: number) => void;
  readonly end: (dx: number, vx: number) => void;
  readonly cancel: () => void;
}) {
  const drag = useRef<{ id: number; track: ReturnType<typeof createDrag>; dx: number } | null>(
    null,
  );
  const dragged = useRef(false);
  const finish = (event: PointerEvent<HTMLElement>, lifted: boolean) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    if (current.track.axis !== "x") return;
    if (lifted) handlers.end(current.dx, current.track.vx);
    else handlers.cancel();
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (handlers.start && !handlers.start(event)) return;
      dragged.current = false;
      drag.current = {
        id: event.pointerId,
        track: createDrag(event.clientX, event.clientY, event.timeStamp),
        dx: 0,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      const { axis, dx } = current.track.move(event.clientX, event.clientY, event.timeStamp);
      if (axis === "y") {
        drag.current = null;
        return;
      }
      if (axis !== "x") return;
      if (!dragged.current) {
        dragged.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      current.dx = dx;
      handlers.move(dx);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => finish(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(event, false),
    consumeClick: () => {
      const swallow = dragged.current;
      dragged.current = false;
      return swallow;
    },
  };
}

export interface SheetBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly keyboard: boolean;
}

/** A keyboard is at least this tall; a smaller gap is browser chrome, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120;

interface VisualViewportLike {
  readonly offsetTop: number;
  readonly offsetLeft: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

const whole = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);

/** A pinch-zoomed or unreadable viewport gives the whole layout viewport, so a stale offset can never leave the sheet partly off screen. */
export const sheetBox = (
  visual: VisualViewportLike | null,
  layout: { readonly width: number; readonly height: number },
): SheetBox => {
  const full = { top: 0, left: 0, width: layout.width, height: layout.height, keyboard: false };
  if (visual === null || visual.scale > 1.01 || !(visual.height > 0) || !(visual.width > 0))
    return full;
  const top = Math.min(Math.max(whole(visual.offsetTop), 0), layout.height);
  const left = Math.min(Math.max(whole(visual.offsetLeft), 0), layout.width);
  const height = Math.min(whole(visual.height), layout.height - top);
  const width = Math.min(whole(visual.width), layout.width - left);
  if (height < 1 || width < 1) return full;
  return {
    top,
    left,
    width,
    height,
    keyboard: layout.height - (top + height) >= KEYBOARD_MIN_HEIGHT,
  };
};

export interface FrameGeometry {
  readonly width: number;
  readonly height: number;
  readonly offsetTop?: number | undefined;
}

export const framePoint = (
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  frame: FrameGeometry,
  client: { readonly x: number; readonly y: number },
) => {
  const drawn = Math.min(rect.width / frame.width, rect.height / frame.height);
  if (!(drawn > 0) || !Number.isFinite(drawn)) return undefined;
  const x = (client.x - rect.left) / drawn;
  const y = (client.y - rect.top) / drawn - (frame.offsetTop ?? 0);
  if (x < 0 || x > frame.width || y < 0 || y > frame.height) return undefined;
  return { x: Math.round(x), y: Math.round(y), scale: 1 / drawn };
};

export const sameBox = (a: SheetBox, b: SheetBox) =>
  a.top === b.top &&
  a.left === b.left &&
  a.width === b.width &&
  a.height === b.height &&
  a.keyboard === b.keyboard;

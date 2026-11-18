const AXIS_SLOP = 10;
export const EDGE_WIDTH = 20;
export const COMMIT_PX = 64;
export const ROW_ACTION_PX = 76;
const FULL_SWIPE_SHARE = 0.55;
export const PULL_COMMIT_PX = 64;
const FLICK_VELOCITY = 0.4;

export type Axis = "x" | "y";

/** The drag's axis once it leaves the slop; horizontal has to clearly beat vertical. */
export function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.hypot(dx, dy) < AXIS_SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
}

export function rubberBand(offset: number, min: number, max: number): number {
  if (offset > max) return max + (offset - max) / 3;
  if (offset < min) return min + (offset - min) / 3;
  return offset;
}

export function createDrag(x: number, y: number, t: number) {
  let axis: Axis | null = null;
  let last = { x, t };
  let vx = 0;
  return {
    move(px: number, py: number, pt: number) {
      axis ??= lockAxis(px - x, py - y);
      if (pt > last.t) vx = (px - last.x) / (pt - last.t);
      last = { x: px, t: pt };
      return { axis, dx: px - x, dy: py - y };
    },
    get axis() {
      return axis;
    },
    get vx() {
      return vx;
    },
  };
}

export type RowSide = "leading" | "trailing";
export type RowSettle = "closed" | `open-${RowSide}` | `full-${RowSide}`;

export function fullSwipeAt(actionsWidth: number, rowWidth: number): number {
  return Math.max(actionsWidth + ROW_ACTION_PX / 2, rowWidth * FULL_SWIPE_SHARE);
}

export function settleRow(input: {
  readonly offset: number;
  readonly vx: number;
  readonly leadingWidth: number;
  readonly trailingWidth: number;
  readonly rowWidth: number;
}): RowSettle {
  const { offset, vx, rowWidth } = input;
  const side: RowSide = offset > 0 ? "leading" : "trailing";
  const width = side === "leading" ? input.leadingWidth : input.trailingWidth;
  const revealed = Math.abs(offset);
  const toward = side === "leading" ? vx : -vx;
  if (offset === 0 || width === 0) return "closed";
  if (revealed >= fullSwipeAt(width, rowWidth)) return `full-${side}`;
  if (toward <= -FLICK_VELOCITY) return "closed";
  if (toward >= FLICK_VELOCITY || revealed >= width / 2) return `open-${side}`;
  return "closed";
}

export function swipeButtonWidths(revealed: number, count: number, full: boolean): number[] {
  if (count === 0) return [];
  if (full) return [revealed, ...Array.from({ length: count - 1 }, () => 0)];
  return Array.from({ length: count }, () => revealed / count);
}

export function settleBack(dx: number, vx: number, width: number): boolean {
  return dx > width / 3 || (vx >= FLICK_VELOCITY && dx > AXIS_SLOP * 4);
}

export function pullOffset(dy: number): number {
  return Math.min(Math.max(dy, 0) / 2, PULL_COMMIT_PX * 2);
}

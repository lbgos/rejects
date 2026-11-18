import { describe, expect, it } from "vite-plus/test";
import {
  createDrag,
  lockAxis,
  pullOffset,
  PULL_COMMIT_PX,
  rubberBand,
  settleBack,
  settleRow,
  swipeButtonWidths,
} from "./gestures";

describe("lockAxis", () => {
  it.each([
    { name: "inside the slop", dx: 6, dy: 5, axis: null },
    { name: "mostly horizontal", dx: 14, dy: 6, axis: "x" },
    { name: "diagonal goes to scroll", dx: 10, dy: 10, axis: "y" },
    { name: "vertical", dx: 2, dy: -15, axis: "y" },
  ])("$name", ({ dx, dy, axis }) => {
    expect(lockAxis(dx, dy)).toBe(axis);
  });

  it("keeps the first decided axis for the rest of the drag", () => {
    const drag = createDrag(100, 100, 0);
    expect(drag.move(103, 101, 10).axis).toBeNull();
    expect(drag.move(120, 104, 20).axis).toBe("x");
    expect(drag.move(122, 160, 30).axis).toBe("x");
  });

  it("measures the latest horizontal velocity", () => {
    const drag = createDrag(0, 0, 0);
    drag.move(20, 0, 40);
    drag.move(50, 0, 50);
    expect(drag.vx).toBe(3);
  });
});

it("rubber-bands past the limits", () => {
  expect(rubberBand(-50, -144, 80)).toBe(-50);
  expect(rubberBand(110, -144, 80)).toBe(90);
  expect(rubberBand(-174, -144, 80)).toBe(-154);
});

describe("settleRow", () => {
  const row = { leadingWidth: 74, trailingWidth: 148, rowWidth: 390 };
  it.each([
    { name: "short right swipe closes", offset: 30, vx: 0, settle: "closed" },
    { name: "right swipe past half opens Unread", offset: 50, vx: 0, settle: "open-leading" },
    {
      name: "full right swipe runs the leading action",
      offset: 230,
      vx: 0,
      settle: "full-leading",
    },
    { name: "past half the trailing actions opens", offset: -80, vx: 0, settle: "open-trailing" },
    { name: "short left swipe closes", offset: -50, vx: 0, settle: "closed" },
    { name: "left flick opens", offset: -30, vx: -0.6, settle: "open-trailing" },
    { name: "right flick from open closes", offset: -120, vx: 0.6, settle: "closed" },
    { name: "full left swipe runs the edge action", offset: -220, vx: 0, settle: "full-trailing" },
  ] as const)("$name", ({ offset, vx, settle }) => {
    expect(settleRow({ ...row, offset, vx })).toBe(settle);
  });

  it("stays closed on a side without actions", () => {
    expect(settleRow({ ...row, trailingWidth: 0, offset: -300, vx: -1 })).toBe("closed");
  });
});

it("shares the revealed width, or gives it all to the edge action in a full swipe", () => {
  expect(swipeButtonWidths(100, 2, false)).toEqual([50, 50]);
  expect(swipeButtonWidths(250, 2, true)).toEqual([250, 0]);
  expect(swipeButtonWidths(40, 0, false)).toEqual([]);
});

it("goes back past a third of the screen or on a flick", () => {
  expect(settleBack(140, 0, 390)).toBe(true);
  expect(settleBack(100, 0, 390)).toBe(false);
  expect(settleBack(60, 0.6, 390)).toBe(true);
  expect(settleBack(20, 1, 390)).toBe(false);
});

it("damps the pull and caps it", () => {
  expect(pullOffset(-20)).toBe(0);
  expect(pullOffset(2 * PULL_COMMIT_PX)).toBe(PULL_COMMIT_PX);
  expect(pullOffset(1000)).toBe(2 * PULL_COMMIT_PX);
});

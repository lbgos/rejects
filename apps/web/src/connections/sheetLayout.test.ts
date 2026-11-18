import { expect, it } from "vite-plus/test";
import { framePoint, sheetBox } from "./sheetLayout";

const layout = { width: 390, height: 844 };
const visual = (over: Partial<Parameters<typeof sheetBox>[0] & object> = {}) => ({
  offsetTop: 0,
  offsetLeft: 0,
  width: 390,
  height: 844,
  scale: 1,
  ...over,
});

it("fills the layout viewport when nothing covers it", () => {
  expect(sheetBox(visual(), layout)).toEqual({
    top: 0,
    left: 0,
    width: 390,
    height: 844,
    keyboard: false,
  });
  expect(sheetBox(null, layout)).toEqual({
    top: 0,
    left: 0,
    width: 390,
    height: 844,
    keyboard: false,
  });
});

it("sits on the keyboard, offset included", () => {
  expect(sheetBox(visual({ height: 470 }), layout)).toMatchObject({
    top: 0,
    height: 470,
    keyboard: true,
  });
  expect(sheetBox(visual({ height: 470, offsetTop: 120 }), layout)).toMatchObject({
    top: 120,
    height: 470,
    keyboard: true,
  });
});

it("is whole again once the keyboard is gone, whatever offset was left", () => {
  expect(sheetBox(visual({ offsetTop: 0 }), layout)).toMatchObject({
    top: 0,
    height: 844,
    keyboard: false,
  });
  expect(sheetBox(visual({ height: 800 }), layout)).toMatchObject({ height: 800, keyboard: false });
});

it("never leaves the layout viewport and ignores zoom and bad readings", () => {
  expect(sheetBox(visual({ offsetTop: 900, height: 470 }), layout)).toEqual({
    top: 0,
    left: 0,
    width: 390,
    height: 844,
    keyboard: false,
  });
  expect(sheetBox(visual({ scale: 2, width: 195, height: 422 }), layout)).toMatchObject({
    width: 390,
    height: 844,
  });
  expect(sheetBox(visual({ height: Number.NaN }), layout)).toMatchObject({
    width: 390,
    height: 844,
  });
  expect(sheetBox(visual({ offsetTop: -40 }), layout)).toMatchObject({ top: 0 });
});

const rect = (width: number, height: number) => ({ left: 16, top: 100, width, height });

it("maps a touch by how the picture is really drawn, for a box shaped unlike the page", () => {
  const box = rect(361, 626);
  const drawn = Math.min(361 / 390, 626 / 844);
  const at = (x: number, y: number) => ({ x: 16 + x * drawn, y: 100 + y * drawn });
  expect(framePoint(box, { width: 390, height: 844 }, at(195, 650))).toMatchObject({
    x: 195,
    y: 650,
  });
  expect(framePoint(box, { width: 390, height: 844 }, at(195, 520))).toMatchObject({
    x: 195,
    y: 520,
  });
  expect(framePoint(box, { width: 390, height: 844 }, at(195, 650))?.scale).toBeCloseTo(1 / drawn);
  expect(Math.round(((at(195, 650).x - 16) / 361) * 390)).toBe(156);
});

it("maps 1:1 when the box is the page, and ignores a touch outside the picture", () => {
  expect(
    framePoint(rect(361, 626), { width: 361, height: 626 }, { x: 16 + 100, y: 100 + 200 }),
  ).toEqual({
    x: 100,
    y: 200,
    scale: 1,
  });
  expect(
    framePoint(rect(361, 626), { width: 390, height: 844 }, { x: 16 + 355, y: 150 }),
  ).toBeUndefined();
  expect(framePoint(rect(361, 626), { width: 361, height: 626 }, { x: 20, y: 90 })).toBeUndefined();
  expect(
    framePoint(
      rect(361, 626),
      { width: 361, height: 626, offsetTop: 30 },
      { x: 16 + 10, y: 100 + 80 },
    ),
  ).toMatchObject({ y: 50 });
  expect(framePoint(rect(0, 0), { width: 361, height: 626 }, { x: 16, y: 100 })).toBeUndefined();
});

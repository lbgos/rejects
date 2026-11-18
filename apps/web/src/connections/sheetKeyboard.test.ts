import { describe, expect, it } from "vite-plus/test";
import { fieldAt, followFocus, type KeyboardFollow } from "./sheetKeyboard";

const fields = [{ x: 20, y: 100, width: 300, height: 50 }];
const read = (editing: boolean | null, tap: number | null) => ({ editing, fields, tap });
const after = (tap: number | null, editing = false, holdUntil = 0): KeyboardFollow => ({
  tap,
  holdUntil,
  editing,
});

describe("fieldAt", () => {
  it.each([
    [{ x: 100, y: 125 }, true],
    [{ x: 16, y: 97 }, true],
    [{ x: 100, y: 160 }, false],
    [{ x: 10, y: 125 }, false],
  ])("%o on a field: %s", (point, hit) => expect(fieldAt(fields, point)).toBe(hit));
});

describe("followFocus", () => {
  const typing = { typing: true, canOpen: false };
  const idle = { typing: false, canOpen: true };
  it.each([
    ["a read from before the latest tap", after(2), read(false, 1), typing, "none"],
    ["focus in a frame the vault cannot read", after(2), read(null, 2), typing, "none"],
    ["the tap left the field", after(2, true), read(false, 2), typing, "close"],
    [
      "a physical keyboard after the tap left the field",
      after(2, true),
      read(false, 2),
      { typing: true, canOpen: true },
      "none",
    ],
    ["the tap landed on a field", after(2), read(true, 2), typing, "none"],
    ["the page focused a field by itself", after(null), read(true, null), idle, "open"],
    [
      "a touch screen focusing by itself",
      after(null),
      read(true, null),
      { ...idle, canOpen: false },
      "none",
    ],
    [
      "a field still focused after the keyboard was hidden",
      after(2, true),
      read(true, 2),
      idle,
      "none",
    ],
  ] as const)("%s", (_name, state, focus, local, move) =>
    expect(followFocus(state, focus, 1000, local).move).toBe(move),
  );

  it("keeps the keyboard after Enter until the hold ends, for the page's next field", () => {
    const held = followFocus(after(2, true, 3000), read(false, 2), 1000, typing);
    expect(held.move).toEqual({ recheckAt: 3000 });
    expect(followFocus(held.state, read(false, 2), 3000, typing).move).toBe("close");
    expect(followFocus(held.state, read(true, 2), 2000, typing).move).toBe("none");
  });
});

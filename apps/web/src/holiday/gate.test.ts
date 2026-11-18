import { describe, expect, it } from "vite-plus/test";
import { isHolidaySeason, nextLocalMidnight, resolveHolidayTheme } from "./gate";

// Local-time constructors: the season follows the client's clock, not UTC.
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

describe("isHolidaySeason", () => {
  it.each([
    ["30 November, last minute", at(2026, 11, 30, 23, 59), false],
    ["1 December, first minute", at(2026, 12, 1, 0, 0), true],
    ["31 December", at(2026, 12, 31), true],
    ["1 January", at(2027, 1, 1), true],
    ["7 January, last minute", at(2027, 1, 7, 23, 59), true],
    ["8 January, first minute", at(2027, 1, 8, 0, 0), false],
    ["mid July", at(2027, 7, 15), false],
  ])("%s", (_name, now, expected) => {
    expect(isHolidaySeason(now)).toBe(expected);
  });
});

describe("resolveHolidayTheme", () => {
  const inSeason = at(2026, 12, 5);
  const outOfSeason = at(2026, 11, 13);

  it("stays off on an instance that has not enabled it, and still offers the control in season", () => {
    expect(resolveHolidayTheme({ enabled: false, now: inSeason, preview: false })).toEqual({
      active: false,
      offered: true,
    });
  });

  it("shows on an enabled instance in season only", () => {
    expect(resolveHolidayTheme({ enabled: true, now: inSeason, preview: false })).toEqual({
      active: true,
      offered: true,
    });
    expect(resolveHolidayTheme({ enabled: true, now: outOfSeason, preview: false })).toEqual({
      active: false,
      offered: false,
    });
  });

  it("the preview override shows it at any date and on any instance", () => {
    expect(resolveHolidayTheme({ enabled: false, now: outOfSeason, preview: true })).toEqual({
      active: true,
      offered: true,
    });
  });
});

describe("nextLocalMidnight", () => {
  it("is the start of the next local day, across a month and a year end", () => {
    expect(nextLocalMidnight(at(2026, 11, 30, 23, 59))).toEqual(at(2026, 12, 1, 0, 0));
    expect(nextLocalMidnight(at(2026, 12, 31, 8, 0))).toEqual(at(2027, 1, 1, 0, 0));
  });
});

import { StuckControlReport } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceStreak,
  claimReport,
  clientKind,
  confirmsRestart,
  fitReport,
  RESTART_WINDOW_MS,
  routePattern,
  serializeRing,
  STUCK_WINDOW_MS,
  type Streak,
  type TapSnapshot,
} from "./stuckControl";

const decodeReport = Schema.decodeUnknownSync(StuckControlReport);

const idle: TapSnapshot = {
  route: "/a",
  focus: null,
  state: "null|null|null",
  layers: 0,
  effects: 0,
};

function taps(steps: ReadonlyArray<{ control?: string; snapshot?: TapSnapshot; at: number }>) {
  let streak: Streak<string> | null = null;
  return steps.map(({ control = "plus", snapshot = idle, at }) => {
    const next = advanceStreak(streak, control, snapshot, at);
    streak = next.streak;
    return next.stuck;
  });
}

describe("advanceStreak", () => {
  it.each([
    ["three dead taps", [{ at: 0 }, { at: 400 }, { at: 800 }], [false, false, true]],
    [
      "a tap that sent an RPC or copied",
      [
        { at: 0 },
        { at: 400, snapshot: { ...idle, effects: 1 } },
        { at: 800, snapshot: { ...idle, effects: 1 } },
      ],
      [false, false, false],
    ],
    [
      "a toggle",
      [{ at: 0 }, { at: 400, snapshot: { ...idle, state: "null|true|null" } }, { at: 800 }],
      [false, false, false],
    ],
    [
      "a dialog that opened",
      [
        { at: 0 },
        { at: 400, snapshot: { ...idle, layers: 1 } },
        { at: 800, snapshot: { ...idle, layers: 1 } },
      ],
      [false, false, false],
    ],
    [
      "another control in between",
      [{ at: 0 }, { at: 400, control: "send" }, { at: 800 }],
      [false, false, false],
    ],
    [
      "taps spread past the window",
      [{ at: 0 }, { at: 400 }, { at: STUCK_WINDOW_MS + 1 }],
      [false, false, false],
    ],
    [
      "a fourth tap starts over",
      [{ at: 0 }, { at: 400 }, { at: 800 }, { at: 1200 }],
      [false, false, true, false],
    ],
  ])("%s", (_name, steps, expected) => {
    expect(taps(steps)).toEqual(expected);
  });
});

describe("confirmsRestart", () => {
  it.each([
    [RESTART_WINDOW_MS, true],
    [RESTART_WINDOW_MS + 1, false],
    [-1, false],
  ])("a cold start %i ms after the stuck taps confirms: %s", (after, expected) => {
    expect(confirmsRestart({ at: 10_000 }, 10_000 + after)).toBe(expected);
  });
});

describe("claimReport", () => {
  it("sends each fingerprint once a day and three reports a day in all", () => {
    let sent = claimReport(null, "a", "2026-11-15");
    expect(sent).toEqual({ day: "2026-11-15", keys: ["a"] });
    expect(claimReport(sent, "a", "2026-11-15")).toBeNull();
    sent = claimReport(sent, "a|restart", "2026-11-15");
    sent = claimReport(sent, "b", "2026-11-15");
    expect(claimReport(sent, "c", "2026-11-15")).toBeNull();
    expect(claimReport(sent, "a", "2026-11-16")).toEqual({ day: "2026-11-16", keys: ["a"] });
  });
});

describe("report shape", () => {
  it("keeps ids out of routes and fits the ring in 2 KB", () => {
    expect(routePattern("/_chat/$environmentId/$threadId")).toBe("/_chat/$environmentId/$threadId");
    expect(routePattern("/a b?c=<d>")).toBe("/abcd");
    expect(routePattern(undefined)).toBe("unknown");
    const ring = Array.from(
      { length: 40 },
      (_, index) => [`route:/${"x".repeat(100)}`, 1_000 - index] as const,
    );
    const report = fitReport({
      control: "slot.button.ghost",
      route: "/_chat/$environmentId/$threadId",
      version: "0.0.24",
      session: "s1",
      confirmed: false,
      standalone: true,
      client: "ios-webkit",
      ring: serializeRing(ring, 1_000),
    });
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(2_048);
    expect(report.ring.length).toBeGreaterThan(0);
    expect(report.ring.at(-1)).toBe(`route:/${"x".repeat(100)}@39`);
    expect(decodeReport(report)).toEqual(report);
  });
});

describe("clientKind", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      0,
      "ios-webkit",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.1 Safari/605.1.15",
      5,
      "ios-webkit",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.1 Safari/605.1.15",
      0,
      "safari-mac",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
      5,
      "android",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", 0, "firefox"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      0,
      "desktop-chromium",
    ],
    [
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 rejects/0.0.24 Chrome/140.0 Electron/38.1.0 Safari/537.36",
      0,
      "electron",
    ],
    ["Mom's flight lands at 9", 0, "other"],
  ] as const)("%s with %i touch points is %s", (userAgent, touchPoints, expected) => {
    expect(clientKind(userAgent, touchPoints)).toBe(expected);
  });

  it("the contract refuses anything but a known client kind", () => {
    const report = {
      control: "slot.button.ghost",
      route: "/_chat/$environmentId/$threadId",
      version: "0.0.24",
      session: "s1",
      confirmed: false,
      standalone: false,
      ring: [],
    };
    expect(decodeReport({ ...report, client: "safari-mac" }).client).toBe("safari-mac");
    expect(() => decodeReport({ ...report, client: "Mozilla/5.0 Mom's flight" })).toThrow();
    expect(() => decodeReport({ ...report, userAgent: "Mozilla/5.0" })).toThrow();
  });
});

import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  answersFileCancel,
  createFilePickerGuard,
  isIosWebKit,
  PICKER_OPEN_WINDOW_MS,
  RESTART_COOLDOWN_MS,
} from "./iosFilePickerGuard";

function setup({
  answersCancel = true,
  lastRestartAt = null as number | null,
  restartWorks = true,
} = {}) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const page = { now: 1_000_000, lastRestartAt };
  const window = new EventTarget();
  const restarts: number[] = [];
  const open = createFilePickerGuard({
    window,
    document: new EventTarget(),
    answersCancel,
    now: () => page.now,
    lastRestartAt: () => page.lastRestartAt,
    restart: (at) => {
      if (!restartWorks) return false;
      restarts.push(at);
      page.lastRestartAt = at;
      return true;
    },
  });
  // "live" blurs the window as the menu shows; "slow" is the menu with the keyboard up, which
  // stays silent until a picker is chosen; "dead" is a lost session.
  const input = Object.assign(new EventTarget(), {
    picker: "live" as "live" | "slow" | "dead",
    isConnected: true,
    click() {
      if (input.picker === "live") window.dispatchEvent(new Event("blur"));
    },
  });
  const hint = { shown: false };
  const tap = () => {
    open(input, {
      onBlocked: () => (hint.shown = true),
      onWorking: () => (hint.shown = false),
    });
    vi.advanceTimersByTime(PICKER_OPEN_WINDOW_MS);
  };
  return { page, window, input, tap, restarts, hint };
}

describe("createFilePickerGuard", () => {
  it("restarts only on a silent tap during a lost session, once per cooldown", () => {
    const { page, input, tap, restarts, hint } = setup({ lastRestartAt: 1_000_000 - 60_000 });

    // Answered sessions and a slow menu are never suspect, even right after a restart.
    tap();
    input.dispatchEvent(new Event("cancel"));
    input.picker = "slow";
    tap();
    input.dispatchEvent(new Event("change"));
    tap();
    expect(hint.shown).toBe(false);

    // The slow session was never answered: iOS dropped it, and this tap reaches nothing.
    input.picker = "dead";
    tap();
    expect(restarts).toEqual([]);
    expect(hint.shown).toBe(true);

    page.now += RESTART_COOLDOWN_MS;
    tap();
    expect(restarts).toEqual([page.now]);

    page.now += RESTART_COOLDOWN_MS - 1;
    tap();
    expect(restarts).toHaveLength(1);
  });

  it("never reloads where a cancelled menu leaves no event", () => {
    const { window, input, tap, restarts, hint } = setup({ answersCancel: false });

    // iOS before 16.4: the user cancels the menu, then reads it for over a second next time.
    input.picker = "slow";
    tap();
    tap();
    expect(restarts).toEqual([]);
    expect(hint.shown).toBe(true);

    // Choosing a picker from that menu blurs the window: the hint was wrong and goes away.
    window.dispatchEvent(new Event("blur"));
    expect(hint.shown).toBe(false);
  });

  it("ignores an unanswered session whose input left the page", () => {
    const { input, tap, restarts, hint } = setup();
    input.picker = "slow";
    tap();
    input.isConnected = false;
    tap();
    expect(restarts).toEqual([]);
    expect(hint.shown).toBe(false);
  });

  it("shows the hint when the page can't record a restart", () => {
    const { input, tap, restarts, hint } = setup({ restartWorks: false });
    input.picker = "dead";
    tap();
    tap();
    expect(restarts).toEqual([]);
    expect(hint.shown).toBe(true);
  });
});

describe("iOS user agents", () => {
  const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15";
  const IPAD_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15";

  it.each([
    [PHONE, 5, true, true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15", 5, true, false],
    [IPAD_SAFARI, 5, true, true],
    // An iPad home-screen app reports no Safari version.
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5, true, false],
    [IPAD_SAFARI, 0, false, true],
    ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0", 5, false, false],
  ])("%s, %i touch points: iOS %s, answers cancel %s", (userAgent, touch, ios, cancels) => {
    expect(isIosWebKit({ userAgent, maxTouchPoints: touch })).toBe(ios);
    expect(answersFileCancel(userAgent)).toBe(cancels);
  });
});

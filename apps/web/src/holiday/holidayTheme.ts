import { useSyncExternalStore } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerConfigAtom } from "../state/server";
import { nextLocalMidnight, resolveHolidayTheme, type HolidayThemeGate } from "./gate";

/** The instance's last known setting, so a reload paints the theme before the server answers. */
const ENABLED_STORAGE_KEY = "rejects:holiday-theme";

const OFF: HolidayThemeGate = { active: false, offered: false };
let gate = OFF;
let stylesheet: Promise<unknown> | null = null;
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(ENABLED_STORAGE_KEY, "1");
    else window.localStorage.removeItem(ENABLED_STORAGE_KEY);
  } catch {
    // Storage is unavailable: the gate still follows the server's setting.
  }
}

/**
 * The capture override: `?holiday-preview=1` on the URL a page loads with draws the theme at any
 * date on any instance, for that page only. It is never stored and never touches the setting.
 */
function readPreview(): boolean {
  return new URLSearchParams(window.location.search).get("holiday-preview") === "1";
}

function apply(next: HolidayThemeGate): void {
  if (next.active === gate.active && next.offered === gate.offered) return;
  gate = next;
  if (next.active) {
    document.documentElement.dataset.holiday = "on";
    // Every rule in the stylesheet sits under `[data-holiday]`, so it loads once and stays.
    stylesheet ??= import("./holiday.css");
  } else {
    delete document.documentElement.dataset.holiday;
  }
  for (const listener of listeners) listener();
}

/**
 * Follows the gate for the life of the page: the instance's setting, the local date and the
 * preview override. Resolves once the theme's stylesheet is in, at once when the theme is off.
 */
export function startHolidayTheme(): Promise<unknown> {
  const preview = readPreview();
  let enabled = readEnabled();
  const refresh = () => apply(resolveHolidayTheme({ enabled, now: new Date(), preview }));
  appAtomRegistry.subscribe(
    primaryServerConfigAtom,
    (config) => {
      if (config === null) return;
      enabled = config.settings.holidayTheme;
      writeEnabled(enabled);
      refresh();
    },
    { immediate: true },
  );
  const followMidnight = () =>
    window.setTimeout(
      () => {
        refresh();
        followMidnight();
      },
      nextLocalMidnight(new Date()).getTime() - Date.now() + 1000,
    );
  followMidnight();
  // A sleeping phone drops the timer; coming back to the tab checks the date again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  // A page restored from the back-forward cache may skip visibilitychange.
  window.addEventListener("pageshow", refresh);
  refresh();
  // A stylesheet that fails to load leaves the app as it is without the theme.
  return (stylesheet ?? Promise.resolve()).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHolidayTheme(): HolidayThemeGate {
  return useSyncExternalStore(
    subscribe,
    () => gate,
    () => OFF,
  );
}

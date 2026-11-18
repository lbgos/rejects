import { markProcessSwapUrl } from "@t3tools/shared/processSwap";
import { flushComposerDraftStorage } from "../../composerDraftStore";
import { holdWorkerReload } from "../../workerReload";

/**
 * iOS WebKit can lose a file picker session (app left with the Files picker up) and then ignores
 * every file input on the page until it moves to a new web process. A silent tap during a lost
 * session restarts the page that way; with weaker evidence, or inside the restart cooldown, the
 * tap is reported as blocked and the page never reloads.
 */

export const PICKER_OPEN_WINDOW_MS = 1000;
export const RESTART_COOLDOWN_MS = 5 * 60_000;

interface EventSource {
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void;
}

interface FilePickerGuardEnvironment {
  readonly window: EventSource;
  readonly document: EventSource;
  /** WebKit fires `cancel` for every dismissed picker (iOS 16.4+), so silence means a lost session. */
  readonly answersCancel: boolean;
  readonly now: () => number;
  readonly lastRestartAt: () => number | null;
  /** Returns false when the page can't restart safely. */
  readonly restart: (at: number) => boolean;
}

type FilePickerInput = EventSource & { click(): void; readonly isConnected: boolean };

interface FilePickerCallbacks {
  /** The tap reached nothing and the page did not restart. */
  readonly onBlocked: () => void;
  /** The picker showed a sign of life. */
  readonly onWorking: () => void;
}

export function createFilePickerGuard(env: FilePickerGuardEnvironment) {
  // The last session WebKit has not answered with `change` or `cancel`.
  let unanswered: { readonly input: FilePickerInput; readonly controller: AbortController } | null =
    null;

  return function openFilePicker(input: FilePickerInput, callbacks: FilePickerCallbacks): void {
    // A live picker covers the page, so a tap during an unanswered session means WebKit lost it.
    // A detached input may have lost its answer instead, so it proves nothing.
    const lost = unanswered !== null && unanswered.input.isConnected;
    unanswered?.controller.abort();
    const controller = new AbortController();
    const session = { input, controller };
    unanswered = session;

    let opened = false;
    const working = () => {
      opened = true;
      callbacks.onWorking();
    };
    const answered = () => {
      if (unanswered === session) unanswered = null;
      working();
      controller.abort();
    };
    const { signal } = controller;
    input.addEventListener("change", answered, { signal });
    input.addEventListener("cancel", answered, { signal });
    // Showing the picker menu takes first responder from the page, which blurs the window. With
    // the keyboard up WebKit defers that until a picker is chosen, so silence alone proves nothing.
    env.window.addEventListener("blur", working, { signal });
    env.document.addEventListener("visibilitychange", working, { signal });

    const timer = setTimeout(() => {
      if (opened || !lost) return;
      const lastRestartAt = env.lastRestartAt();
      const coolingDown = lastRestartAt !== null && env.now() - lastRestartAt < RESTART_COOLDOWN_MS;
      if (!env.answersCancel || coolingDown || !env.restart(env.now())) callbacks.onBlocked();
    }, PICKER_OPEN_WINDOW_MS);
    signal.addEventListener("abort", () => clearTimeout(timer));

    input.click();
  };
}

const RESTART_STORAGE_KEY = "t3code:file-picker-restart-at";

export function isIosWebKit(nav: Pick<Navigator, "userAgent" | "maxTouchPoints">): boolean {
  // iPadOS reports a Mac user agent; touch support tells it apart.
  return (
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
  );
}

/** Whether this iOS WebKit fires `cancel` on file inputs (16.4+). An unknown version counts as no. */
export function answersFileCancel(userAgent: string): boolean {
  // iPadOS reports a Mac user agent with the Safari version; a home-screen app may report none.
  const match = /iPhone|iPad|iPod/.test(userAgent)
    ? /OS (\d+)_(\d+)/.exec(userAgent)
    : /Version\/(\d+)\.(\d+)/.exec(userAgent);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 16 || (major === 16 && Number(match[2]) >= 4);
}

let appGuard: ReturnType<typeof createFilePickerGuard> | undefined;

/**
 * Opens the picker behind `input`; on iOS WebKit it recovers from a lost picker session. Returns
 * the release of a hold on worker reloads, which the caller calls once the picked files are in the
 * draft. A dismissed picker releases it here.
 */
export function openComposerFilePicker(
  input: HTMLInputElement,
  callbacks: FilePickerCallbacks,
): () => void {
  const hold = holdWorkerReload();
  const closed = new AbortController();
  const release = () => {
    closed.abort();
    hold();
  };
  input.addEventListener("cancel", release, { signal: closed.signal });
  if (!isIosWebKit(navigator)) {
    input.click();
    return release;
  }
  appGuard ??= createFilePickerGuard({
    window,
    document,
    answersCancel: answersFileCancel(navigator.userAgent),
    now: Date.now,
    lastRestartAt: () => {
      try {
        const stored = Number(localStorage.getItem(RESTART_STORAGE_KEY));
        return stored > 0 ? stored : null;
      } catch {
        return null;
      }
    },
    restart: (at) => {
      try {
        // A draft over the storage quota throws here; a reload would drop it, so hint instead.
        flushComposerDraftStorage();
        // Without the cooldown key a restart could loop.
        localStorage.setItem(RESTART_STORAGE_KEY, String(at));
      } catch {
        return false;
      }
      location.replace(markProcessSwapUrl(location.href));
      return true;
    },
  });
  appGuard(input, callbacks);
  return release;
}

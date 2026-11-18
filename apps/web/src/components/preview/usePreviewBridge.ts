import type { DesktopPreviewTabState } from "@t3tools/contracts";

import { acquireBrowserSurfaceActivity } from "~/browser/browserSurfaceStore";
import type { DesktopPreviewOverlay } from "~/previewStateStore";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Keeps a hidden guest painting behind the app while the desktop host captures it; Electron
 * composites no offscreen guest, so its screenshot or stream would otherwise never finish.
 */
export function createCaptureActivity(tabId: string) {
  let release: (() => void) | null = null;
  const update = (capturing: boolean) => {
    if (capturing && !release) release = acquireBrowserSurfaceActivity(tabId);
    else if (!capturing && release) {
      release();
      release = null;
    }
  };
  return { update, release: () => update(false) };
}

/** ElectronBrowserHost owns webview lifetime. */

export function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  const navOrigin = state.navStatus.kind === "Idle" ? null : originOf(state.navStatus.url);
  return {
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    favicon: state.favicon && originOf(state.favicon.pageUrl) === navOrigin ? state.favicon : null,
  };
}

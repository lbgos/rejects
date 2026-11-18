import { useEffect } from "react";

/**
 * iOS keeps the layout viewport when the keyboard opens. `data-keyboard-open` on the root marks a visible height well below the tallest seen at this width,
 * so the composer drops its home-indicator inset only then.
 */
export function useVisualViewportHeight(enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the browser's visual viewport, which React does not own
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const root = document.documentElement;
    let width = 0;
    let tallest = 0;
    const sync = () => {
      if (viewport.width !== width) {
        width = viewport.width;
        tallest = 0;
      }
      tallest = Math.max(tallest, viewport.height);
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.toggleAttribute("data-keyboard-open", viewport.height < tallest - 120);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      root.style.removeProperty("--app-height");
      root.removeAttribute("data-keyboard-open");
    };
  }, [enabled]);
}

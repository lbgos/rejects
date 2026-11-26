type ViewTransitionUpdate = () => void | Promise<void>;

interface StartViewTransitionOptions {
  readonly update: ViewTransitionUpdate;
  readonly types?: readonly string[];
}

type StartViewTransitionFn = (arg: ViewTransitionUpdate | StartViewTransitionOptions) => unknown;

function supportsViewTransitionTypes(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("selector(:active-view-transition-type(a))")
  );
}

/**
 * Runs `update` in a typed view transition when motion is allowed and the engine supports types,
 * falls back to the callback-only form on older engines, and runs `update` directly otherwise.
 */
export function runViewTransition(
  types: readonly string[],
  update: ViewTransitionUpdate,
): void | Promise<void> {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    !window.matchMedia("(prefers-reduced-motion: no-preference)").matches
  ) {
    return update();
  }
  const start = document.startViewTransition.bind(document) as StartViewTransitionFn;
  let ran = false;
  const runOnce: ViewTransitionUpdate = () => {
    ran = true;
    return update();
  };
  if (types.length > 0 && supportsViewTransitionTypes()) {
    try {
      start({ update: runOnce, types });
      return;
    } catch {
      if (ran) return;
    }
  }
  try {
    start(runOnce);
  } catch {
    if (!ran) return update();
  }
}

/** Off by default; when off it adds no listeners. */
const KEY = "t3code:debug-swipe";
const LOG_KEY = "t3code:debug-swipe-log";
const KEEP = 40;

const enabled = (() => {
  try {
    const requested = new URLSearchParams(window.location.search).get("debug");
    if (requested === "swipe") localStorage.setItem(KEY, "1");
    if (requested === "off") localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

let lines: string[] = [];
let panel: HTMLPreElement | null = null;

export function swipeLog(text: string) {
  if (!enabled) return;
  lines = [...lines, `${(performance.now() / 1000).toFixed(3)} ${text}`].slice(-KEEP);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(lines));
  } catch {
    // Storage full or blocked: the panel still shows this session's lines.
  }
  if (panel) panel.textContent = lines.join("\n");
}

if (enabled) {
  try {
    lines = (JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as string[]).slice(-KEEP);
  } catch {
    lines = [];
  }
  lines = [...lines, `-- load ${location.pathname} history ${history.length}`];
  panel = document.createElement("pre");
  Object.assign(panel.style, {
    position: "fixed",
    insetInline: "0",
    top: "45%",
    maxHeight: "40%",
    overflow: "hidden",
    margin: "0",
    padding: "4px 6px",
    font: "10px/1.3 ui-monospace, monospace",
    color: "#fff",
    background: "rgb(0 0 0 / 72%)",
    pointerEvents: "none",
    zIndex: "2147483647",
    whiteSpace: "pre-wrap",
  });
  panel.textContent = lines.join("\n");
  document.documentElement.append(panel);
  let edge = false;
  let moved = false;
  const point = (event: TouchEvent) => {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? `${Math.round(touch.clientX)},${Math.round(touch.clientY)}` : "?";
  };
  const index = () => (history.state as { __TSR_index?: number } | null)?.__TSR_index ?? "?";
  addEventListener(
    "touchstart",
    (event) => {
      edge = (event.touches[0]?.clientX ?? 99) < 40;
      moved = false;
      if (edge) swipeLog(`touchstart ${point(event)} cancelable=${event.cancelable}`);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "touchmove",
    (event) => {
      if (!edge || moved) return;
      moved = true;
      swipeLog(`touchmove first ${point(event)} cancelable=${event.cancelable}`);
    },
    { capture: true, passive: true },
  );
  for (const type of ["touchend", "touchcancel"] as const)
    addEventListener(
      type,
      (event) => {
        if (edge) swipeLog(`${type} ${point(event)}`);
      },
      { capture: true, passive: true },
    );
  addEventListener("popstate", () => swipeLog(`popstate -> ${location.pathname} index ${index()}`));
  for (const type of ["pageswap", "pagereveal", "pagehide", "pageshow"])
    addEventListener(type, () => swipeLog(type));
  document.addEventListener("visibilitychange", () =>
    swipeLog(`visibility ${document.visibilityState}`),
  );
  const start = document.startViewTransition?.bind(document);
  if (start)
    document.startViewTransition = ((arg?: Parameters<typeof start>[0]) => {
      const types = typeof arg === "object" && arg && "types" in arg ? [...(arg.types ?? [])] : [];
      swipeLog(`view transition ${types.join(",") || "crossfade"}`);
      return start(arg);
    }) as typeof document.startViewTransition;
}

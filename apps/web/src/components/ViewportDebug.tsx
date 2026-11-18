import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Off by default; measures on resize, visual viewport events, route changes and a tap on the panel, never per frame. */
const KEY = "t3code:debug-viewport";
const listeners = new Set<() => void>();
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

function setViewportDebug(on: boolean) {
  enabled = on;
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or blocked storage: the switch holds for this session only.
  }
  listeners.forEach((listener) => listener());
}

const requested = new URLSearchParams(window.location.search).get("debug");
if (requested === "viewport") setViewportDebug(true);
if (requested === "off") setViewportDebug(false);

function useViewportDebug() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => enabled,
    () => false,
  );
}

const LAYOUT = "#ff3b30";
const VISUAL = "#30d158";
const ROOT = "#0a84ff";

const px = (value: number) => Math.round(value * 10) / 10;

function find(selector: string) {
  const all = [...document.querySelectorAll(selector)];
  return all.find((el) => !el.closest("[inert]")) ?? all[0] ?? null;
}

function span(selector: string) {
  const el = find(selector);
  if (!el) return "none";
  const r = el.getBoundingClientRect();
  return `${px(r.top)}…${px(r.bottom)} (h ${px(r.height)})${el.closest("[inert]") ? " inert" : ""}`;
}

function describe(el: Element) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const id = el.id ? `#${el.id}` : "";
  const cls =
    typeof el.className === "string"
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
  const data = [...el.attributes]
    .filter((a) => a.name.startsWith("data-") || a.name === "role")
    .slice(0, 2)
    .map((a) => `[${a.name}${a.value ? `=${a.value.slice(0, 16)}` : ""}]`)
    .join("");
  const backdrop = cs.getPropertyValue("-webkit-backdrop-filter") || cs.backdropFilter || "none";
  return `${el.tagName.toLowerCase()}${id}${data}${cls.slice(0, 48)} ${cs.position} z${cs.zIndex} bg ${cs.backgroundColor} bf ${backdrop} op ${cs.opacity} ${px(r.top)}…${px(r.bottom)} w${px(r.width)}`;
}

const transparent = (color: string) =>
  color === "transparent" || /^rgba\(.*, 0\)$|\/ 0\)$/.test(color);

function label(el: Element | null | undefined) {
  if (!el) return "none";
  const data = [...el.attributes]
    .filter((a) => a.name.startsWith("data-"))
    .slice(0, 2)
    .map((a) => `[${a.name}]`)
    .join("");
  return `${el.tagName.toLowerCase()}${data} bg ${getComputedStyle(el).backgroundColor}`;
}

function behindComposer() {
  const form = find("[data-chat-composer-form]");
  if (!form) return "behind composer none";
  const r = form.getBoundingClientRect();
  const stack = document
    .elementsFromPoint(r.left + 48, r.top + r.height / 2)
    .filter(
      (el) => !form.contains(el) && !el.contains(form) && !el.closest("[data-viewport-debug]"),
    );
  const opaque = stack.find((el) => !transparent(getComputedStyle(el).backgroundColor));
  let clipped = find(".messages-timeline-scroll");
  while (clipped && getComputedStyle(clipped).clipPath === "none") clipped = clipped.parentElement;
  const clip = clipped
    ? `${clipped.tagName.toLowerCase()} ${getComputedStyle(clipped).clipPath}`
    : "none";
  return `behind composer ${label(stack[0])} · first opaque ${label(opaque)} · transcript clip ${clip}`;
}

function topElements() {
  const found = [...document.querySelectorAll("body *")].filter((el) => {
    if (el.closest("[data-viewport-debug]")) return false;
    const position = getComputedStyle(el).position;
    if (position !== "fixed" && position !== "sticky") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < 80 && r.bottom > 0;
  });
  const topLayer = [":modal", ":popover-open", "dialog[open]"].flatMap((selector) => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  });
  const transition = (document as Document & { activeViewTransition?: unknown })
    .activeViewTransition;
  return [
    `top-layer ${[...new Set(topLayer)].map(describe).join(" | ") || "none"} · view transition ${transition ? "active" : "none"} · animations ${document.getAnimations().length}`,
    ...found.slice(0, 8).map((el, index) => `fixed${index + 1} ${describe(el)}`),
    ...(found.length > 8 ? [`fixed+ ${found.length - 8} more`] : []),
  ];
}

function measure(probes: HTMLDivElement | null, route: string) {
  if (!probes) return null;
  const probe = (name: string) => probes.querySelector<HTMLElement>(`[data-probe="${name}"]`)!;
  const height = (name: string) => px(probe(name).getBoundingClientRect().height);
  const insets = getComputedStyle(probe("insets"));
  const vv = window.visualViewport;
  const root = document.getElementById("root");
  const rootRect = root?.getBoundingClientRect();
  const ua = navigator.userAgent;
  const ios = /OS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/.exec(ua);
  const safari = /Version\/([\d.]+)/.exec(ua);
  const meta = (name: string) =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "none";
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  const lines = [
    `display-mode standalone ${matchMedia("(display-mode: standalone)").matches} · navigator.standalone ${String(standalone)}`,
    `status-bar-style ${meta("apple-mobile-web-app-status-bar-style")}`,
    `screen ${screen.width}×${screen.height} · dpr ${window.devicePixelRatio}`,
    `inner ${window.innerWidth}×${window.innerHeight} · outer ${window.outerWidth}×${window.outerHeight}`,
    `visualViewport h ${vv ? px(vv.height) : "none"} · offsetTop ${vv ? px(vv.offsetTop) : "none"} · scale ${vv ? px(vv.scale) : "none"}`,
    `documentElement.clientHeight ${document.documentElement.clientHeight} · scrollY ${px(window.scrollY)}`,
    `100dvh ${height("dvh")} · 100svh ${height("svh")} · 100lvh ${height("lvh")}`,
    `safe-area top ${insets.paddingTop} · bottom ${insets.paddingBottom} · left ${insets.paddingLeft} · right ${insets.paddingRight}`,
    `root ${span("#root")} · padding-top ${root ? getComputedStyle(root).paddingTop : "none"}`,
    `route ${route}`,
    `header ${span("header[data-chat-header], [data-back-page] > header")}`,
    `composer ${span("[data-chat-composer-form]")}`,
    behindComposer(),
    `tabbar ${span('nav[aria-label="Bots app"]')}`,
    ...topElements(),
    `iOS ${ios ? ios.slice(1).filter(Boolean).join(".") : "none"} · Safari ${safari?.[1] ?? "none"}`,
    `measured ${new Date().toLocaleTimeString()} · tap to measure again`,
  ];
  return {
    lines,
    visualTop: vv?.offsetTop ?? 0,
    visualBottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
    rootTop: rootRect?.top ?? 0,
    rootBottom: rootRect?.bottom ?? 0,
  };
}

const LABEL_PLACE = {
  left: "left-1",
  center: "left-1/2 -translate-x-1/2",
  right: "right-1",
} as const;

function Edge({
  top,
  bottom,
  edge,
  color,
  label,
  place,
}: {
  top?: number;
  bottom?: number;
  edge: "top" | "bottom";
  color: string;
  label: string;
  place: keyof typeof LABEL_PLACE;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[2147483000] h-0.5"
      style={{ top, bottom, background: color }}
    >
      <span
        className={`absolute font-mono text-4xs leading-none ${LABEL_PLACE[place]}`}
        style={{ color, ...(edge === "top" ? { top: 3 } : { bottom: 3 }) }}
      >
        {label}
      </span>
    </div>
  );
}

export function ViewportDebug() {
  return useViewportDebug() ? <ViewportDebugOverlay /> : null;
}

function ViewportDebugOverlay() {
  const probes = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ReturnType<typeof measure>>(null);
  const route = useRouterState({ select: (router) => router.location.pathname });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the browser's viewport, which React does not own
  useEffect(() => {
    const vv = window.visualViewport;
    const sync = () => setState(measure(probes.current, route));
    const settle = window.setTimeout(sync, 800);
    sync();
    window.addEventListener("resize", sync);
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", sync);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, [route]);
  const probe = "pointer-events-none invisible fixed top-0 left-0 w-px";
  return (
    <div data-viewport-debug>
      <div ref={probes} aria-hidden>
        <div
          data-probe="insets"
          className={probe}
          style={{
            padding:
              "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
          }}
        />
        <div data-probe="dvh" className={probe} style={{ height: "100dvh" }} />
        <div data-probe="svh" className={probe} style={{ height: "100svh" }} />
        <div data-probe="lvh" className={probe} style={{ height: "100lvh" }} />
      </div>
      <Edge top={0} edge="top" color={LAYOUT} label="layout top" place="left" />
      <Edge bottom={0} edge="bottom" color={LAYOUT} label="layout bottom" place="left" />
      {state ? (
        <>
          <Edge top={state.visualTop} edge="top" color={VISUAL} label="visual top" place="center" />
          <Edge
            top={state.visualBottom - 2}
            edge="bottom"
            color={VISUAL}
            label="visual bottom"
            place="center"
          />
          <Edge
            top={state.rootTop + 12}
            edge="top"
            color={ROOT}
            label="root top +12"
            place="right"
          />
          <Edge
            top={state.rootBottom - 14}
            edge="bottom"
            color={ROOT}
            label="root bottom −12"
            place="right"
          />
          <button
            type="button"
            onClick={() => setState(measure(probes.current, route))}
            className="fixed inset-x-2 top-[30%] z-[2147483000] border border-white/40 bg-black/80 p-2 text-left font-mono text-3xs leading-snug break-all text-white"
          >
            {state.lines.map((line) => (
              <div key={line.slice(0, line.indexOf(" "))}>{line}</div>
            ))}
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Reports each bots tab switch as one server log line, no page content, MAX_REPORTS per page load:
 * a phone switch's CSS fade (`update` `css`) and whether the bar stayed the same node and fill,
 * or a desktop sidebar switch's view transition and how its promises settled.
 */
import { TAB_TRANSITION_ENDPOINT, type TabTransitionReport } from "@t3tools/contracts";
import { APP_VERSION } from "~/branding";
import { clientKind } from "../observability/stuckControl";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { botRequest } from "./http";

const MAX_REPORTS = 40;
const CALL_WINDOW_MS = 2_000;

let sent = 0;
let installed = false;
interface BarState {
  readonly node: Element | null;
  readonly count: number;
  readonly names: string;
  readonly fill: string;
  readonly blur: string;
}

let armed: {
  readonly from: string;
  readonly to: string;
  readonly timer: number;
  readonly bar: BarState;
} | null = null;

function barState(): BarState {
  const bars = [...document.querySelectorAll("[data-bots-tab-bar]")];
  const glass = bars.at(-1)?.querySelector(".surface-glass");
  const style = glass ? getComputedStyle(glass) : null;
  return {
    node: bars.at(-1) ?? null,
    count: bars.length,
    names:
      bars
        .map((bar) => {
          const name = getComputedStyle(bar).viewTransitionName;
          if (!name || name === "none") return "none";
          const group = getComputedStyle(
            document.documentElement,
            `::view-transition-group(${name})`,
          );
          return `${name}@${parseInt(group.width) || 0}x${parseInt(group.height) || 0}`;
        })
        .join("+") || "none",
    fill: style ? `${style.backgroundColor}|${style.backgroundImage}` : "none",
    blur: style
      ? style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter") || "none"
      : "none",
  };
}

const barReport = (before: BarState, after: BarState) =>
  token(
    `n${after.count}:${before.node !== null && before.node === after.node ? "same" : "new"}-node:${after.names}:fill-${before.fill === after.fill ? "same" : "changed"}:blur-${before.blur}>${after.blur}`,
    240,
  );

const token = (text: string, max: number) =>
  text.replace(/[^A-Za-z0-9_$.:+/-]+/g, "-").slice(0, max) || "none";

const outcome = (error: unknown) =>
  error instanceof Error ? token(`${error.name}:${error.message}`, 120) : token(String(error), 120);

const settle = (promise: Promise<unknown>, started: number) =>
  promise.then(
    () => ({ result: "resolved", ms: Math.round(performance.now() - started) }),
    (error: unknown) => ({ result: outcome(error), ms: Math.round(performance.now() - started) }),
  );

function base(from: string, to: string) {
  const ua = navigator.userAgent;
  const os = ua.match(/OS (\d+)[._](\d+)/);
  const browser = ua.match(/(Version|CriOS|FxiOS|Chrome|Firefox)\/([\d.]+)/);
  const engine = ua.match(/AppleWebKit\/([\d.]+)/);
  return {
    from: token(from, 16),
    to: token(to, 16),
    api: typeof document.startViewTransition === "function",
    types: CSS.supports("selector(:active-view-transition-type(a))"),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      Reflect.get(navigator, "standalone") === true,
    client: clientKind(ua, navigator.maxTouchPoints),
    os: os ? `iOS-${os[1]}.${os[2]}` : "none",
    browser: browser ? token(`${browser[1]}-${browser[2]}`, 24) : "none",
    engine: engine ? token(`AppleWebKit-${engine[1]}`, 32) : "none",
    version: token(APP_VERSION, 40),
  };
}

function send(report: TabTransitionReport) {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null || sent >= MAX_REPORTS) return;
  sent += 1;
  void botRequest(environmentId, TAB_TRANSITION_ENDPOINT, report).catch(() => undefined);
}

const notCalled = { update: "none", ready: "none", finished: "none" };

function install() {
  installed = true;
  const start = document.startViewTransition?.bind(document);
  if (!start) return;
  document.startViewTransition = ((arg?: Parameters<typeof start>[0]) => {
    const transition = start(arg);
    const tab = armed;
    if (tab === null) return transition;
    armed = null;
    window.clearTimeout(tab.timer);
    const started = performance.now();
    let animations = "none";
    let bar = barReport(tab.bar, tab.bar);
    void transition.ready.then(
      () => {
        bar = barReport(tab.bar, barState());
        animations = token(
          document
            .getAnimations()
            .filter((a) => a.effect instanceof KeyframeEffect && a.effect.pseudoElement !== null)
            .map((a) => {
              const name = a instanceof CSSAnimation ? a.animationName : "ua";
              return `${name}:${Math.round(Number(a.effect?.getTiming().duration ?? 0))}`;
            })
            .join(","),
          240,
        );
      },
      () => undefined,
    );
    void Promise.all([
      settle(transition.updateCallbackDone, started),
      settle(transition.ready, started),
      settle(transition.finished, started),
    ]).then(([update, ready, finished]) =>
      send({
        ...base(tab.from, tab.to),
        called: true,
        update: update.result,
        ready: ready.result,
        finished: finished.result,
        updateMs: update.ms,
        readyMs: ready.ms,
        finishedMs: finished.ms,
        runMs:
          ready.result === "resolved" && finished.result === "resolved"
            ? finished.ms - ready.ms
            : -1,
        animations,
        bar,
      }),
    );
    return transition;
  }) as typeof document.startViewTransition;
}

const isActivePane = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.dataset.botTabPane !== undefined &&
  target.dataset.active === "true";

/** Follows the incoming pane's slide animation and reports it once it ends or is cancelled. */
function watchSlide(from: string, to: string, bar: BarState, tapped: number) {
  let run: { readonly at: number; readonly bar: BarState; readonly animation: string } | null =
    null;
  const stop = () => {
    document.removeEventListener("animationstart", onRun, true);
    document.removeEventListener("animationend", onEnd, true);
    document.removeEventListener("animationcancel", onEnd, true);
    window.clearTimeout(timer);
  };
  const report = (finished: string) => {
    stop();
    const now = Math.round(performance.now() - tapped);
    send({
      ...base(from, to),
      called: false,
      update: "css",
      ready: run ? "animationstart" : "none",
      finished,
      updateMs: -1,
      readyMs: run ? Math.round(run.at - tapped) : -1,
      finishedMs: finished === "none" ? -1 : now,
      runMs: run && finished === "animationend" ? Math.round(performance.now() - run.at) : -1,
      animations: run?.animation ?? "none",
      bar: barReport(bar, run?.bar ?? barState()),
    });
  };
  const onRun = (event: AnimationEvent) => {
    if (!isActivePane(event.target) || run) return;
    const pane = event.target instanceof HTMLElement ? event.target : null;
    const animation = pane
      ?.getAnimations()
      .find((a) => a instanceof CSSAnimation && a.animationName === event.animationName);
    const duration = animation?.effect?.getTiming().duration;
    run = {
      at: performance.now(),
      bar: barState(),
      animation: token(`${event.animationName}:${Math.round(Number(duration ?? 0))}`, 60),
    };
  };
  const onEnd = (event: AnimationEvent) => {
    if (!isActivePane(event.target) || !run) return;
    report(event.type);
  };
  document.addEventListener("animationstart", onRun, true);
  document.addEventListener("animationend", onEnd, true);
  document.addEventListener("animationcancel", onEnd, true);
  const timer = window.setTimeout(() => report("none"), CALL_WINDOW_MS);
}

/** Call on a tab tap, before navigating. */
export function noteTabSwitch(from: string, to: string) {
  if (from !== "sidebar") {
    watchSlide(from, to, barState(), performance.now());
    return;
  }
  if (!installed) install();
  if (armed) window.clearTimeout(armed.timer);
  const bar = barState();
  const timer = window.setTimeout(() => {
    armed = null;
    send({
      ...base(from, to),
      called: false,
      ...notCalled,
      updateMs: -1,
      readyMs: -1,
      finishedMs: -1,
      runMs: -1,
      animations: "none",
      bar: barReport(bar, bar),
    });
  }, CALL_WINDOW_MS);
  armed = { from, to, timer, bar };
}

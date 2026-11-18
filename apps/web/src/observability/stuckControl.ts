/**
 * Notices a control that stopped working: three taps on the same enabled control within 5 s that
 * change nothing. A cold start within a minute of that confirms the user was stuck. Reports name
 * controls only by allowlisted `data-*` attributes and routes only by route id, never by text.
 *
 * Event-driven only: listeners on the document and window, nothing between taps.
 */
import {
  STUCK_CONTROL_RING_MAX,
  UI_TARGETS,
  type StuckControlClient,
  type StuckControlReport,
} from "@t3tools/contracts";

const STUCK_TAPS = 3;
export const STUCK_WINDOW_MS = 5_000;
export const RESTART_WINDOW_MS = 60_000;
const SCROLL_PX = 10;
const REPORT_MAX_BYTES = 2_048;
const REPORTS_PER_DAY = 3;
const STUCK_KEY = "t3code:stuck-control:last";
const SENT_KEY = "t3code:stuck-control:sent";
const CONTROL_SELECTOR = 'button, [role="button"], a[href]';

let effects = 0;
/**
 * Bumped by the RPC and HTTP send paths and by clipboard writes: a tap that sent or copied something
 * did something, even when the page looks the same.
 */
export function countEffect(): void {
  effects += 1;
}

export interface TapSnapshot {
  readonly route: string;
  readonly focus: Element | null;
  readonly state: string;
  /**
   * Children of `<body>`. Base UI mounts each open dialog, menu, popover and sheet there, so this
   * counts open layers in O(1); a role query costs ~100 µs per tap on a long chat.
   */
  readonly layers: number;
  readonly effects: number;
}

export interface Streak<C> {
  readonly control: C;
  readonly snapshot: TapSnapshot;
  readonly first: number;
  readonly count: number;
}

const sameSnapshot = (a: TapSnapshot, b: TapSnapshot) =>
  a.route === b.route &&
  a.focus === b.focus &&
  a.state === b.state &&
  a.layers === b.layers &&
  a.effects === b.effects;

/**
 * Each tap's snapshot is taken before its own handler runs, so it shows what the previous tap
 * did. Three equal snapshots on one control inside the window make it stuck.
 */
export function advanceStreak<C>(
  streak: Streak<C> | null,
  control: C,
  snapshot: TapSnapshot,
  now: number,
): { readonly streak: Streak<C> | null; readonly stuck: boolean } {
  const continues =
    streak !== null &&
    streak.control === control &&
    now - streak.first <= STUCK_WINDOW_MS &&
    sameSnapshot(streak.snapshot, snapshot);
  const next = continues
    ? { ...streak, count: streak.count + 1 }
    : { control, snapshot, first: now, count: 1 };
  return next.count >= STUCK_TAPS ? { streak: null, stuck: true } : { streak: next, stuck: false };
}

const SAFE = /^[A-Za-z0-9_-]{1,40}$/;
const safe = (value: string | null) => (value !== null && SAFE.test(value) ? value : null);

/** `ui.<data-ui-target>`, else `slot.<data-slot>[.<data-variant>]`, else `<tag>[.<role>]`. */
function controlName(control: Element): string {
  const target = control.getAttribute("data-ui-target");
  if (target !== null && UI_TARGETS.some((known) => known === target)) return `ui.${target}`;
  const slot = safe(control.getAttribute("data-slot"));
  if (slot) {
    const variant = safe(control.getAttribute("data-variant"));
    return variant ? `slot.${slot}.${variant}` : `slot.${slot}`;
  }
  const role = safe(control.getAttribute("role"));
  const tag = control.tagName.toLowerCase();
  return role && role !== tag ? `${tag}.${role}` : tag;
}

/** Route ids name params (`$threadId`), never their values. */
export function routePattern(routeId: string | undefined): string {
  const pattern = (routeId ?? "").replace(/[^A-Za-z0-9_$./-]/g, "").slice(0, 120);
  return pattern || "unknown";
}

function errorName(value: unknown): string {
  const name = value instanceof Error ? value.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}

type RingEntry = readonly [name: string, at: number];

export function serializeRing(ring: ReadonlyArray<RingEntry>, now: number): string[] {
  return ring
    .slice(-STUCK_CONTROL_RING_MAX)
    .map(([name, at]) => `${name}@${Math.min(Math.max(0, now - at), 999_999_999)}`);
}

/** Drops the oldest ring entries until the report fits in one small request. */
export function fitReport(report: StuckControlReport): StuckControlReport {
  let ring = report.ring;
  while (ring.length > 0 && JSON.stringify({ ...report, ring }).length > REPORT_MAX_BYTES) {
    ring = ring.slice(1);
  }
  return { ...report, ring };
}

interface StuckRecord {
  readonly at: number;
  readonly control: string;
  readonly route: string;
  readonly version: string;
  readonly ring: ReadonlyArray<RingEntry>;
}

export const confirmsRestart = (record: Pick<StuckRecord, "at">, now: number) =>
  now >= record.at && now - record.at <= RESTART_WINDOW_MS;

interface SentToday {
  readonly day: string;
  readonly keys: ReadonlyArray<string>;
}

/** iPadOS reports a Mac user agent; touch points tell it apart. */
export function clientKind(userAgent: string, touchPoints: number): StuckControlClient {
  if (/Electron\//.test(userAgent)) return "electron";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios-webkit";
  if (/Macintosh/.test(userAgent) && touchPoints > 1) return "ios-webkit";
  if (/Android/.test(userAgent)) return "android";
  if (/Firefox\//.test(userAgent)) return "firefox";
  if (/Chrome\/|Chromium\//.test(userAgent)) return "desktop-chromium";
  if (/Macintosh/.test(userAgent) && /Safari\//.test(userAgent)) return "safari-mac";
  return "other";
}

/** One report per key per day, three a day in all. Null means over the cap. */
export function claimReport(sent: SentToday | null, key: string, day: string): SentToday | null {
  const today = sent?.day === day ? sent.keys : [];
  if (today.includes(key) || today.length >= REPORTS_PER_DAY) return null;
  return { day, keys: [...today, key] };
}

function readJson(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage | null, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the detector still reports, it only loses restart memory.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function readStuckRecord(storage: Storage | null): StuckRecord | null {
  const value = readJson(storage, STUCK_KEY);
  if (!isRecord(value)) return null;
  const { at, control, route, version, ring } = value;
  if (typeof at !== "number" || typeof control !== "string" || typeof route !== "string") {
    return null;
  }
  if (typeof version !== "string" || !Array.isArray(ring)) return null;
  const entries = ring.filter(
    (entry): entry is RingEntry =>
      Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number",
  );
  return { at, control, route, version, ring: entries };
}

function readSent(storage: Storage | null): SentToday | null {
  const value = readJson(storage, SENT_KEY);
  if (!isRecord(value) || typeof value.day !== "string" || !Array.isArray(value.keys)) return null;
  return { day: value.day, keys: value.keys.filter((key) => typeof key === "string") };
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface StuckControlDeps {
  /** The current route id, such as `/_chat/$environmentId/$threadId`. */
  readonly routeId: () => string | undefined;
  /** Calls back after each navigation; returns the unsubscribe. */
  readonly onRoute: (listener: () => void) => () => void;
  readonly send: (report: StuckControlReport) => void;
  readonly version: string;
  readonly now?: () => number;
  readonly storage?: Storage | null;
}

export function startStuckControlDetection(deps: StuckControlDeps): () => void {
  const now = deps.now ?? Date.now;
  const storage = deps.storage === undefined ? localStorageOrNull() : deps.storage;
  const session = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const version = deps.version.replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, 40) || "unknown";
  const ring: RingEntry[] = [];
  const record = (name: string) => {
    ring.push([name, now()]);
    if (ring.length > STUCK_CONTROL_RING_MAX) ring.shift();
  };
  const client = clientKind(navigator.userAgent, navigator.maxTouchPoints);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    Reflect.get(navigator, "standalone") === true;

  const report = (input: Omit<StuckRecord, "at">, confirmed: boolean) => {
    const at = now();
    const fingerprint = `${input.control}|${input.route}|${input.version}`;
    const claimed = claimReport(
      readSent(storage),
      // Per session: a reload in this browser is a second session the server can count.
      confirmed ? `${fingerprint}|restart` : `${fingerprint}|${session}`,
      new Date(at).toISOString().slice(0, 10),
    );
    if (!claimed) return;
    writeJson(storage, SENT_KEY, claimed);
    deps.send(
      fitReport({
        control: input.control,
        route: input.route,
        version: input.version,
        session,
        confirmed,
        standalone,
        client,
        ring: serializeRing(input.ring, at),
      }),
    );
  };

  const last = readStuckRecord(storage);
  writeJson(storage, STUCK_KEY, null);
  record("boot");
  if (last && confirmsRestart(last, now())) {
    report({ ...last, ring: [...last.ring, ["boot", now()]] }, true);
  }

  let lastRoute = "";
  const recordRoute = () => {
    const route = routePattern(deps.routeId());
    if (route !== lastRoute) record(`route:${route}`);
    lastRoute = route;
  };
  recordRoute();
  const stopRoute = deps.onRoute(recordRoute);

  let down: { readonly id: number; readonly x: number; readonly y: number } | null = null;
  let streak: Streak<Element> | null = null;
  let layers = 0;

  const onPointerDown = (event: PointerEvent) => {
    down = event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const onPointerCancel = () => {
    down = null;
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = down;
    down = null;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > SCROLL_PX) return;
    const control = event.target instanceof Element ? event.target.closest(CONTROL_SELECTOR) : null;
    if (!control || control.closest("[data-quiet]")) return;
    if (control.matches(":disabled") || control.getAttribute("aria-disabled") === "true") return;
    // Re-tapping the current tab or the link to this page rightly does nothing.
    if (control.getAttribute("aria-selected") === "true") return;
    if ((control.getAttribute("aria-current") ?? "false") !== "false") return;
    const snapshot: TapSnapshot = {
      route: location.href,
      focus: document.activeElement,
      state: [
        control.getAttribute("aria-expanded"),
        control.getAttribute("aria-pressed"),
        control.getAttribute("aria-checked"),
        control.hasAttribute("data-checked"),
        control.getAttribute("data-state"),
      ].join("|"),
      layers: document.body.childElementCount,
      effects,
    };
    if (snapshot.layers !== layers) record(`layers:${snapshot.layers}`);
    layers = snapshot.layers;
    const name = controlName(control);
    record(`tap:${name}`);
    const next = advanceStreak(streak, control, snapshot, now());
    streak = next.streak;
    if (!next.stuck) return;
    const stuck = { control: name, route: routePattern(deps.routeId()), version };
    writeJson(storage, STUCK_KEY, { ...stuck, at: now(), ring });
    report({ ...stuck, ring }, false);
  };
  const onFileEvent = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") {
      record(`file:${event.type}`);
    }
  };
  const onVisibility = () => record(`vis:${document.visibilityState}`);
  const onWindowFocus = (event: FocusEvent) => {
    if (event.target === window) record(`win:${event.type}`);
  };
  const onError = (event: ErrorEvent) => record(`error:${errorName(event.error)}`);
  const onRejection = (event: PromiseRejectionEvent) => record(`error:${errorName(event.reason)}`);

  const listen = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", onPointerDown, listen);
  document.addEventListener("pointerup", onPointerUp, listen);
  document.addEventListener("pointercancel", onPointerCancel, listen);
  for (const type of ["click", "change", "cancel"]) {
    document.addEventListener(type, onFileEvent, listen);
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("blur", onWindowFocus);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    stopRoute();
    document.removeEventListener("pointerdown", onPointerDown, listen);
    document.removeEventListener("pointerup", onPointerUp, listen);
    document.removeEventListener("pointercancel", onPointerCancel, listen);
    for (const type of ["click", "change", "cancel"]) {
      document.removeEventListener(type, onFileEvent, listen);
    }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("blur", onWindowFocus);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

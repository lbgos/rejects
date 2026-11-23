// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - The CDP pipe and its callbacks run outside the Effect runtime.
/** Bots act through `act`, pinned to the account's site and allowed origins: off-site main-frame loads fail, redirects included, and popups are held, then closed or followed. */
import * as NodeChildProcess from "node:child_process";
import { onSite, type SheetFocus, type SheetFrame, type SheetInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CHALLENGE_PROBE,
  type Challenge,
  type PageSignals,
  waitOutChallenge,
} from "../bots/challenge.ts";
import { type EgressProxy, startEgressProxy } from "./egress.ts";
import { jpegSizeOfBase64 } from "./jpeg.ts";
import type { ProfileLease } from "./lease.ts";
import { issueReasons, traceResponse, traceSummary, tracedText, tracedUrl } from "./sheetTrace.ts";
import {
  CLICK_GUARD_SCRIPT,
  focusScript,
  PHONE_BROWSER_SCRIPT,
  SHEET_FOCUS_SCRIPT,
  SNAPSHOT_SCRIPT,
  targetScript,
} from "./page.ts";

/** The profile directory name for a site; the forced command accepts only this shape. */
export const profileOf = (site: string) => site.replace(":", "_");

const VIEWPORT = { width: 390, height: 844 } as const;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
const clampViewport = (viewport: Viewport): Viewport => ({
  width: Math.round(clamp(viewport.width, 240, 1024)),
  height: Math.round(clamp(viewport.height, 240, 2400)),
});
/** Once the page rests for SHARP_AFTER_MS, one screenshot at SHARP_QUALITY replaces the screencast frames. */
const MOTION_QUALITY = Number(process.env.SHEET_MOTION_QUALITY ?? 60);
const SHARP_QUALITY = Number(process.env.SHEET_SHARP_QUALITY ?? 80);
const SHARP_AFTER_MS = 140;
const REACTION_MS = 600;
const CONTINUOUS_MS = 120;
const CAPTURE_TIMEOUT_MS = 2_000;
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const CALL_TIMEOUT_MS = 30_000;
const LEASE_EXIT_MS = 8_000;
const FRAME_WAIT_MS = 10_000;
const SETTLE_MS = 10_000;
/** A focus read on a page that is busy is dropped; the next tap or settle reads again. */
const FOCUS_READ_MS = 1_000;
const SHEET_OPEN = "The user has the sign-in sheet open. Try again later.";

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  message: Schema.String,
  /** A secret was refused because the focused field is not of its kind. */
  wrongField: Schema.optional(Schema.Boolean),
}) {}

/** Thrown inside a browser task; `run` turns it into a BrowserError with `wrongField`. */
class WrongFieldError extends Schema.TaggedError<WrongFieldError>()("WrongFieldError", {
  message: Schema.String,
}) {}
const isWrongField = Schema.is(WrongFieldError);

export interface SshTarget {
  readonly host: string;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

export type PageAction =
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "snapshot" }
  | { readonly action: "click"; readonly ref: string }
  | {
      readonly action: "type";
      readonly ref: string;
      readonly text: string;
      readonly submit: boolean;
      /** Set when `text` is a kept login or code: typed only on that exact host, into its kind of field. */
      readonly secret?: { readonly site: string; readonly kind: SecretKind } | undefined;
    }
  | { readonly action: "press"; readonly key: string }
  | { readonly action: "scroll"; readonly direction: "up" | "down" }
  | { readonly action: "back" };

export type SecretKind = "username" | "password" | "code";

/**
 * Where a secret may be typed: the card's host itself (or its `www.`), on its port, over https.
 * Plain http only on loopback, which browsers also treat as a secure context.
 */
const secretTarget = (site: string) => {
  const [host = "", port = ""] = site.split(":");
  return { host, port, http: /^127\.\d+\.\d+\.\d+$/.test(host) };
};
export const onSecretHost = (url: string, site: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const { host, port, http } = secretTarget(site);
  return (
    (parsed.protocol === "https:" || (http && parsed.protocol === "http:")) &&
    parsed.port === port &&
    (parsed.hostname === host || parsed.hostname === `www.${host}`)
  );
};

const NOT_SECRET_FIELD: Record<SecretKind, string> = {
  password:
    "is not a password field (type=password, or autocomplete current-password or new-password)",
  username: "is not a sign-in name field (an email, phone or text input, or autocomplete username)",
  code: "is not a code field (a text, number, phone or password input, or autocomplete one-time-code)",
};

export interface PageText {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly blocked: string | null;
  readonly element: string | null;
  readonly challenge: Challenge | null;
  /** The sign-in step the page shows: a password field, a one-time-code field, or neither. */
  readonly form: "password" | "code" | null;
}

export interface Pin {
  readonly site: string;
  readonly origins: ReadonlyArray<string>;
  readonly assets?: ReadonlyArray<string>;
}
export const allowedBy = (pin: Pin, url: string) =>
  onSite(url, pin.site) || pin.origins.some((origin) => onSite(url, origin));

/**
 * Network requests use the same HTTP origin policy, including websocket handshakes. Subresources
 * may also come from the pin's asset hosts; a top-level page may not.
 */
export const requestAllowedBy = (
  pin: Pin | null,
  url: string,
  options?: { readonly topLevel?: boolean },
) => {
  if (pin === null) return true;
  if (!/^(?:https?|wss?):/i.test(url)) return true;
  const comparable = url.replace(/^wss?:/i, (protocol) =>
    protocol.toLowerCase() === "wss:" ? "https:" : "http:",
  );
  return (
    allowedBy(pin, comparable) ||
    (options?.topLevel !== true && (pin.assets ?? []).some((asset) => onSite(comparable, asset)))
  );
};

/** Clicks never execute a non-HTTP anchor scheme; a `#fragment` link on a page stays on it. */
export const clickAllowedBy = (href: string | null, documentUrl?: string) =>
  href === null ||
  /^(?:https?):/i.test(href) ||
  (documentUrl !== undefined &&
    href.includes("#") &&
    href.slice(0, href.indexOf("#")) === documentUrl.split("#")[0]);

const NO_SITES: Pin = { site: "closed.invalid", origins: [] };

const samePin = (left: Pin | null, right: Pin | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    JSON.stringify([left.site, left.origins, left.assets ?? []]) ===
      JSON.stringify([right.site, right.origins, right.assets ?? []]));

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

interface Session {
  readonly proc: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly egress: EgressProxy;
  readonly pending: Map<number, Waiter>;
  readonly frameWaiters: Set<() => void>;
  nextId: number;
  pageSession: string | null;
  mainSession: string | null;
  mainTarget: string | null;
  activeTarget: string | null;
  readonly sheetPopups: Array<{ session: string; targetId: string }>;
  readonly pageInfo: Map<string, { url: string; title: string }>;
  agent: ReturnType<typeof browserAgent> | null;
  mainFrame: string | null;
  pin: Pin | null;
  lastPin: Pin | null;
  blocked: string | null;
  readonly popups: Map<string, string>;
  adopt: string | null;
  navigated: boolean;
  sheet: boolean;
  viewport: Viewport;
  /** `seq` also moves when only the focus changes; `imageSeq` is the seq of the newest picture. */
  frame: {
    seq: number;
    imageSeq: number;
    image: string | null;
    width: number;
    height: number;
    offsetTop: number;
  };
  sharpTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The last two screencast frames, older first. One that matches the newer changed nothing; a
   * page nobody is touching that returns to the older is blinking, which is not worth sending.
   */
  recentMotion: readonly [string | null, string | null];
  lastInputAt: number;
  lastScreencastAt: number;
  focus: SheetFocus | null;
  /** The id of the latest sheet tap; a focus read reports the one it started after. */
  tap: number | null;
  /** Reads started and the newest applied, so a slow older read never replaces a newer one. */
  focusReads: number;
  focusApplied: number;
  url: string | null;
  title: string | null;
  lastUsed: number;
  closed: boolean;
  queue: Promise<unknown>;
}

const FocusRead = Schema.Struct({
  editing: Schema.NullOr(Schema.Boolean),
  fields: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Int])),
});
const isFocusRead = Schema.is(FocusRead);

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Space: { code: "Space", keyCode: 32, text: " " },
};
const PRESSABLE_KEYS = Object.keys(KEYS);

/** Sites that send a phone browser to their native app (Slack: `/client` to `/app`, sign-in to a download page). */
const DESKTOP_SITES = ["slack.com"];

/**
 * A phone Chrome, or a Linux desktop Chrome for a profile on DESKTOP_SITES. No headless brand in
 * the client hints: the browser would list its own HeadlessChrome in the full version list.
 */
export const browserAgent = (product: string, profile: string) => {
  const version = product.split("/")[1] ?? "156.0.0.0";
  const major = version.split(".")[0] ?? "156";
  const desktop = DESKTOP_SITES.some((site) => profile === site || profile.endsWith(`.${site}`));
  const brands = {
    brands: [
      { brand: "Not.A/Brand", version: "99" },
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
    ],
    fullVersionList: [
      { brand: "Not.A/Brand", version: "99.0.0.0" },
      { brand: "Chromium", version },
      { brand: "Google Chrome", version },
    ],
    fullVersion: version,
  };
  return {
    userAgent: desktop
      ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
      : `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    // No q-values: Chromium adds its own, and a list with them leaks into navigator.languages.
    acceptLanguage: "en-US,en",
    platform: desktop ? "Linux x86_64" : "Linux armv8l",
    userAgentMetadata: desktop
      ? {
          ...brands,
          platform: "Linux",
          platformVersion: "6.8.0",
          architecture: "x86",
          bitness: "64",
          model: "",
          mobile: false,
          formFactors: ["Desktop"],
        }
      : {
          ...brands,
          platform: "Android",
          platformVersion: "14.0.0",
          architecture: "",
          model: "Pixel 8",
          mobile: true,
          formFactors: ["Mobile"],
        },
  };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface NavigationHistory {
  readonly currentIndex: number;
  readonly entries: ReadonlyArray<{ readonly id: number }>;
}

export const historyEntry = (history: NavigationHistory, direction: "back" | "forward") =>
  history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];

/**
 * Starts a profile's Chromium with CDP on its stdin and stdout, NUL-delimited, and with
 * `egressFlags(proxyPort)`: the browser reaches the network only through the vault's proxy.
 */
export type LaunchBrowser = (
  profile: string,
  proxyPort: number,
) => NodeChildProcess.ChildProcessWithoutNullStreams;

const isLocalHost = (host: string) => ["127.0.0.1", "localhost", "::1"].includes(host);

export const sshLaunchArgs = (target: SshTarget, profile: string, proxyPort: number) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${target.knownHostsFile}`,
  "-o",
  "ServerAliveInterval=15",
  ...(isLocalHost(target.host)
    ? []
    : ["-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${proxyPort}:127.0.0.1:${proxyPort}`]),
  "-i",
  target.identityFile,
  `${target.user}@${target.host}`,
  `open ${profile} ${proxyPort}`,
];

const sshLaunch =
  (target: SshTarget): LaunchBrowser =>
  (profile, proxyPort) =>
    NodeChildProcess.spawn("ssh", sshLaunchArgs(target, profile, proxyPort), {
      stdio: ["pipe", "pipe", "pipe"],
    });

/** Targets a page or worker session attaches to on its own; each is paused until it is filtered. */
const CHILD_TARGETS = [
  { type: "iframe", exclude: false },
  { type: "worker", exclude: false },
  { type: "shared_worker", exclude: false },
  { type: "service_worker", exclude: false },
];
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: CHILD_TARGETS,
};
const ALL_REQUESTS = [{ urlPattern: "*", requestStage: "Request" }];
/** DevTools issues about a page's own code quality, which say nothing about a refused sign-in. */
const QUIET_ISSUES = new Set(["PerformanceIssue", "QuirksModeIssue", "LowTextContrastIssue"]);
const MAX_SHEET_POPUPS = 2;

export const makeBrowsers = (
  target: SshTarget,
  launch: LaunchBrowser = sshLaunch(target),
  options: {
    /** Ports the egress proxies may use, inclusive; the host firewall allows only these. */
    readonly proxyPorts?: readonly [number, number];
    /** Private IP literals the proxy may reach; none in production, loopback fixtures in tests. */
    readonly permitPrivate?: (host: string, port: number) => boolean;
    readonly trace?: (line: string) => void;
    /** Profiles live on the sessions host only while their browser runs; the vault stores them. */
    readonly lease?: ProfileLease;
  } = {},
) => {
  const sessions = new Map<string, Session>();
  const tracedBodies = new Map<string, string>();
  const tracedRequests = new Map<string, string>();
  const tracedNotes = new Set<string>();
  const note = (trace: (line: string) => void, line: string) => {
    if (tracedNotes.has(line) || tracedNotes.size >= 200) return;
    tracedNotes.add(line);
    trace(line);
  };

  const traceEvent = (
    session: Session,
    trace: (line: string) => void,
    method: unknown,
    params: Record<string, unknown>,
    from: string | null,
  ) => {
    const requestId = String(params.requestId ?? "");
    if (method === "Network.requestWillBeSent") {
      const url = (params.request as { url?: string } | undefined)?.url ?? "";
      if (["XHR", "Fetch", "Document"].includes(String(params.type)) && tracedRequests.size < 500)
        tracedRequests.set(requestId, url);
    } else if (method === "Network.responseReceived") {
      const response = (params.response ?? {}) as {
        url?: string;
        status?: number;
        mimeType?: string;
      };
      const traced = traceResponse(
        String(params.type),
        response.url ?? "",
        response.status ?? 0,
        response.mimeType ?? "",
      );
      if (traced === null) return;
      trace(`sheet ${traced.line}`);
      if (traced.readBody && tracedBodies.size < 50) tracedBodies.set(requestId, traced.line);
    } else if (method === "Network.loadingFinished") {
      tracedRequests.delete(requestId);
      const line = tracedBodies.get(requestId);
      if (line === undefined) return;
      tracedBodies.delete(requestId);
      void send(session, "Network.getResponseBody", { requestId }, from ?? undefined)
        .then((result) => {
          const { body, base64Encoded } = result as { body: string; base64Encoded: boolean };
          const summary = traceSummary(
            base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body,
          );
          if (summary !== null) trace(`sheet ${line} ${summary}`);
        })
        .catch(() => undefined);
    } else if (method === "Network.loadingFailed") {
      const url = tracedRequests.get(requestId);
      tracedRequests.delete(requestId);
      tracedBodies.delete(requestId);
      if (url !== undefined && params.canceled !== true)
        trace(
          `sheet failed ${String(params.type)} ${tracedUrl(url)} ${String(params.errorText ?? "")} ${String(params.blockedReason ?? "")}`.trim(),
        );
    } else if (method === "Log.entryAdded") {
      const entry = (params.entry ?? {}) as { level?: string; source?: string; text?: string };
      if (entry.level === "error" || entry.level === "warning")
        note(trace, `sheet log ${entry.level} ${entry.source}: ${tracedText(entry.text ?? "")}`);
    } else if (method === "Audits.issueAdded") {
      const issue = (params.issue ?? {}) as { code?: string; details?: unknown };
      if (!QUIET_ISSUES.has(issue.code ?? ""))
        note(trace, `sheet issue ${issue.code} ${issueReasons(issue.details)}`.trim());
    }
  };

  const send = (session: Session, method: string, params: object = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (session.closed) return reject(new Error("The browser closed."));
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, CALL_TIMEOUT_MS);
      session.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      session.proc.stdin.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  const page = (session: Session, method: string, params: object = {}) =>
    send(session, method, params, session.pageSession ?? undefined);

  /** Per profile, the restore or save in flight; the next one starts after it, so none overlaps. */
  const leaseOps = new Map<string, Promise<void>>();
  const queueLease = <A>(profile: string, task: () => Promise<A>) => {
    const result = (leaseOps.get(profile) ?? Promise.resolve()).then(task);
    leaseOps.set(
      profile,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };

  const close = (profile: string, save = true) => {
    const session = sessions.get(profile);
    if (!session) return;
    sessions.delete(profile);
    session.closed = true;
    for (const waiter of session.pending.values()) waiter.reject(new Error("The browser closed."));
    for (const wake of session.frameWaiters) wake();
    if (session.sharpTimer !== null) clearTimeout(session.sharpTimer);
    session.egress.close();
    const lease = options.lease;
    if (!lease) {
      session.proc.stdin.end();
      session.proc.kill("SIGTERM");
      return;
    }
    // The browser shuts down by itself, so it writes its cookies; the profile is fetched after it
    // exits. A browser that does not leave in time is killed and its last stored copy stays.
    const exited = new Promise<void>((resolve) => {
      if (session.proc.exitCode !== null || session.proc.signalCode !== null) return resolve();
      session.proc.once("exit", () => resolve());
    });
    const killer = setTimeout(() => session.proc.kill("SIGTERM"), LEASE_EXIT_MS);
    void exited.then(() => clearTimeout(killer));
    try {
      session.proc.stdin.write(
        `${JSON.stringify({ id: session.nextId++, method: "Browser.close" })}\0`,
      );
    } catch {
      // The pipe is already gone.
    }
    session.proc.stdin.end();
    if (save)
      queueLease(profile, () => exited.then(() => lease.save(profile))).catch(() => undefined);
  };

  /**
   * Changes what the browser may reach. Tunnels and requests the proxy let through under the old
   * pin are cut when it differs, so nothing opened under it outlives it.
   */
  const repin = (session: Session, pin: Pin | null) => {
    if (!samePin(session.pin, pin)) session.egress.closeConnections();
    session.pin = pin;
    if (pin !== null) session.lastPin = pin;
  };

  const settlePopup = (session: Session, popupSession: string, url: string) => {
    const targetId = session.popups.get(popupSession);
    session.popups.delete(popupSession);
    if (session.pin !== null) {
      if (/^https?:/i.test(url) && allowedBy(session.pin, url)) session.adopt ??= url;
      else session.blocked ??= url || "a popup";
    }
    if (targetId) void send(session, "Target.closeTarget", { targetId }).catch(() => undefined);
  };

  /**
   * Lets a held child target run. A frame filters its requests like the page first and stays
   * paused if that fails. Workers have no Fetch domain; the egress proxy filters their traffic.
   */
  const releaseTarget = async (session: Session, attached: string, type: string) => {
    if (type === "iframe") {
      await send(session, "Fetch.enable", { patterns: ALL_REQUESTS }, attached);
      if (options.trace)
        for (const domain of ["Network", "Log", "Audits"])
          await send(session, `${domain}.enable`, {}, attached).catch(() => undefined);
      await send(session, "Target.setAutoAttach", AUTO_ATTACH, attached).catch(() => undefined);
    }
    await send(session, "Runtime.runIfWaitingForDebugger", {}, attached);
  };

  /**
   * The picture is the authority: the metadata's device size is used only when it has the picture's shape,
   * since Chromium reports it at the time of sending, which may be after a resize the picture predates.
   */
  const screencastSize = (data: string, metadata: unknown) => {
    const meta = (metadata ?? {}) as {
      deviceWidth?: number;
      deviceHeight?: number;
      offsetTop?: number;
    };
    const picture = jpegSizeOfBase64(data) ?? VIEWPORT;
    const claimed =
      meta.deviceWidth !== undefined &&
      meta.deviceHeight !== undefined &&
      Math.abs(meta.deviceWidth / meta.deviceHeight - picture.width / picture.height) < 0.01;
    return {
      width: Math.round(claimed ? (meta.deviceWidth ?? picture.width) : picture.width),
      height: Math.round(claimed ? (meta.deviceHeight ?? picture.height) : picture.height),
      offsetTop: meta.offsetTop ?? 0,
    };
  };

  const publishFrame = (
    session: Session,
    image: string,
    size: { width: number; height: number; offsetTop?: number },
  ) => {
    session.frame = {
      seq: session.frame.seq + 1,
      imageSeq: session.frame.seq + 1,
      image,
      width: size.width,
      height: size.height,
      offsetTop: size.offsetTop ?? 0,
    };
    for (const wake of session.frameWaiters) wake();
    session.frameWaiters.clear();
  };

  /** Publishes the sheet page's focus when it changed, without a new picture. */
  const readFocus = async (session: Session) => {
    const read = ++session.focusReads;
    const tap = session.tap;
    const value = await Promise.race([
      evaluate(session, SHEET_FOCUS_SCRIPT),
      sleep(FOCUS_READ_MS).then(() => undefined),
    ]).catch(() => undefined);
    if (!isFocusRead(value) || session.closed || !session.sheet || read < session.focusApplied)
      return;
    session.focusApplied = read;
    const focus: SheetFocus = {
      editing: value.editing,
      fields: value.fields.map(([x, y, width, height]) => ({ x, y, width, height })),
      tap,
    };
    if (JSON.stringify(focus) === JSON.stringify(session.focus)) return;
    session.focus = focus;
    session.frame = { ...session.frame, seq: session.frame.seq + 1 };
    for (const wake of session.frameWaiters) wake();
    session.frameWaiters.clear();
  };

  const scheduleSharp = (session: Session) => {
    if (session.sharpTimer !== null) clearTimeout(session.sharpTimer);
    session.sharpTimer = setTimeout(() => {
      session.sharpTimer = null;
      if (session.closed || !session.sheet) return;
      void readFocus(session);
      const seq = session.frame.imageSeq;
      const viewport = session.viewport;
      // A capture that waits for a paint that never comes is dropped, and a newer frame wins.
      void Promise.race([
        page(session, "Page.captureScreenshot", { format: "jpeg", quality: SHARP_QUALITY }),
        sleep(CAPTURE_TIMEOUT_MS).then(() => undefined),
      ])
        .then((shot) => {
          const data = (shot as { data?: string } | undefined)?.data;
          // The page may have been resized while the shot was taken: then it shows the old size.
          if (
            data &&
            !session.closed &&
            session.sheet &&
            session.frame.imageSeq === seq &&
            session.viewport === viewport
          )
            publishFrame(session, `data:image/jpeg;base64,${data}`, viewport);
        })
        .catch(() => undefined);
    }, SHARP_AFTER_MS);
  };

  const startScreencast = async (session: Session) => {
    await page(session, "Page.stopScreencast").catch(() => undefined);
    session.recentMotion = [null, null];
    await page(session, "Page.startScreencast", {
      format: "jpeg",
      quality: MOTION_QUALITY,
      maxWidth: session.viewport.width,
      maxHeight: session.viewport.height,
      everyNthFrame: 1,
    });
  };

  const applyViewport = async (
    session: Session,
    viewport: Viewport,
    sessionId: string | undefined = session.pageSession ?? undefined,
  ) => {
    session.recentMotion = [null, null];
    await send(
      session,
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        // Headful Chrome can read input divided by an emulated scale above 1, so taps miss.
        deviceScaleFactor: 1,
        mobile: session.agent?.userAgentMetadata.mobile ?? true,
      },
      sessionId,
    );
    session.viewport = viewport;
  };

  const onEvent = (session: Session, message: Record<string, unknown>) => {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const from = typeof message.sessionId === "string" ? message.sessionId : null;
    if (session.sheet && options.trace)
      traceEvent(session, options.trace, message.method, params, from);
    if (message.method === "Target.attachedToTarget") {
      const info = params.targetInfo as { targetId?: string; type?: string; url?: string };
      const attached = String(params.sessionId);
      // A service worker fetches outside the page session and is never released: a paused target
      // runs no script and sends no request.
      if (info.type === "service_worker") {
        void send(session, "Target.closeTarget", { targetId: info.targetId ?? "" }).catch(
          () => undefined,
        );
        return;
      }
      if (info.type === "iframe" || info.type === "worker" || info.type === "shared_worker") {
        void releaseTarget(session, attached, info.type).catch(() => undefined);
        return;
      }
      if (info.targetId === session.mainTarget || info.type !== "page") {
        void send(session, "Runtime.runIfWaitingForDebugger", {}, attached)
          .then(() => send(session, "Target.detachFromTarget", { sessionId: attached }))
          .catch(() => undefined);
        return;
      }
      // Before the vault has its page, this is that page's own attach. While the user drives the
      // sheet a popup is shown on it; for a bot it is held.
      if (session.pin === null) {
        if (session.mainTarget === null)
          void send(session, "Runtime.runIfWaitingForDebugger", {}, attached).catch(
            () => undefined,
          );
        else void showPopup(session, attached, info.targetId ?? "").catch(() => undefined);
        return;
      }
      session.popups.set(attached, info.targetId ?? "");
      const url = info.url ?? "";
      if (/^https?:/i.test(url)) return settlePopup(session, attached, url);
      // A popup opened blank names its page only when it loads it; catch that load.
      void send(
        session,
        "Fetch.enable",
        { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
        attached,
      )
        .then(() => send(session, "Runtime.runIfWaitingForDebugger", {}, attached))
        .catch(() => settlePopup(session, attached, ""));
      return;
    }
    if (message.method === "Fetch.requestPaused" && from !== null && session.popups.has(from)) {
      void send(
        session,
        "Fetch.failRequest",
        { requestId: params.requestId, errorReason: "BlockedByClient" },
        from,
      ).catch(() => undefined);
      const request = params.request as { url?: string } | undefined;
      settlePopup(session, from, request?.url ?? "");
      return;
    }
    if (
      message.method === "Page.frameNavigated" &&
      from !== null &&
      session.sheetPopups.some((popup) => popup.session === from) &&
      (params.frame as { parentId?: string } | undefined)?.parentId === undefined
    ) {
      void refreshPopup(session, from).catch(() => undefined);
    }
    if (
      message.method === "Page.frameNavigated" &&
      from === session.pageSession &&
      (params.frame as { parentId?: string } | undefined)?.parentId === undefined
    ) {
      session.navigated = true;
      // The old document's fields would place the keyboard on the new page.
      session.focus = null;
    }
    // Read as soon as the page has loaded, before it rests, so a quick tap on a field finds it.
    if (message.method === "Page.loadEventFired" && from === session.pageSession && session.sheet)
      void readFocus(session);
    if (message.method === "Fetch.requestPaused") {
      // Every paused request must be answered or the page hangs, in the session that paused it.
      const request = params.request as { url?: string } | undefined;
      const url = request?.url ?? "";
      const topLevel =
        params.resourceType === "Document" &&
        from === session.pageSession &&
        params.frameId === session.mainFrame;
      const offSite = !requestAllowedBy(session.pin, url, { topLevel });
      if (offSite && topLevel) session.blocked = url;
      void send(
        session,
        offSite ? "Fetch.failRequest" : "Fetch.continueRequest",
        offSite
          ? { requestId: params.requestId, errorReason: "BlockedByClient" }
          : { requestId: params.requestId },
        from ?? session.pageSession ?? undefined,
      ).catch(() => undefined);
      return;
    }
    if (message.method === "Network.webSocketCreated" && from === session.pageSession) {
      const url = String(params.url ?? "");
      if (!requestAllowedBy(session.pin, url)) session.blocked ??= url;
    }
    if (message.method === "Page.screencastFrame") {
      // Acked first, in the session it came from: Chromium sends the next frame only after this one.
      void send(
        session,
        "Page.screencastFrameAck",
        { sessionId: params.sessionId },
        from ?? undefined,
      ).catch(() => undefined);
      if (from !== session.pageSession) return;
      const image = `data:image/jpeg;base64,${String(params.data)}`;
      // A sharp screenshot repaints the page, which reports a change; the same picture is no news.
      const [older, newer] = session.recentMotion;
      if (image === newer) return;
      session.recentMotion = [newer, image];
      // A page the user is not touching can change by itself, now and then (a blinking caret):
      // showing that small frame would flip the sheet between blurry and sharp, so an isolated
      // change waits for the sharp frame, and a blink back to the frame before costs nothing. A
      // reaction to a touch, a run of frames (a load, a scroll) and the first picture show at once.
      const now = Date.now();
      const continuous = now - session.lastScreencastAt < CONTINUOUS_MS;
      const reacting = now - session.lastInputAt < REACTION_MS;
      session.lastScreencastAt = now;
      if (!continuous && !reacting && image === older) return;
      if (continuous || reacting || session.frame.image === null)
        publishFrame(session, image, screencastSize(String(params.data), params.metadata));
      scheduleSharp(session);
    }
    if (message.method === "Target.targetInfoChanged") {
      const info = params.targetInfo as {
        targetId?: string;
        type?: string;
        url?: string;
        title?: string;
      };
      if (info?.type === "page" && info.targetId !== undefined) {
        session.pageInfo.set(info.targetId, { url: info.url ?? "", title: info.title ?? "" });
        if (session.activeTarget === null || info.targetId === session.activeTarget) {
          session.url = info.url ?? session.url;
          session.title = info.title ?? session.title;
        }
      }
    }
    if (message.method === "Target.targetDestroyed") {
      const targetId = String(params.targetId);
      session.pageInfo.delete(targetId);
      void leavePopup(session, targetId).catch(() => undefined);
    }
  };

  const spawnSession = async (profile: string) => {
    // Chromium reaches the network only through this proxy, which follows the session's pin.
    const egress = await startEgressProxy(
      {
        allows: ({ scheme, host, port }) =>
          requestAllowedBy(
            session.pin,
            `${scheme}://${host.includes(":") ? `[${host}]` : host}${port === (scheme === "http" ? 80 : 443) ? "" : `:${port}`}/`,
          ),
        permitPrivate: options.permitPrivate,
      },
      options.proxyPorts,
    );
    let proc: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      proc = launch(profile, egress.port);
    } catch (error) {
      egress.close();
      throw error;
    }
    const session: Session = {
      proc,
      egress,
      pending: new Map(),
      frameWaiters: new Set(),
      nextId: 1,
      pageSession: null,
      mainSession: null,
      mainTarget: null,
      activeTarget: null,
      sheetPopups: [],
      pageInfo: new Map(),
      agent: null,
      mainFrame: null,
      pin: null,
      lastPin: null,
      blocked: null,
      popups: new Map(),
      adopt: null,
      navigated: false,
      sheet: false,
      viewport: VIEWPORT,
      sharpTimer: null,
      recentMotion: [null, null],
      lastInputAt: 0,
      lastScreencastAt: 0,
      focus: null,
      tap: null,
      focusReads: 0,
      focusApplied: 0,
      frame: {
        seq: 0,
        imageSeq: 0,
        image: null,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        offsetTop: 0,
      },
      url: null,
      title: null,
      lastUsed: Date.now(),
      closed: false,
      queue: Promise.resolve(),
    };
    let buffer = Buffer.alloc(0);
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end = buffer.indexOf(0);
      while (end !== -1) {
        const text = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        end = buffer.indexOf(0);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof message.id === "number") {
          const waiter = session.pending.get(message.id);
          session.pending.delete(message.id);
          if (message.error)
            waiter?.reject(new Error(String((message.error as { message?: string }).message)));
          else waiter?.resolve(message.result);
        } else onEvent(session, message);
      }
    });
    // SSH and the forced command report on stderr; keep it out of the vault log.
    proc.stderr.on("data", () => undefined);
    proc.on("exit", () => {
      if (sessions.get(profile) === session) close(profile);
      session.closed = true;
    });
    return session;
  };

  const preparePage = async (
    session: Session,
    sessionId: string,
    agent: ReturnType<typeof browserAgent>,
  ) => {
    const on = (method: string, params: object = {}) => send(session, method, params, sessionId);
    // The page's own frames and workers are its children, not the browser's.
    await on("Target.setAutoAttach", AUTO_ATTACH);
    await on("Network.enable");
    // The sheet trace reads the browser's own messages and issues; neither is visible to the page.
    if (options.trace) {
      await on("Log.enable");
      await on("Audits.enable");
    }
    await on("Page.addScriptToEvaluateOnNewDocument", { source: CLICK_GUARD_SCRIPT });
    await on("Page.addScriptToEvaluateOnNewDocument", { source: PHONE_BROWSER_SCRIPT });
    await on("Page.enable");
    await on("Fetch.enable", { patterns: ALL_REQUESTS });
    await on("Emulation.setUserAgentOverride", agent);
    await on("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: 8 });
    await on("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  };

  const switchTo = async (session: Session, sessionId: string, targetId: string) => {
    await page(session, "Page.stopScreencast").catch(() => undefined);
    session.pageSession = sessionId;
    session.activeTarget = targetId;
    const info = session.pageInfo.get(targetId);
    if (info) {
      session.url = info.url;
      session.title = info.title;
    }
  };

  /** Not queued: the opener's script waits for the new window, so a tap that opened it is still in flight, and the queue would wait for that tap. */
  const showPopup = async (session: Session, attached: string, targetId: string) => {
    if (!session.sheet || session.agent === null) {
      void send(session, "Target.closeTarget", { targetId }).catch(() => undefined);
      return;
    }
    // The oldest goes: the newest may be the window that opened this one, and is waiting for it.
    if (session.sheetPopups.length >= MAX_SHEET_POPUPS) {
      const replaced = session.sheetPopups.shift();
      if (replaced)
        void send(session, "Target.closeTarget", { targetId: replaced.targetId }).catch(
          () => undefined,
        );
    }
    session.sheetPopups.push({ session: attached, targetId });
    try {
      await preparePage(session, attached, session.agent);
      await applyViewport(session, session.viewport, attached);
      await send(session, "Runtime.runIfWaitingForDebugger", {}, attached);
      await switchTo(session, attached, targetId);
      // A window opens behind its opener; a hidden page paints and takes input only once shown.
      await page(session, "Page.bringToFront");
      await startScreencast(session);
      scheduleSharp(session);
    } catch {
      void send(session, "Target.closeTarget", { targetId }).catch(() => undefined);
    }
  };

  /**
   * A popup that moves to another site gets a new renderer, which comes up hidden and without the phone setup:
   * until it is shown and set up again, it paints but takes no touch or click.
   */
  const refreshPopup = async (session: Session, popupSession: string) => {
    await applyViewport(session, session.viewport, popupSession);
    await send(
      session,
      "Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 5 },
      popupSession,
    );
    if (session.pageSession === popupSession)
      await send(session, "Page.bringToFront", {}, popupSession);
  };

  const leavePopup = (session: Session, targetId: string) =>
    serial(session, async () => {
      const index = session.sheetPopups.findIndex((popup) => popup.targetId === targetId);
      if (index === -1) return;
      const shown = index === session.sheetPopups.length - 1;
      session.sheetPopups.splice(index, 1);
      if (!shown || session.closed || session.mainSession === null || session.mainTarget === null)
        return;
      const below = session.sheetPopups.at(-1);
      await switchTo(
        session,
        below?.session ?? session.mainSession,
        below?.targetId ?? session.mainTarget,
      );
      if (!session.sheet) return;
      await applyViewport(session, session.viewport);
      await page(session, "Page.bringToFront");
      await startScreencast(session);
      scheduleSharp(session);
    });

  const endPopups = async (session: Session) => {
    const shown = session.sheetPopups.splice(0);
    session.pageSession = session.mainSession;
    session.activeTarget = session.mainTarget;
    await Promise.all(
      shown.map((popup) =>
        send(session, "Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined),
      ),
    );
    const { targetInfos } = (await send(session, "Target.getTargets").catch(() => ({
      targetInfos: [],
    }))) as { targetInfos: Array<{ targetId: string; type: string }> };
    await Promise.all(
      targetInfos
        .filter((info) => info.type === "page" && info.targetId !== session.mainTarget)
        .map((info) =>
          send(session, "Target.closeTarget", { targetId: info.targetId }).catch(() => undefined),
        ),
    );
    const info = session.mainTarget === null ? undefined : session.pageInfo.get(session.mainTarget);
    if (info) {
      session.url = info.url;
      session.title = info.title;
    }
  };

  const attach = async (session: Session, profile: string) => {
    await send(session, "Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = (await send(session, "Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    const existing = targetInfos.find((info) => info.type === "page");
    const targetId =
      existing?.targetId ??
      ((await send(session, "Target.createTarget", { url: "about:blank" })) as { targetId: string })
        .targetId;
    const { sessionId } = (await send(session, "Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    session.pageSession = sessionId;
    session.mainSession = sessionId;
    session.mainTarget = targetId;
    session.activeTarget = targetId;
    const { product } = (await send(session, "Browser.getVersion")) as { product: string };
    session.agent = browserAgent(product, profile);
    // New pages (popups, new tabs) attach held, before any of their script runs.
    await send(session, "Target.setAutoAttach", {
      ...AUTO_ATTACH,
      filter: [{ type: "page", exclude: false }, ...CHILD_TARGETS],
    });
    await preparePage(session, sessionId, session.agent);
    const { frameTree } = (await page(session, "Page.getFrameTree")) as {
      frameTree: { frame: { id: string } };
    };
    session.mainFrame = frameTree.frame.id;
    await applyViewport(session, VIEWPORT);
  };

  /** Browsers still starting, so a second caller waits for the first instead of starting another. */
  const starting = new Map<string, Promise<Session>>();

  const ensure = async (profile: string): Promise<Session> => {
    const pending = starting.get(profile);
    if (pending) return pending;
    const live = sessions.get(profile);
    if (live && !live.closed) {
      live.lastUsed = Date.now();
      return live;
    }
    const start = (async () => {
      const lease = options.lease;
      // After any save still running for this profile, so the host never holds two copies.
      if (lease) await queueLease(profile, () => lease.restore(profile));
      const session = await spawnSession(profile);
      sessions.set(profile, session);
      try {
        await attach(session, profile);
      } catch (error) {
        close(profile, false);
        throw error;
      }
      return session;
    })();
    starting.set(profile, start);
    try {
      return await start;
    } finally {
      starting.delete(profile);
    }
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [profile, session] of sessions)
      if (now - session.lastUsed > IDLE_CLOSE_MS) close(profile);
  }, 30_000);
  sweeper.unref();

  const run = <A>(label: string, task: () => Promise<A>) =>
    Effect.tryPromise({
      try: task,
      catch: (cause) =>
        new BrowserError({
          // Not cut here: the vault scrubs typed secrets from it first and then limits it.
          message: `${label}: ${cause instanceof Error ? cause.message : "failed"}`,
          ...(isWrongField(cause) ? { wrongField: true } : {}),
        }),
    });

  const evaluate = async (session: Session, expression: string) => {
    const result = (await page(session, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error("The page script failed.");
    return result.result?.value;
  };

  const currentUrl = async (session: Session) => {
    const value = await evaluate(session, "location.href").catch(() => null);
    return typeof value === "string" ? value : (session.url ?? "about:blank");
  };

  const settle = async (session: Session) => {
    await sleep(700);
    const started = Date.now();
    while (Date.now() - started < SETTLE_MS) {
      const state = await evaluate(session, "document.readyState").catch(() => null);
      if (state === "complete") break;
      await sleep(300);
    }
    await sleep(300);
  };

  const key = async (session: Session, name: string) => {
    const known = KEYS[name];
    if (!known) throw new Error(`Unknown key ${name}. Keys: ${PRESSABLE_KEYS.join(", ")}.`);
    const base = {
      key: name === "Space" ? " " : name,
      code: known.code,
      windowsVirtualKeyCode: known.keyCode,
      nativeVirtualKeyCode: known.keyCode,
    };
    await page(session, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(known.text ? { text: known.text } : {}),
    });
    await page(session, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  /** The page's guard holds the form submit that follows, unless the page handled the key or cancelled the submit itself. */
  const pressEnter = async (session: Session, pin: Pin) => {
    await evaluate(session, "window.__t3VaultHold(true)");
    await key(session, "Enter");
    const held = (await evaluate(session, "window.__t3VaultPending()")) as {
      action: string;
    } | null;
    if (held === null) return;
    if (!/^https?:/i.test(held.action) || !allowedBy(pin, held.action)) {
      await evaluate(session, "window.__t3VaultDrop()");
      throw new Error(
        `The form submits to ${held.action}, which is not on ${pin.site}; it was not submitted.`,
      );
    }
    await evaluate(session, `window.__t3VaultSubmit(${JSON.stringify(held.action)})`);
  };

  const click = async (session: Session, x: number, y: number) => {
    await page(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await page(session, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await page(session, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  };

  const locate = async (session: Session, ref: string) => {
    const found = (await evaluate(session, targetScript(ref))) as {
      x: number;
      y: number;
      label: string;
      href: string | null;
    } | null;
    if (!found) throw new Error(`No element ${ref} on this page. Take a new snapshot.`);
    return found;
  };

  const serial = <A>(session: Session, task: () => Promise<A>) => {
    const next = session.queue.then(task, task);
    session.queue = next.catch(() => undefined);
    return next;
  };

  const perform = async (session: Session, pin: Pin, input: PageAction): Promise<string | null> => {
    const url = await currentUrl(session);
    if (input.action !== "open" && input.action !== "back" && !allowedBy(pin, url))
      throw new Error(`The page is not on ${pin.site}. Open a page on ${pin.site} first.`);
    switch (input.action) {
      case "open":
        await page(session, "Page.navigate", { url: input.url });
        await settle(session);
        return null;
      case "snapshot":
        return null;
      case "click": {
        await evaluate(session, CLICK_GUARD_SCRIPT);
        const found = await locate(session, input.ref);
        if (!clickAllowedBy(found.href, url)) throw new Error("The link scheme is not allowed.");
        await sleep(150);
        const current = await locate(session, input.ref);
        if (!clickAllowedBy(current.href, url)) throw new Error("The link scheme is not allowed.");
        await click(session, current.x, current.y);
        await settle(session);
        return found.label;
      }
      case "type": {
        await evaluate(session, CLICK_GUARD_SCRIPT);
        const secret = input.secret;
        if (secret !== undefined && !onSecretHost(url, secret.site))
          throw new Error(`This page is not on ${secret.site}; the secret was not typed.`);
        const label = await evaluate(session, focusScript(input.ref));
        if (typeof label !== "string")
          throw new Error(`No field ${input.ref} on this page. Take a new snapshot.`);
        if (secret === undefined) {
          await page(session, "Input.insertText", { text: input.text });
        } else {
          // Checked and inserted in one call in the page, so a navigation or a swapped field
          // between the two cannot send the secret elsewhere.
          const target = secretTarget(secret.site);
          const outcome = await evaluate(
            session,
            `window.__t3VaultSecret(${JSON.stringify(input.text)}, ${JSON.stringify(target)}, ${JSON.stringify(secret.kind)})`,
          );
          if (outcome === "off-site")
            throw new Error(
              `The page is not on ${secret.site} any more; the secret was not typed.`,
            );
          if (outcome !== "ok")
            throw new WrongFieldError({
              message: `${label} ${NOT_SECRET_FIELD[secret.kind]}; the secret was not typed.`,
            });
        }
        if (input.submit) await pressEnter(session, pin);
        await (input.submit ? settle(session) : sleep(300));
        return label;
      }
      case "press":
        await evaluate(session, CLICK_GUARD_SCRIPT);
        if (input.key === "Enter") await pressEnter(session, pin);
        else await key(session, input.key);
        await settle(session);
        return null;
      case "scroll":
        await evaluate(
          session,
          `window.scrollBy(0, ${input.direction === "up" ? "-" : ""}Math.round(innerHeight * 0.8))`,
        );
        await sleep(400);
        return null;
      case "back": {
        const history = (await page(session, "Page.getNavigationHistory")) as NavigationHistory;
        const previous = historyEntry(history, "back");
        if (!previous) throw new Error("There is no earlier page.");
        await page(session, "Page.navigateToHistoryEntry", { entryId: previous.id });
        await settle(session);
        return null;
      }
    }
  };

  return {
    openSheet: (profile: string, url: string) =>
      run("Open", async () => {
        const session = await ensure(profile);
        return serial(session, async () => {
          repin(session, null);
          session.sheet = true;
          session.focus = null;
          session.tap = null;
          // A client that went away without closing may have left windows behind.
          await endPopups(session);
          // A client that went away without closing leaves its screencast running.
          await startScreencast(session);
          await page(session, "Page.navigate", { url });
          session.url = url;
        });
      }),
    frame: (profile: string, after: number) =>
      run("Frame", async (): Promise<SheetFrame> => {
        const session = sessions.get(profile);
        const closed = {
          open: false,
          seq: 0,
          image: null,
          url: null,
          title: null,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
        };
        if (!session || !session.sheet) return closed;
        session.lastUsed = Date.now();
        if (session.frame.seq <= after)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              session.frameWaiters.delete(wake);
              resolve();
            }, FRAME_WAIT_MS);
            const wake = () => {
              clearTimeout(timer);
              resolve();
            };
            session.frameWaiters.add(wake);
          });
        if (session.closed) return closed;
        return {
          open: true,
          seq: session.frame.seq,
          image: session.frame.imageSeq > after ? session.frame.image : null,
          url: session.url,
          title: session.title,
          width: session.frame.width,
          height: session.frame.height,
          offsetTop: session.frame.offsetTop,
          popup: session.activeTarget !== session.mainTarget,
          ...(session.focus ? { focus: session.focus } : {}),
        };
      }),
    viewport: (profile: string, requested: Viewport) =>
      run("Viewport", async () => {
        const session = sessions.get(profile);
        if (!session || !session.sheet) throw new Error("The sheet is closed.");
        const viewport = clampViewport(requested);
        return serial(session, async () => {
          if (!session.sheet) throw new Error("The sheet is closed.");
          const same =
            viewport.width === session.viewport.width &&
            viewport.height === session.viewport.height;
          if (same) return;
          await applyViewport(session, viewport);
          await startScreencast(session);
          // A page at rest sends no screencast frame: the new size gets one screenshot anyway.
          scheduleSharp(session);
        });
      }),
    input: (profile: string, input: SheetInput) =>
      run("Input", async () => {
        const session = sessions.get(profile);
        if (!session || !session.sheet) throw new Error("The sheet is closed.");
        // Queued behind any bot action; the sheet is checked again once it is this input's turn.
        return serial(session, async () => {
          if (!session.sheet) throw new Error("The sheet is closed.");
          session.lastUsed = Date.now();
          session.lastInputAt = Date.now();
          switch (input.type) {
            case "tap":
              session.tap = input.id ?? null;
              if (session.sheetPopups.length > 0) await click(session, input.x, input.y);
              // Both go out at once: the pipe keeps their order, and the tap loses a round trip.
              else
                await Promise.all([
                  page(session, "Input.dispatchTouchEvent", {
                    type: "touchStart",
                    touchPoints: [{ x: input.x, y: input.y }],
                  }),
                  page(session, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
                ]);
              // The tap has moved focus by the time its touchEnd is acknowledged.
              await readFocus(session);
              return;
            case "text":
              await page(session, "Input.insertText", { text: input.text });
              return;
            case "key":
              return key(session, input.key);
            case "scroll":
              await page(session, "Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: session.viewport.width / 2,
                y: session.viewport.height / 2,
                deltaX: 0,
                deltaY: input.dy,
              });
              return;
            case "back":
            case "forward": {
              const history = (await page(
                session,
                "Page.getNavigationHistory",
              )) as NavigationHistory;
              const target = historyEntry(history, input.type);
              if (target)
                await page(session, "Page.navigateToHistoryEntry", { entryId: target.id });
              return;
            }
            case "reload":
              await page(session, "Page.reload");
              return;
            case "closePopup": {
              const shown = session.sheetPopups.at(-1);
              if (shown) await send(session, "Target.closeTarget", { targetId: shown.targetId });
              return;
            }
          }
        });
      }),
    closeSheet: (profile: string) =>
      run("Close", async () => {
        const session = sessions.get(profile);
        if (!session) return;
        return serial(session, async () => {
          session.sheet = false;
          session.focus = null;
          if (session.sharpTimer !== null) clearTimeout(session.sharpTimer);
          session.sharpTimer = null;
          await page(session, "Page.stopScreencast").catch(() => undefined);
          await endPopups(session);
          await applyViewport(session, VIEWPORT).catch(() => undefined);
          // The sheet let the page reach any public host; cut what it left open and pin the browser
          // again, to the last bot action's pin or to nothing. A page the pin does not cover goes
          // blank. The browser stays, so the profile keeps its session cookies.
          const pin = session.lastPin ?? NO_SITES;
          repin(session, pin);
          const landed = await currentUrl(session);
          if (landed !== "about:blank" && !allowedBy(pin, landed))
            await page(session, "Page.navigate", { url: "about:blank" }).catch(() => undefined);
        });
      }),
    sheetOpen: (profile: string) => sessions.get(profile)?.sheet === true,
    linkOf: (profile: string, pin: Pin, ref: string) =>
      run("Link", async () => {
        const session = await ensure(profile);
        return serial(session, async () => {
          if (session.sheet) throw new Error(SHEET_OPEN);
          if (!allowedBy(pin, await currentUrl(session)))
            throw new Error(`The page is not on ${pin.site}. Open a page on ${pin.site} first.`);
          return (await locate(session, ref)).href;
        });
      }),
    act: (profile: string, pin: Pin, input: PageAction) =>
      run("Page", async (): Promise<PageText> => {
        const session = await ensure(profile);
        return serial(session, async () => {
          // Checked here, in the queue: the sheet may have opened while this action waited.
          if (session.sheet) throw new Error(SHEET_OPEN);
          repin(session, pin);
          session.blocked = null;
          session.adopt = null;
          session.navigated = false;
          const element = await perform(session, pin, input);
          const adopt = session.adopt;
          if (adopt !== null) {
            session.adopt = null;
            await page(session, "Page.navigate", { url: adopt });
            await settle(session);
          }
          // A page restored from history skips the request pin; leave it for a blank page.
          const landed = await currentUrl(session);
          if (landed !== "about:blank" && !allowedBy(pin, landed)) {
            // A request stopped above leaves Chrome's error page; report the request instead.
            session.blocked ??= landed;
            await page(session, "Page.navigate", { url: "about:blank" });
          }
          const challenge =
            session.navigated && session.blocked === null
              ? await waitOutChallenge(
                  async () => (await evaluate(session, CHALLENGE_PROBE)) as PageSignals,
                  sleep,
                )
              : undefined;
          const snapshot = (await evaluate(session, SNAPSHOT_SCRIPT)) as {
            url: string;
            title: string;
            text: string;
            form: "password" | "code" | null;
          };
          return { ...snapshot, blocked: session.blocked, element, challenge: challenge ?? null };
        });
      }),
    close: (profile: string) => Effect.sync(() => close(profile)),
    wipe: (profile: string) =>
      run("Wipe", async () => {
        if (options.lease) {
          const lease = options.lease;
          close(profile, false);
          // After a save already in flight, so the deleted profile is not stored again.
          await queueLease(profile, () => lease.discard(profile));
        }
        await new Promise<void>((resolve, reject) => {
          close(profile, false);
          const proc = NodeChildProcess.spawn(
            "ssh",
            [
              "-T",
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              `UserKnownHostsFile=${target.knownHostsFile}`,
              "-i",
              target.identityFile,
              `${target.user}@${target.host}`,
              `wipe ${profile}`,
            ],
            { stdio: "ignore" },
          );
          proc.on("exit", (code) =>
            // A host that keeps profiles only while their browser runs deletes any leftover itself.
            code === 0 || options.lease
              ? resolve()
              : reject(new Error("The profile was not deleted.")),
          );
        });
      }),
  };
};
export type Browsers = ReturnType<typeof makeBrowsers>;

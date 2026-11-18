import * as Schema from "effect/Schema";
import { AuthOrchestrationOperateScope } from "./auth.ts";

/**
 * A control the client saw tapped three times with no effect. Every field is a name from a fixed
 * vocabulary or a pattern; the shapes below reject spaces, so page text cannot ride along.
 */
const Token = (max: number) =>
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_$.:+/-]+$/), Schema.isMaxLength(max));

export const STUCK_CONTROL_RING_MAX = 40;

/** Coarse client kinds; the user agent string itself never leaves the client. */
const STUCK_CONTROL_CLIENTS = [
  "ios-webkit",
  "android",
  "desktop-chromium",
  "firefox",
  "safari-mac",
  "electron",
  "other",
] as const;
export type StuckControlClient = (typeof STUCK_CONTROL_CLIENTS)[number];

export const StuckControlReport = Schema.Struct({
  /** `data-ui-target`, else `data-slot` (with `data-variant`), else tag and role. */
  control: Token(96),
  /** The router's route id, such as `/_chat/$environmentId/$threadId`. */
  route: Token(120),
  version: Token(40),
  /** Random per page load; two sessions with one fingerprint make a ticket. */
  session: Token(40),
  /** A cold start followed the stuck taps within a minute. */
  confirmed: Schema.Boolean,
  standalone: Schema.Boolean,
  client: Schema.Literals(STUCK_CONTROL_CLIENTS),
  /** Oldest first: `<event>@<ms before the report>`, such as `file:click@4200`. */
  ring: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[a-z]+(:[A-Za-z0-9_$./-]{1,120})?@\d{1,9}$/)),
  ).check(Schema.isMaxLength(STUCK_CONTROL_RING_MAX)),
});
export type StuckControlReport = typeof StuckControlReport.Type;

export const STUCK_CONTROL_ENDPOINT = {
  path: "/api/stuck-control",
  payload: StuckControlReport,
  success: Schema.Struct({ ticket: Schema.Boolean }),
  scope: AuthOrchestrationOperateScope,
} as const;

/**
 * One bots tab switch as the client's view transition saw it, logged by the server line by line.
 * Outcomes are `resolved`, `none` or `<ErrorName>:<message>` folded to token characters.
 */
export const TabTransitionReport = Schema.Struct({
  from: Token(16),
  to: Token(16),
  /** `document.startViewTransition` exists, and `:active-view-transition-type()` parses. */
  api: Schema.Boolean,
  types: Schema.Boolean,
  called: Schema.Boolean,
  update: Token(120),
  ready: Token(120),
  finished: Token(120),
  updateMs: Schema.Int,
  readyMs: Schema.Int,
  finishedMs: Schema.Int,
  /** Measured time from `ready` to `finished`, -1 when either did not resolve. */
  runMs: Schema.Int,
  /** View-transition animations running at `ready`: `<name>:<duration ms>`, comma-joined. */
  animations: Token(240),
  /**
   * The tab bar at the tap and at `ready`: bar count, their view-transition names (with the named
   * group's size), whether the fill changed, and the backdrop filter before and after.
   */
  bar: Token(240),
  reducedMotion: Schema.Boolean,
  standalone: Schema.Boolean,
  client: Schema.Literals(STUCK_CONTROL_CLIENTS),
  /** `iOS-18.3`, `Safari-18.3`, `AppleWebKit-605.1.15`: version numbers only. */
  os: Token(24),
  browser: Token(24),
  engine: Token(32),
  version: Token(40),
});
export type TabTransitionReport = typeof TabTransitionReport.Type;

export const TAB_TRANSITION_ENDPOINT = {
  path: "/api/tab-transition",
  payload: TabTransitionReport,
  success: Schema.Struct({}),
  scope: AuthOrchestrationOperateScope,
} as const;

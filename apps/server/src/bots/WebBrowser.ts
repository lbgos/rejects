import * as NodeDnsPromises from "node:dns/promises";
import { OrchestratorMcpFailure, onSite, siteOf, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Config from "../config.ts";
import type { AccountAction } from "../vault/Vault.ts";
import {
  type Challenge,
  CHALLENGE_POLL_MS,
  CHALLENGE_POLLS,
  classifyChallenge,
} from "./challenge.ts";
import { slugFor } from "./computer.ts";
import { htmlTitle, htmlToText, TRAWL_HTML_CHARS, TRAWL_TIMEOUT } from "./trawl.ts";

/**
 * The urls and keys live in `<stateDir>/camofox.json`, read by this server only; none reaches a bot or its processes.
 * Each bot is its own Camoufox user with one tab, so cookies and pages never mix.
 * With `firecrawlUrl`, an open of a public page is read by Firecrawl first and reaches the tab only when it fails.
 * `bots`, when given, names the bot chat thread ids that may use it; every other bot gets no Camoufox tool.
 */
const Settings = Schema.Struct({
  url: Schema.String,
  accessKey: Schema.String,
  trawlUrl: Schema.optional(Schema.String),
  firecrawlUrl: Schema.optional(Schema.String),
  firecrawlKey: Schema.optional(Schema.String),
  bots: Schema.optional(Schema.Array(Schema.String)),
});
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings));

/** The `bots` list of `camofox.json`, or undefined when the file or the list is missing or invalid. */
export const webBots = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.flatMap(decodeSettings),
    Effect.map((settings) => settings.bots),
    Effect.orElseSucceed(() => undefined),
  );
const Scraped = Schema.Struct({
  url: Schema.String,
  html: Schema.String,
  statusCode: Schema.Number,
});

const WEB_ACTIONS = ["open", "snapshot", "click", "type", "press", "scroll", "back"] as const;
export const WebBrowseInput = Schema.Struct({
  action: Schema.Literals(WEB_ACTIONS),
  url: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  submit: Schema.optional(Schema.Boolean),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  account: Schema.optional(
    Schema.String.annotate({
      description:
        'A site the user gave you, such as "olx.ua": the action runs in their signed-in browser there.',
    }),
  ),
  secretRef: Schema.optional(
    Schema.String.annotate({
      description:
        "With account and type: the name of a login or code you saved with ask_secret; the vault types it instead of text, and you never see it.",
    }),
  ),
});
type WebBrowseInput = typeof WebBrowseInput.Type;
export const WebPage = Schema.Struct({
  url: Schema.String,
  snapshot: Schema.String,
  nextOffset: Schema.optional(Schema.Int),
  blocked: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
type WebPage = typeof WebPage.Type;

export const WEB_SNAPSHOT_CHARS = 12_000;
const TAB = "bot";

const FIRECRAWL_TIMEOUT = "30 seconds";
/** After a timeout or a connection error, opens skip Firecrawl this long instead of waiting on it each time. */
const FIRECRAWL_PAUSE_MS = 60_000;
/** The same-site check is advisory: a tab listing slower than this counts as no tab. */
const TAB_PROBE_TIMEOUT = "5 seconds";
/** Less text than this is an empty shell or an error, not the page. */
const FIRECRAWL_MIN_CHARS = 100;
const FIRECRAWL_TEXT_CHARS = 200_000;
/** Firecrawl runs no browser here, so a script-only page comes back as its notice. */
const NEEDS_SCRIPT =
  /\b(?:enable|turn on) javascript\b|\bjavascript is (?:disabled|required|not enabled)\b/i;
const NEEDS_SCRIPT_CHARS = 2000;
export const FIRECRAWL_NOTE =
  "Read by Firecrawl as text, without the browser, so there are no refs. To click or type on this page, call snapshot first: it opens the page in your tab.";
const FIRECRAWL_SEARCH_RESULTS = 8;
export const FIRECRAWL_SEARCH_NOTE =
  "Search results as text, with no page behind them. Read a result's page with web_read.";
const NO_REFS =
  "This page was read as text and has no refs yet. Call snapshot to open it in your tab, then use refs from that snapshot.";

type BrowseVia = "firecrawl" | "solver";

/** Either address on the other's site or a subdomain of it, so the two share cookies. */
const sameSite = (a: string, b: string) => {
  const siteA = siteOf(a);
  const siteB = siteOf(b);
  return siteA !== undefined && siteB !== undefined && (onSite(a, siteB) || onSite(b, siteA));
};

/** A page Firecrawl read; the bot's tab still shows the page before it. */
interface TextPage {
  readonly url: string;
  readonly text: string;
}

const textPageAt = ({ url, text }: TextPage, offset: number) => {
  const end = offset + WEB_SNAPSHOT_CHARS;
  return {
    url,
    snapshot: text.slice(offset, end),
    ...(end < text.length ? { nextOffset: end } : {}),
    note: FIRECRAWL_NOTE,
  } satisfies WebPage;
};

const Tabs = Schema.Struct({
  tabs: Schema.Array(
    Schema.Struct({
      tabId: Schema.String,
      url: Schema.optional(Schema.String),
      listItemId: Schema.optional(Schema.String),
    }),
  ),
});
const Created = Schema.Struct({ tabId: Schema.String });
const Navigated = Schema.Struct({ googleBlocked: Schema.optional(Schema.Boolean) });
const Snapshot = Schema.Struct({ url: Schema.String, snapshot: Schema.String });
const Box = Schema.Struct({ x: Schema.Number, y: Schema.Number, height: Schema.Number });
const Probed = Schema.Struct({
  result: Schema.Struct({
    title: Schema.String,
    boxes: Schema.Array(Box),
    loading: Schema.Boolean,
    awsWaf: Schema.Boolean,
  }),
});
/** In production Camoufox hides every 500's message; a stale ref still names the ref. */
const Refusal = Schema.Struct({ error: Schema.String, ref: Schema.optional(Schema.String) });
const FirecrawlScrape = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optional(
    Schema.Struct({
      markdown: Schema.optional(Schema.String),
      metadata: Schema.optional(
        Schema.Struct({
          title: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          url: Schema.optional(Schema.String),
          sourceURL: Schema.optional(Schema.String),
          statusCode: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
});
const FirecrawlSearch = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.optional(
    Schema.Struct({
      web: Schema.optional(
        Schema.Array(
          Schema.Struct({
            url: Schema.String,
            title: Schema.optional(Schema.String),
            description: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
const decodeScraped = Schema.decodeUnknownEffect(Scraped);
const decodeFirecrawl = Schema.decodeUnknownEffect(FirecrawlScrape);
const decodeFirecrawlSearch = Schema.decodeUnknownEffect(FirecrawlSearch);
const isRefusal = Schema.is(Refusal);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

/** Camoufox's whole answer to a navigation that threw, a missing host included. */
const NAVIGATION_THREW = "The browser refused: Internal server error";
/**
 * Camoufox answers a click or type that timed out (it destroys the tab) or failed on the page
 * with its hidden internal error or "tab destroyed". Bots took that for a browser crash.
 */
const ELEMENT_ACTION_FAILED = new Set([
  NAVIGATION_THREW,
  "The browser refused: Tab was destroyed. Open a new tab.",
]);
/** DNS answers for a name that does not exist, not for a resolver that is down. */
const NO_SUCH_NAME = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * The host of `url` when DNS says it does not exist. Bots guess shop domains, and Camoufox
 * reports the miss as a bare internal error, so they retried the same address many times.
 */
export const missingHost = (
  url: string,
  lookup: (host: string) => Promise<unknown> = (host) => NodeDnsPromises.lookup(host),
) => {
  const host = /^https?:\/\/(?:[^@/?#]*@)?([^:/?#]+)/iu.exec(url)?.[1];
  return Effect.tryPromise({
    try: async () => {
      if (host) await lookup(host);
    },
    catch: (error) => (Predicate.hasProperty(error, "code") ? String(error.code) : ""),
  }).pipe(
    Effect.match({
      onSuccess: () => undefined,
      onFailure: (code) => (NO_SUCH_NAME.has(code) ? host : undefined),
    }),
  );
};

const isGoogleResults = (url: string | undefined) => {
  const page = url === undefined ? null : URL.parse(url);
  return page !== null && page.hostname.includes("google.") && page.pathname === "/search";
};

/**
 * Camofox finds a result ref by its heading text, which never matches the result's link, so clicking one hangs for 30 s and closes the tab; opening the address works.
 * Refs are numbered per snapshot, so only the snapshot the bot was shown names its refs.
 */
const googleLinks = (snapshot: string, pageUrl: string) => {
  const lines = snapshot.split("\n");
  return new Map(
    lines.flatMap((line, at) => {
      const ref = /^\s*- link .* \[(e\d+)\]:$/u.exec(line)?.[1];
      const href = /^\s*- \/url: (\S+)$/u.exec(lines[at + 1] ?? "")?.[1];
      const url = href === undefined ? null : URL.parse(href, pageUrl);
      return ref !== undefined && url !== null && /^https?:$/u.test(url.protocol)
        ? [[ref, url.href] as const]
        : [];
    }),
  );
};

const staleRef = (ref: string) =>
  `The browser refused: the page changed and ${ref.slice(0, 20)} is gone. Take a snapshot for current refs, or open the URL again.`;

/**
 * AWS WAF's check pages show no text and define `gokuProps` in an inline script. Camoufox
 * evaluates in an isolated world, where `window` is not the page's but the script text is readable.
 */
const AWS_WAF_PROBE = `[...document.scripts].some((script) => /\\bgokuProps\\b/.test(script.textContent ?? ""))`;

/**
 * The checkbox lives in a cross-origin iframe inside a closed shadow root; its host sits next to the hidden token input.
 * `loading`: the script is on the page but no widget has rendered yet.
 */
const PAGE_PROBE = `({
  title: document.title,
  awsWaf: ${AWS_WAF_PROBE},
  boxes: [...document.querySelectorAll('input[name="cf-turnstile-response"]')]
    .filter((input) => input.value === "" && input.parentElement)
    .map((input) => ([...input.parentElement.children].find((el) => el !== input) ?? input.parentElement).getBoundingClientRect())
    .filter((box) => box.width >= 100 && box.height >= 40 && box.top >= 0 && box.bottom <= innerHeight)
    .map((box) => ({ x: box.x, y: box.y, height: box.height })),
  loading: !document.querySelector('input[name="cf-turnstile-response"]') &&
    !!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]'),
})`;
const CHECKBOX_CLICKS = 2;
const CHECKBOX_SHOWN_POLLS = 3;

export const webInputProblem = (input: WebBrowseInput): string | undefined => {
  switch (input.action) {
    case "open":
      return input.url && /^https?:\/\//iu.test(input.url)
        ? undefined
        : "open needs an http(s) url.";
    case "click":
      return input.ref ? undefined : "click needs a ref from the latest snapshot.";
    case "type":
      if (input.secretRef !== undefined && input.account === undefined)
        return "secretRef works only with account: the site's sign-in runs in its account browser.";
      return input.ref && (input.text !== undefined) !== (input.secretRef !== undefined)
        ? undefined
        : "type needs a ref and either text or secretRef.";
    case "press":
      return input.text ? undefined : "press needs the key name in text.";
    case "scroll":
      return input.text === undefined || input.text === "up" || input.text === "down"
        ? undefined
        : 'scroll takes text "up" or "down".';
    default:
      return undefined;
  }
};

export const accountAction = (input: WebBrowseInput): AccountAction => {
  switch (input.action) {
    case "open":
      return { action: "open", url: input.url ?? "" };
    case "snapshot":
      return { action: "snapshot", offset: input.offset };
    case "click":
      return { action: "click", ref: input.ref ?? "" };
    case "type":
      return {
        action: "type",
        ref: input.ref ?? "",
        text: input.text ?? "",
        submit: input.submit ?? false,
      };
    case "press":
      return { action: "press", key: input.text ?? "" };
    case "scroll":
      return { action: "scroll", direction: input.text === "up" ? "up" : "down" };
    case "back":
      return { action: "back" };
  }
};

const elementActionFailed =
  (what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => isMcpFailure(error) && ELEMENT_ACTION_FAILED.has(error.message),
        () =>
          failure(
            `The ${what} did not finish: it timed out or the page refused it. The browser itself is running. Take a snapshot to see the page as it is, or open the link's address directly.`,
          ),
      ),
    );

export class WebBrowser extends Context.Service<
  WebBrowser,
  {
    /** With `firecrawl`, the search runs on Firecrawl first and in the tab only when that fails. */
    readonly search: (
      botThreadId: ThreadId,
      query: string,
      options?: { readonly firecrawl?: boolean },
    ) => Effect.Effect<WebPage, OrchestratorMcpFailure>;
    readonly browse: (
      botThreadId: ThreadId,
      input: WebBrowseInput,
    ) => Effect.Effect<
      {
        readonly page: WebPage;
        readonly challenge?: Challenge | undefined;
        readonly via?: BrowseVia | undefined;
      },
      OrchestratorMcpFailure
    >;
    /** Drops the page Firecrawl read for this bot: its next action runs in another browser. */
    readonly forget: (botThreadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/bots/WebBrowser") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const http = yield* HttpClient.HttpClient;

  const readSettings = fs.readFileString(path.join(config.stateDir, "camofox.json")).pipe(
    Effect.flatMap(decodeSettings),
    Effect.mapError(() => failure("Web tools are not set up on this server (camofox.json).")),
  );
  const allowed = Effect.fn("WebBrowser.allowed")(function* (botThreadId: ThreadId) {
    const { bots } = yield* readSettings;
    if (bots !== undefined && !bots.includes(botThreadId))
      return yield* failure("Web tools are off for this bot on this server.");
  });

  const call = Effect.fn("WebBrowser.call")(function* <A>(
    schema: Schema.Codec<A>,
    method: "GET" | "POST",
    route: string,
    body?: Readonly<Record<string, unknown>>,
  ) {
    const settings = yield* readSettings;
    const url = new URL(route, settings.url).toString();
    const request =
      method === "GET"
        ? HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(settings.accessKey))
        : yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(settings.accessKey),
            HttpClientRequest.bodyJson(body ?? {}),
          );
    const response = yield* http.execute(request).pipe(Effect.timeout("90 seconds"));
    const json = yield* response.json;
    if (response.status !== 200)
      return yield* failure(
        !isRefusal(json)
          ? "The browser is unavailable."
          : json.ref !== undefined
            ? staleRef(json.ref)
            : `The browser refused: ${json.error.slice(0, 300)}`,
      );
    return yield* Schema.decodeUnknownEffect(schema)(json);
  });

  const userFor = (botThreadId: ThreadId) => `t3-bot-${slugFor(botThreadId)}`;

  const shownLinks = new Map<string, ReadonlyMap<string, string>>();
  /** Per bot user: the page Firecrawl last read, until the bot moves on or opens it in the tab. */
  const textPages = new Map<string, TextPage>();
  let firecrawlPausedUntil = 0;

  /** The bot's tab, adopted from Camoufox when it is still open, so restarts keep the page. */
  const tabFor = Effect.fn("WebBrowser.tabFor")(function* (userId: string) {
    const { tabs } = yield* call(Tabs, "GET", `/tabs?userId=${encodeURIComponent(userId)}`);
    const open = tabs.find((tab) => tab.listItemId === TAB);
    if (open) return open;
    return yield* call(Created, "POST", "/tabs", { userId, sessionKey: TAB });
  });

  const page = Effect.fn("WebBrowser.page")(function* (userId: string, tabId: string, offset = 0) {
    const snapshot = yield* call(
      Snapshot,
      "GET",
      `/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(userId)}`,
    );
    const end = offset + WEB_SNAPSHOT_CHARS;
    if (isGoogleResults(snapshot.url))
      shownLinks.set(tabId, googleLinks(snapshot.snapshot, snapshot.url));
    else shownLinks.delete(tabId);
    return {
      url: snapshot.url,
      snapshot: snapshot.snapshot.slice(offset, end),
      ...(end < snapshot.snapshot.length ? { nextOffset: end } : {}),
    } satisfies WebPage;
  });

  const act = Effect.fn("WebBrowser.act")(function* (
    userId: string,
    { tabId, url }: { readonly tabId: string; readonly url?: string | undefined },
    input: WebBrowseInput,
  ) {
    const tab = `/tabs/${encodeURIComponent(tabId)}`;
    if (input.action === "click" && input.ref && isGoogleResults(url)) {
      const links = shownLinks.get(tabId);
      if (links === undefined) return yield* failure(staleRef(input.ref));
      const address = links.get(input.ref);
      if (address)
        return yield* call(Navigated, "POST", `${tab}/navigate`, { userId, url: address });
    }
    switch (input.action) {
      case "open":
        return yield* call(Navigated, "POST", `${tab}/navigate`, { userId, url: input.url }).pipe(
          Effect.catchIf(
            (error) => isMcpFailure(error) && error.message === NAVIGATION_THREW,
            (error) =>
              missingHost(input.url ?? "").pipe(
                Effect.flatMap((host) =>
                  host
                    ? failure(
                        `${host} does not exist (no DNS record), so the page cannot open. Find the right address, for example with web_search for the site's name; do not open this one again.`,
                      )
                    : Effect.fail(error),
                ),
              ),
          ),
        );
      case "click":
        return yield* call(Schema.Unknown, "POST", `${tab}/click`, {
          userId,
          ref: input.ref,
        }).pipe(elementActionFailed("click"));
      case "type":
        return yield* call(Schema.Unknown, "POST", `${tab}/type`, {
          userId,
          ref: input.ref,
          text: input.text,
          submit: input.submit ?? false,
        }).pipe(elementActionFailed("typing"));
      case "press":
        return yield* call(Schema.Unknown, "POST", `${tab}/press`, { userId, key: input.text });
      case "scroll":
        return yield* call(Schema.Unknown, "POST", `${tab}/scroll`, {
          userId,
          direction: input.text ?? "down",
        });
      case "back":
        return yield* call(Schema.Unknown, "POST", `${tab}/back`, { userId });
      case "snapshot":
        return undefined;
    }
  });

  const probe = Effect.fn("WebBrowser.probe")(
    function* (userId: string, tabId: string) {
      const { result } = yield* call(
        Probed,
        "POST",
        `/tabs/${encodeURIComponent(tabId)}/evaluate`,
        {
          userId,
          expression: PAGE_PROBE,
          timeoutMs: 5000,
        },
      );
      return {
        title: result.title,
        box: result.boxes[0],
        loading: result.loading,
        awsWaf: result.awsWaf,
      };
    },
    Effect.orElseSucceed(() => ({ title: "", box: undefined, loading: false, awsWaf: false })),
  );

  /**
   * Clicks the checkbox like a person: a short pause, then a point inside it (16-26 px from the
   * widget's left edge, within 4 px of its middle). Camoufox moves the cursor there on a human path.
   */
  const clickCheckbox = Effect.fn("WebBrowser.clickCheckbox")(
    function* (userId: string, tabId: string, box: typeof Box.Type) {
      yield* Effect.sleep(Duration.millis(yield* Random.nextIntBetween(300, 900)));
      const x = box.x + (yield* Random.nextIntBetween(16, 26));
      const y = box.y + box.height / 2 + (yield* Random.nextIntBetween(-4, 4));
      yield* call(Schema.Unknown, "POST", `/tabs/${encodeURIComponent(tabId)}/click`, {
        userId,
        coordinates: { x, y },
      });
    },
    Effect.orElseSucceed(() => undefined),
  );

  const viaTrawl = Effect.fn("WebBrowser.viaTrawl")(
    function* (url: string) {
      const { trawlUrl } = yield* readSettings;
      if (trawlUrl === undefined) return undefined;
      const request = yield* HttpClientRequest.post(new URL("/scrape", trawlUrl).toString()).pipe(
        HttpClientRequest.bodyJson({ url, solveEmbeddedCaptchas: true }),
      );
      const response = yield* http.execute(request).pipe(Effect.timeout(TRAWL_TIMEOUT));
      if (response.status !== 200) return undefined;
      const scraped = yield* decodeScraped(yield* response.json);
      const html = scraped.html.slice(0, TRAWL_HTML_CHARS);
      const text = htmlToText(html);
      if (scraped.statusCode >= 400 || text === "") return undefined;
      const title = htmlTitle(html);
      if (classifyChallenge({ url: scraped.url, title, text, html })) return undefined;
      const body = (title ? `${title}\n\n${text}` : text).slice(0, WEB_SNAPSHOT_CHARS);
      return {
        url: scraped.url,
        snapshot: body,
        note: "The browser was stopped by a check on this page; the solver read it instead. This is the page's text only: no refs, and the browser tab still shows the check.",
      } satisfies WebPage;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** Firecrawl's address and key, unless it is unset or paused after a failure. */
  const firecrawlOn = Effect.gen(function* () {
    const { firecrawlUrl, firecrawlKey } = yield* readSettings;
    // A malformed address is a config error: Camoufox serves the call instead.
    if (
      firecrawlUrl === undefined ||
      !/^https?:$/u.test(URL.parse("/v2/", firecrawlUrl)?.protocol ?? "")
    )
      return undefined;
    if ((yield* Clock.currentTimeMillis) < firecrawlPausedUntil) return undefined;
    return { firecrawlUrl, firecrawlKey };
  });

  /** Firecrawl's JSON answer, or undefined when it is not a 200. */
  const firecrawlPost = Effect.fn("WebBrowser.firecrawlPost")(function* (
    {
      firecrawlUrl,
      firecrawlKey,
    }: { readonly firecrawlUrl: string; readonly firecrawlKey?: string | undefined },
    route: string,
    body: Readonly<Record<string, unknown>>,
  ) {
    const post = HttpClientRequest.post(new URL(route, firecrawlUrl).toString());
    const request = yield* HttpClientRequest.bodyJson(
      firecrawlKey === undefined ? post : HttpClientRequest.bearerToken(post, firecrawlKey),
      body,
    );
    const response = yield* http.execute(request).pipe(
      Effect.timeout(FIRECRAWL_TIMEOUT),
      Effect.tapError(() =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          firecrawlPausedUntil = now + FIRECRAWL_PAUSE_MS;
        }),
      ),
    );
    if (response.status !== 200) return undefined;
    return yield* response.json;
  });

  /** Search results as Firecrawl finds them; undefined sends the search to the browser. */
  const searchFirecrawl = Effect.fn("WebBrowser.searchFirecrawl")(
    function* (query: string) {
      const on = yield* firecrawlOn;
      if (on === undefined) return undefined;
      const json = yield* firecrawlPost(on, "/v2/search", {
        query,
        limit: FIRECRAWL_SEARCH_RESULTS,
      });
      if (json === undefined) return undefined;
      const { success, data } = yield* decodeFirecrawlSearch(json);
      const results = (data?.web ?? []).filter(
        (result) => webInputProblem({ action: "open", url: result.url }) === undefined,
      );
      if (!success || results.length === 0) return undefined;
      const snapshot = results
        .map((result, at) =>
          [
            `${at + 1}. ${result.title?.trim() || result.url}`,
            `   ${result.url}`,
            ...(result.description?.trim() ? [`   ${result.description.trim()}`] : []),
          ].join("\n"),
        )
        .join("\n");
      return {
        url: "",
        snapshot: snapshot.slice(0, WEB_SNAPSHOT_CHARS),
        note: FIRECRAWL_SEARCH_NOTE,
      } satisfies WebPage;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** A public page as Firecrawl reads it; undefined sends the open to the browser. */
  const viaFirecrawl = Effect.fn("WebBrowser.viaFirecrawl")(
    function* (userId: string, url: string) {
      const on = yield* firecrawlOn;
      if (on === undefined) return undefined;
      // A tab already on this site may hold its cookies (a cart, a consent); Firecrawl has none.
      const shown = yield* call(Tabs, "GET", `/tabs?userId=${encodeURIComponent(userId)}`).pipe(
        Effect.timeout(TAB_PROBE_TIMEOUT),
        Effect.map(({ tabs }) => tabs.find((tab) => tab.listItemId === TAB)?.url),
        Effect.orElseSucceed(() => undefined),
      );
      if (shown !== undefined && sameSite(shown, url)) return undefined;
      const json = yield* firecrawlPost(on, "/v2/scrape", {
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 0,
      });
      if (json === undefined) return undefined;
      const { success, data } = yield* decodeFirecrawl(json);
      const markdown = data?.markdown?.trim() ?? "";
      const metadata = data?.metadata;
      if (!success || (metadata?.statusCode ?? 200) >= 400 || markdown.length < FIRECRAWL_MIN_CHARS)
        return undefined;
      const title = (
        typeof metadata?.title === "string" ? metadata.title : (metadata?.title?.[0] ?? "")
      ).trim();
      const read = metadata?.url ?? metadata?.sourceURL ?? url;
      if (webInputProblem({ action: "open", url: read })) return undefined;
      if (classifyChallenge({ url: read, title, text: markdown })) return undefined;
      if (markdown.length <= NEEDS_SCRIPT_CHARS && NEEDS_SCRIPT.test(markdown)) return undefined;
      return {
        url: read,
        text: (title ? `${title}\n\n${markdown}` : markdown).slice(0, FIRECRAWL_TEXT_CHARS),
      } satisfies TextPage;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const inBrowser = Effect.fn("WebBrowser.inBrowser")(function* (
    userId: string,
    input: WebBrowseInput,
  ) {
    const tab = yield* tabFor(userId);
    const { tabId } = tab;
    // Camoufox gives no navigation events, so the page (text and title) is checked after any
    // action that may load a page, also one that keeps the address, such as a posted form.
    const mayLoad =
      input.action === "open" ||
      input.action === "back" ||
      input.action === "click" ||
      input.action === "press" ||
      (input.action === "type" && input.submit === true);
    yield* act(userId, tab, input);
    let current = yield* page(userId, tabId, input.action === "snapshot" ? (input.offset ?? 0) : 0);
    if (!mayLoad) return { page: current };
    const look = (shown: WebPage) =>
      probe(userId, tabId).pipe(
        Effect.map(({ title, box, loading, awsWaf }) => ({
          challenge: classifyChallenge({
            url: shown.url,
            title,
            text: shown.snapshot,
            awsWaf,
          }),
          box,
          loading,
        })),
      );
    let { challenge, box, loading } = yield* look(current);
    // A Turnstile checkbox, on a check page or in a form, gets up to two human clicks. A widget
    // on an ordinary page is waited for only until those clicks are spent, and one still
    // rendering only for the first polls.
    let clicks = 0;
    let shown = 0;
    for (
      let poll = 0;
      (challenge || box || (loading && poll < CHECKBOX_SHOWN_POLLS)) && poll < CHALLENGE_POLLS;
      poll++
    ) {
      shown = box ? shown + 1 : 0;
      if (box && shown >= CHECKBOX_SHOWN_POLLS) {
        if (clicks === CHECKBOX_CLICKS && !challenge) break;
        if (clicks < CHECKBOX_CLICKS) {
          yield* clickCheckbox(userId, tabId, box);
          clicks++;
          shown = 0;
        }
      }
      yield* Effect.sleep(Duration.millis(CHALLENGE_POLL_MS));
      current = yield* page(userId, tabId);
      ({ challenge, box, loading } = yield* look(current));
    }
    if (challenge && input.action === "open" && input.url) {
      const solved = yield* viaTrawl(input.url);
      if (solved) return { page: solved, via: "solver" as const };
    }
    return { page: current, challenge };
  });

  const mapFailure = Effect.mapError((error: unknown) =>
    isMcpFailure(error) ? error : failure("The browser is unavailable."),
  );

  return WebBrowser.of({
    search: Effect.fn("WebBrowser.search")(function* (botThreadId, query, options) {
      yield* allowed(botThreadId);
      const userId = userFor(botThreadId);
      textPages.delete(userId);
      if (options?.firecrawl) {
        const results = yield* searchFirecrawl(query);
        if (results) return results;
      }
      const { tabId } = yield* tabFor(userId);
      const google = yield* call(Navigated, "POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, {
        userId,
        macro: "@google_search",
        query,
      });
      if (google.googleBlocked)
        yield* call(Navigated, "POST", `/tabs/${encodeURIComponent(tabId)}/navigate`, {
          userId,
          url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        });
      return yield* page(userId, tabId);
    }, mapFailure),
    browse: Effect.fn("WebBrowser.browse")(function* (botThreadId, input) {
      const problem = webInputProblem(input);
      if (problem) return yield* failure(problem);
      yield* allowed(botThreadId);
      const userId = userFor(botThreadId);
      const read = textPages.get(userId);
      textPages.delete(userId);
      // Signed-in pages never reach Firecrawl: account calls run in the vault's browser.
      if (input.action === "open" && input.url && input.account === undefined) {
        const text = yield* viaFirecrawl(userId, input.url);
        if (text) {
          textPages.set(userId, text);
          return { page: textPageAt(text, 0), via: "firecrawl" as const };
        }
      }
      if (read === undefined || input.action === "open") return yield* inBrowser(userId, input);
      switch (input.action) {
        case "snapshot":
          if (input.offset) {
            textPages.set(userId, read);
            return { page: textPageAt(read, input.offset), via: "firecrawl" as const };
          }
          return yield* inBrowser(userId, { action: "open", url: read.url });
        case "back":
          return yield* inBrowser(userId, { action: "snapshot" });
        default:
          textPages.set(userId, read);
          return yield* failure(NO_REFS);
      }
    }, mapFailure),
    forget: (botThreadId) => Effect.sync(() => void textPages.delete(userFor(botThreadId))),
  });
});

export const layer = Layer.effect(WebBrowser, make);

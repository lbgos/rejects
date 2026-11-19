import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as WebBrowser from "./WebBrowser.ts";

it.effect("browses as the bot's own Camoufox user with the server's key, reusing its tab", () =>
  Effect.gen(function* () {
    const key = "test-camofox-key";
    const page = "x".repeat(WebBrowser.WEB_SNAPSHOT_CHARS + 500);
    const tabs = new Map<string, string>();
    const calls: string[] = [];
    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, string>)
          : {};
      const user = url.searchParams.get("userId") ?? body.userId ?? "";
      calls.push(`${request.method} ${url.pathname} ${user} ${body.url ?? body.macro ?? ""}`);
      const reply = (json: unknown, status = 200) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json, { status })));
      if (request.headers.authorization !== `Bearer ${key}`) return reply({ error: "key" }, 401);
      if (request.method === "GET" && url.pathname === "/tabs")
        return reply({
          tabs: tabs.has(user) ? [{ tabId: tabs.get(user), listItemId: "bot" }] : [],
        });
      if (url.pathname === "/tabs") {
        tabs.set(user, `tab-${tabs.size + 1}`);
        return reply({ tabId: tabs.get(user) });
      }
      if (url.pathname.endsWith("/navigate"))
        return reply(body.macro ? { ok: false, googleBlocked: true } : { ok: true });
      if (url.pathname.endsWith("/snapshot"))
        return reply({ url: "https://page.test/", snapshot: page });
      if (url.pathname.endsWith("/click"))
        return body.ref === "e9"
          ? reply({ error: "Unknown ref: e9" }, 400)
          : body.ref === "e30"
            ? reply({ error: "Internal server error" }, 422)
            : body.ref === "e31"
              ? reply({ error: "Tab was destroyed. Open a new tab." }, 410)
              : reply({ error: "Internal server error", ref: body.ref }, 500);
      return reply({ ok: true });
    });
    const layer = WebBrowser.layer.pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        path.join(stateDir, "camofox.json"),
        JSON.stringify({ url: "http://camofox.test", accessKey: key }),
      );
      const web = yield* WebBrowser.WebBrowser;
      const research = ThreadId.make("research");

      const results = yield* web.search(research, "linux kernel");
      assert.equal(results.snapshot.length, WebBrowser.WEB_SNAPSHOT_CHARS);
      assert.equal(results.nextOffset, WebBrowser.WEB_SNAPSHOT_CHARS);
      const rest = yield* web.browse(research, {
        action: "snapshot",
        offset: WebBrowser.WEB_SNAPSHOT_CHARS,
      });
      assert.equal(rest.page.snapshot.length, 500);
      assert.isUndefined(rest.page.nextOffset);
      yield* web.browse(ThreadId.make("briefing"), { action: "open", url: "https://a.test/" });

      const refused = yield* web.browse(research, { action: "click", ref: "e9" }).pipe(Effect.flip);
      assert.include(refused.message, "Unknown ref: e9");
      const stale = yield* web.browse(research, { action: "click", ref: "e470" }).pipe(Effect.flip);
      assert.include(stale.message, "e470 is gone. Take a snapshot");
      for (const ref of ["e30", "e31"]) {
        const failed = yield* web.browse(research, { action: "click", ref }).pipe(Effect.flip);
        assert.include(failed.message, "The click did not finish");
        assert.notInclude(failed.message, "Internal server error");
      }
      const invalid = yield* web
        .browse(research, { action: "open", url: "file:///etc/passwd" })
        .pipe(Effect.flip);
      assert.include(invalid.message, "http(s) url");

      assert.deepEqual(calls.slice(0, 5), [
        "GET /tabs t3-bot-research ",
        "POST /tabs t3-bot-research ",
        "POST /tabs/tab-1/navigate t3-bot-research @google_search",
        "POST /tabs/tab-1/navigate t3-bot-research https://html.duckduckgo.com/html/?q=linux%20kernel",
        "GET /tabs/tab-1/snapshot t3-bot-research ",
      ]);
      assert.equal(calls.filter((call) => call.startsWith("POST /tabs t3-bot-research")).length, 1);
      assert.include(calls, "POST /tabs t3-bot-briefing ");
      assert.include(calls, "POST /tabs/tab-2/navigate t3-bot-briefing https://a.test/");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a check that a click brings up at the same address stops the bot", () =>
  Effect.gen(function* () {
    let clicked = false;
    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      const reply = (json: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json)));
      if (request.method === "GET" && url.pathname === "/tabs")
        return reply({ tabs: [{ tabId: "tab-1", listItemId: "bot" }] });
      if (url.pathname.endsWith("/click")) clicked = true;
      if (url.pathname.endsWith("/snapshot"))
        return reply({
          url: "https://shop.test/cart",
          snapshot: clicked
            ? "Performing security verification\nVerify you are human by completing the action below."
            : '- button "Checkout" [e4]',
        });
      return reply({ ok: true });
    });
    const layer = WebBrowser.layer.pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        (yield* Path.Path).join(stateDir, "camofox.json"),
        JSON.stringify({ url: "http://camofox.test", accessKey: "key" }),
      );
      const web = yield* WebBrowser.WebBrowser;
      const clock = yield* Clock.Clock;
      const waits: number[] = [];
      const { challenge } = yield* web
        .browse(ThreadId.make("shopper"), { action: "click", ref: "e4" })
        .pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) => Effect.sync(() => void waits.push(Duration.toMillis(duration))),
          }),
        );
      assert.equal(challenge?.vendor, "cloudflare");
      assert.lengthOf(waits, 15);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a click on a Google result opens the address the bot was shown", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const result = (ref: string, goto: string, site: string) => [
      `- link "Result from ${site}" [${ref}]:`,
      `  - /url: https://www.google.com/goto?url=${goto}`,
      `  - cite: https://${site}`,
    ];
    const shown = [
      '- heading "KVarN - Пошук Google"',
      "- navigation:",
      '  - link "Новини" [e3]',
      ...result("e15", "CAESZQ&gsessionid=x", "github.com"),
      ...result("e16", "CAESarxiv", "arxiv.org"),
    ].join("\n");
    const later = [
      '- heading "KVarN - Пошук Google"',
      ...result("e8", "CAESZQ&gsessionid=x", "github.com"),
      ...result("e15", "CAESother", "other.test"),
    ].join("\n");
    let snapshots = 0;
    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, string>)
          : {};
      calls.push(`${request.method} ${url.pathname} ${body.url ?? body.ref ?? ""}`);
      const reply = (json: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json)));
      if (request.method === "GET" && url.pathname === "/tabs")
        return reply({
          tabs: [
            { tabId: "tab-1", listItemId: "bot", url: "https://www.google.com/search?q=KVarN" },
          ],
        });
      if (url.pathname.endsWith("/snapshot"))
        return reply({
          url: "https://www.google.com/search?q=KVarN",
          snapshot: snapshots++ === 0 ? shown : later,
        });
      return reply({ ok: true });
    });
    const layer = WebBrowser.layer.pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        (yield* Path.Path).join(stateDir, "camofox.json"),
        JSON.stringify({ url: "http://camofox.test", accessKey: "key" }),
      );
      const web = yield* WebBrowser.WebBrowser;
      const deep = ThreadId.make("deep");
      const unseen = yield* web.browse(deep, { action: "click", ref: "e15" }).pipe(Effect.flip);
      assert.include(unseen.message, "e15 is gone. Take a snapshot");
      assert.notInclude(calls, "POST /tabs/tab-1/click e15");

      yield* web.browse(deep, { action: "snapshot" });
      yield* web.browse(deep, { action: "click", ref: "e15" });
      assert.include(
        calls,
        "POST /tabs/tab-1/navigate https://www.google.com/goto?url=CAESZQ&gsessionid=x",
      );
      assert.notInclude(calls, "POST /tabs/tab-1/click e15");
      yield* web.browse(deep, { action: "click", ref: "e8" });
      assert.lengthOf(
        calls.filter(
          (call) =>
            call ===
            "POST /tabs/tab-1/navigate https://www.google.com/goto?url=CAESZQ&gsessionid=x",
        ),
        2,
      );
      yield* web.browse(deep, { action: "click", ref: "e3" });
      assert.include(calls, "POST /tabs/tab-1/click e3");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("names a host that does not exist instead of the browser's internal error", () =>
  Effect.gen(function* () {
    const lookup = (code: string | undefined) => (host: string) =>
      code === undefined
        ? Promise.resolve({ host })
        : Promise.reject(Object.assign(new Error(code), { code }));
    assert.equal(
      yield* WebBrowser.missingHost("https://darstar.ua/ua/search?q=3090", lookup("ENOTFOUND")),
      "darstar.ua",
    );
    assert.equal(
      yield* WebBrowser.missingHost("https://www.olx.ua(d)/uk/obyavlenie/x", lookup("ENOTFOUND")),
      "www.olx.ua(d)",
    );
    assert.isUndefined(yield* WebBrowser.missingHost("https://a.test/", lookup("EAI_AGAIN")));
    assert.isUndefined(yield* WebBrowser.missingHost("https://a.test/", lookup(undefined)));
  }),
);

const WALL =
  "Performing security verification\nVerify you are human by completing the action below.";

const openBehindWall = (trawlUrl: string | undefined, scrape: () => Response) =>
  Effect.gen(function* () {
    const scraped: unknown[] = [];
    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      const reply = (response: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response));
      if (url.hostname === "trawl.test") {
        scraped.push(
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
        );
        return reply(scrape());
      }
      if (request.method === "GET" && url.pathname === "/tabs")
        return reply(Response.json({ tabs: [{ tabId: "tab-1", listItemId: "bot" }] }));
      if (url.pathname.endsWith("/snapshot"))
        return reply(Response.json({ url: "https://shop.test/wall", snapshot: WALL }));
      return reply(Response.json({ ok: true }));
    });
    const layer = WebBrowser.layer.pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        (yield* Path.Path).join(stateDir, "camofox.json"),
        JSON.stringify({ url: "http://camofox.test", accessKey: "key", trawlUrl }),
      );
      const clock = yield* Clock.Clock;
      const result = yield* (yield* WebBrowser.WebBrowser)
        .browse(ThreadId.make("shopper"), { action: "open", url: "https://shop.test/item" })
        .pipe(Effect.provideService(Clock.Clock, { ...clock, sleep: () => Effect.void }));
      return { ...result, scraped };
    }).pipe(Effect.provide(layer));
  });

it.effect("an open that stays on a check is read through trawl and says so", () =>
  Effect.gen(function* () {
    const { page, challenge, scraped } = yield* openBehindWall("http://trawl.test:8191", () =>
      Response.json({
        url: "https://shop.test/item",
        statusCode: 200,
        html: "<html><head><title>Item &amp; Co</title><style>p{}</style></head><body><script>x()</script><h1>Widget</h1><p>Price: 5&nbsp;USD</p><p>In stock</p></body></html>",
      }),
    );
    assert.isUndefined(challenge);
    assert.deepEqual(scraped, [{ url: "https://shop.test/item", solveEmbeddedCaptchas: true }]);
    assert.equal(page.url, "https://shop.test/item");
    assert.equal(page.snapshot, "Item & Co\n\nWidget\nPrice: 5 USD\nIn stock");
    assert.include(page.note, "solver");

    // Unclosed markup in a script and after the page made each pass rescan to the end.
    const hostile = yield* openBehindWall("http://trawl.test:8191", () =>
      Response.json({
        url: "https://shop.test/item",
        statusCode: 200,
        html: `<html><head><title>Item</title></head><body><script>${'<!--<title<div class="<svg'.repeat(60_000)}</script><h1>Widget</h1></body></html>${"<".repeat(60_000)}`,
      }),
    );
    assert.isUndefined(hostile.challenge);
    assert.isTrue(hostile.page.snapshot.startsWith("Item\n\nWidget\n<<<"));
  }),
);

it.effect("a check stays a check when trawl is off, fails, or meets it too", () =>
  Effect.gen(function* () {
    const off = yield* openBehindWall(undefined, () => Response.json({}));
    assert.equal(off.challenge?.vendor, "cloudflare");
    assert.lengthOf(off.scraped, 0);

    const down = yield* openBehindWall("http://trawl.test:8191", () =>
      Response.json({ error: "boom" }, { status: 500 }),
    );
    assert.equal(down.challenge?.vendor, "cloudflare");

    const walled = yield* openBehindWall("http://trawl.test:8191", () =>
      Response.json({
        url: "https://shop.test/item",
        statusCode: 200,
        html: `<html><head><title>Just a moment...</title></head><body>${WALL}</body></html>`,
      }),
    );
    assert.equal(walled.challenge?.vendor, "cloudflare");
    assert.isUndefined(walled.page.note);
  }),
);

const openWithCheckbox = (
  wall: boolean,
  solvesAfter: number | undefined,
  renderAfter = 0,
  awsWaf = false,
) =>
  Effect.gen(function* () {
    const clicks: Array<{ readonly x: number; readonly y: number }> = [];
    let probes = 0;
    const solved = () => solvesAfter !== undefined && clicks.length >= solvesAfter;
    const client = HttpClient.make((request) => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              coordinates?: { x: number; y: number };
            })
          : {};
      const reply = (json: unknown) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json)));
      if (request.method === "GET" && url.pathname === "/tabs")
        return reply({ tabs: [{ tabId: "tab-1", listItemId: "bot" }] });
      if (url.pathname.endsWith("/click") && body.coordinates) clicks.push(body.coordinates);
      if (url.pathname.endsWith("/evaluate")) {
        const rendered = ++probes > renderAfter;
        return reply({
          ok: true,
          result: {
            title: awsWaf ? "" : wall && !solved() ? "Трохи зачекайте…" : "Item",
            boxes: awsWaf || !rendered || solved() ? [] : [{ x: 200, y: 113, height: 65 }],
            loading: !rendered,
            awsWaf,
          },
        });
      }
      if (url.pathname.endsWith("/snapshot"))
        return reply({
          url: "https://shop.test/item",
          snapshot:
            awsWaf || (wall && !solved()) ? "- main" : '- heading "Item"\n- button "Buy" [e1]',
        });
      return reply({ ok: true });
    });
    const layer = WebBrowser.layer.pipe(
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(
        (yield* Path.Path).join(stateDir, "camofox.json"),
        JSON.stringify({ url: "http://camofox.test", accessKey: "key" }),
      );
      const clock = yield* Clock.Clock;
      const result = yield* (yield* WebBrowser.WebBrowser)
        .browse(ThreadId.make("shopper"), { action: "open", url: "https://shop.test/item" })
        .pipe(Effect.provideService(Clock.Clock, { ...clock, sleep: () => Effect.void }));
      return { ...result, clicks };
    }).pipe(Effect.provide(layer));
  });

it.effect("clicks a Turnstile checkbox like a person, at most twice", () =>
  Effect.gen(function* () {
    const check = yield* openWithCheckbox(true, 1);
    assert.isUndefined(check.challenge);
    assert.equal(check.page.snapshot, '- heading "Item"\n- button "Buy" [e1]');
    assert.lengthOf(check.clicks, 1);
    const [click] = check.clicks;
    assert.isTrue(
      click !== undefined && click.x >= 216 && click.x <= 226 && Math.abs(click.y - 145.5) <= 4,
      JSON.stringify(click),
    );

    const stuck = yield* openWithCheckbox(true, undefined);
    assert.equal(stuck.challenge?.vendor, "cloudflare");
    assert.lengthOf(stuck.clicks, 2);

    const form = yield* openWithCheckbox(false, undefined);
    assert.isUndefined(form.challenge);
    assert.lengthOf(form.clicks, 2);

    // The widget renders a moment after the page; the browser waits for it.
    const late = yield* openWithCheckbox(false, 1, 2);
    assert.lengthOf(late.clicks, 1);

    const waf = yield* openWithCheckbox(false, undefined, 0, true);
    assert.equal(waf.challenge?.vendor, "aws-waf");
    assert.lengthOf(waf.clicks, 0);
  }),
);

const STORY = "https://news.test/story";
const FIRECRAWL = "http://firecrawl.test:3002";
const ARTICLE = `# Kernel 7.0 released\n\n${"The release brings new drivers. ".repeat(500)}`;
const scraped = (markdown: string, metadata: Record<string, unknown> = {}) =>
  Effect.succeed(
    Response.json({
      success: true,
      data: { markdown, metadata: { url: STORY, statusCode: 200, ...metadata } },
    }),
  );

/** Firecrawl at firecrawl.test when `firecrawlUrl` is set; Camoufox serves the story with one ref. */
const withReader = (
  firecrawlUrl: string | undefined,
  scrape: () => Effect.Effect<Response>,
  tabUrl?: string,
) => {
  const firecrawl: Array<{
    readonly path: string;
    readonly auth: string | undefined;
    readonly body: unknown;
  }> = [];
  const camofox: string[] = [];
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const body: unknown =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : {};
    if (url.hostname === "firecrawl.test") {
      firecrawl.push({ path: url.pathname, auth: request.headers.authorization, body });
      return scrape().pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
    }
    const fields = body as { readonly url?: string; readonly ref?: string };
    camofox.push(`${request.method} ${url.pathname} ${fields.url ?? fields.ref ?? ""}`);
    const reply = (json: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(json)));
    if (request.method === "GET" && url.pathname === "/tabs")
      return reply({ tabs: [{ tabId: "tab-1", listItemId: "bot", url: tabUrl }] });
    if (url.pathname.endsWith("/snapshot"))
      return reply({ url: STORY, snapshot: '- heading "Story"\n- link "Next" [e1]' });
    return reply({ ok: true });
  });
  const layer = WebBrowser.layer.pipe(
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "web-browser-test-" })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(NodeServices.layer),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, WebBrowser.WebBrowser>) =>
    Effect.gen(function* () {
      const { stateDir } = yield* Config.ServerConfig;
      yield* (yield* FileSystem.FileSystem).writeFileString(
        (yield* Path.Path).join(stateDir, "camofox.json"),
        JSON.stringify({
          url: "http://camofox.test",
          accessKey: "key",
          firecrawlUrl,
          firecrawlKey: "fc-key",
        }),
      );
      return yield* effect;
    }).pipe(Effect.provide(layer));
  return { firecrawl, camofox, run };
};

const openStory = (account?: string) =>
  Effect.gen(function* () {
    return yield* (yield* WebBrowser.WebBrowser).browse(ThreadId.make("reader"), {
      action: "open",
      url: STORY,
      ...(account === undefined ? {} : { account }),
    });
  });

it.effect("an open reads a public page through Firecrawl; snapshot then opens it in the tab", () =>
  Effect.gen(function* () {
    const reader = withReader(FIRECRAWL, () => scraped(ARTICLE, { title: ["Kernel 7.0"] }));
    yield* reader.run(
      Effect.gen(function* () {
        const web = yield* WebBrowser.WebBrowser;
        const bot = ThreadId.make("reader");
        const text = `Kernel 7.0\n\n${ARTICLE.trim()}`;
        const opened = yield* openStory();
        assert.deepEqual(reader.firecrawl, [
          {
            path: "/v2/scrape",
            auth: "Bearer fc-key",
            body: { url: STORY, formats: ["markdown"], onlyMainContent: true, maxAge: 0 },
          },
        ]);
        assert.equal(opened.via, "firecrawl");
        assert.deepEqual(opened.page, {
          url: STORY,
          snapshot: text.slice(0, WebBrowser.WEB_SNAPSHOT_CHARS),
          nextOffset: WebBrowser.WEB_SNAPSHOT_CHARS,
          note: WebBrowser.FIRECRAWL_NOTE,
        });
        const rest = yield* web.browse(bot, {
          action: "snapshot",
          offset: WebBrowser.WEB_SNAPSHOT_CHARS,
        });
        assert.equal(rest.page.snapshot, text.slice(WebBrowser.WEB_SNAPSHOT_CHARS));
        assert.isUndefined(rest.page.nextOffset);
        for (const refused of [
          { action: "click", ref: "e1" },
          { action: "type", ref: "e1", text: "kernel" },
        ] as const) {
          const noRefs = yield* web.browse(bot, refused).pipe(Effect.flip);
          assert.include(noRefs.message, "Call snapshot");
        }
        assert.deepEqual(reader.camofox, ["GET /tabs "]);

        const live = yield* web.browse(bot, { action: "snapshot" });
        assert.isUndefined(live.via);
        assert.include(live.page.snapshot, "[e1]");
        yield* web.browse(bot, { action: "click", ref: "e1" });
        assert.includeMembers(reader.camofox, [
          `POST /tabs/tab-1/navigate ${STORY}`,
          "POST /tabs/tab-1/click e1",
        ]);
        assert.lengthOf(reader.firecrawl, 1);

        // An account call runs in the vault's browser; the tab and its refs are current again.
        yield* openStory();
        yield* web.forget(bot);
        yield* web.browse(bot, { action: "click", ref: "e1" });
        assert.lengthOf(
          reader.camofox.filter((call) => call === "POST /tabs/tab-1/click e1"),
          2,
        );
      }),
    );
  }),
);

it.effect(
  "an open goes to Camoufox when Firecrawl fails, is unset, or the call has an account",
  () =>
    Effect.gen(function* () {
      const fallsBack = (
        firecrawlUrl: string | undefined,
        scrape: () => Effect.Effect<Response>,
        { account, tabUrl }: { readonly account?: string; readonly tabUrl?: string } = {},
      ) =>
        Effect.gen(function* () {
          const reader = withReader(firecrawlUrl, scrape, tabUrl);
          const { page, via } = yield* reader.run(openStory(account));
          assert.isUndefined(via);
          assert.include(page.snapshot, "[e1]");
          assert.include(reader.camofox, `POST /tabs/tab-1/navigate ${STORY}`);
          return reader.firecrawl.length;
        });
      const wall = `${WALL}\n${"This page checks your browser. ".repeat(5)}`;
      for (const scrape of [
        () => scraped(wall),
        () => scraped(ARTICLE, { title: "Just a moment..." }),
        () => scraped("Loading"),
        () => scraped("You need to enable JavaScript to run this app. ".repeat(3)),
        () => scraped(ARTICLE, { statusCode: 404 }),
        () => Effect.succeed(Response.json({ success: false, error: "boom" })),
        () => Effect.succeed(Response.json({ error: "boom" }, { status: 500 })),
        () => scraped(ARTICLE, { url: "file:///etc/passwd" }),
      ])
        assert.equal(yield* fallsBack(FIRECRAWL, scrape), 1);

      assert.equal(yield* fallsBack(undefined, () => scraped(ARTICLE)), 0);
      assert.equal(yield* fallsBack(FIRECRAWL, () => scraped(ARTICLE), { account: "olx.ua" }), 0);
      assert.equal(
        yield* fallsBack(FIRECRAWL, () => scraped(ARTICLE), { tabUrl: "https://www.news.test/" }),
        0,
      );

      // A timeout pauses Firecrawl for a minute, so a dead service does not cost every open 30 s.
      const arrived = yield* Deferred.make<void>();
      let scrapes = 0;
      const slow = withReader(FIRECRAWL, () =>
        scrapes++ === 0
          ? Deferred.succeed(arrived, undefined).pipe(Effect.andThen(Effect.never))
          : scraped(ARTICLE),
      );
      const [late, paused, resumed] = yield* slow.run(
        Effect.gen(function* () {
          const open = yield* openStory().pipe(Effect.forkChild);
          yield* Deferred.await(arrived);
          yield* TestClock.adjust("30 seconds");
          const late = yield* Fiber.join(open);
          const paused = yield* openStory();
          yield* TestClock.adjust("60 seconds");
          return [late, paused, yield* openStory()] as const;
        }),
      );
      assert.isUndefined(late.via);
      assert.isUndefined(paused.via);
      assert.equal(resumed.via, "firecrawl");
      assert.equal(scrapes, 2);
    }),
);

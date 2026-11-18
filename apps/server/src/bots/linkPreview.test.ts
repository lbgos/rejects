import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as LinkPreviews from "./LinkPreviews.ts";
import { isPublicAddress, parsePreview, publicLookup } from "./linkPreview.ts";

it("reads Open Graph tags, resolving the image against the page", () => {
  const html = `<html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Proxmox VE 9.2 &amp; kernel 7.0">
    <meta content="Released May 21, 2026." name="description">
    <meta property="og:site_name" content="Proxmox">
    <meta property="og:image" content="/images/pve-9-2.png">
  </head><body>…</body></html>`;
  assert.deepEqual(parsePreview(html, new URL("https://www.proxmox.com/en/news/pve-9-2")), {
    url: "https://www.proxmox.com/en/news/pve-9-2",
    title: "Proxmox VE 9.2 & kernel 7.0",
    description: "Released May 21, 2026.",
    site: "Proxmox",
    image: "https://www.proxmox.com/images/pve-9-2.png",
  });
});

it("falls back to <title> and the host, and drops non-http images", () => {
  const html = `<title>
    Roadmap - Proxmox VE
  </title><meta property="og:image" content="javascript:alert(1)">`;
  assert.deepEqual(parsePreview(html, new URL("https://pve.proxmox.com/wiki/Roadmap")), {
    url: "https://pve.proxmox.com/wiki/Roadmap",
    title: "Roadmap - Proxmox VE",
    description: null,
    site: "pve.proxmox.com",
    image: null,
  });
  assert.isNull(parsePreview("<p>no title</p>", new URL("https://example.com/")));
});

it.each([
  ["93.184.216.34", true],
  ["2606:4700::1111", true],
  ["127.0.0.1", false],
  ["10.0.0.5", false],
  ["172.20.1.1", false],
  ["192.168.1.27", false],
  ["169.254.169.254", false],
  ["100.101.102.103", false],
  ["0.0.0.0", false],
  ["::1", false],
  ["fd7a:115c:a1e0::1", false],
  ["fe80::1", false],
  ["::ffff:192.168.1.1", false],
  ["::ffff:c0a8:101", false],
  ["0:0:0:0:0:ffff:7f00:1", false],
  ["::7f00:1", false],
  ["64:ff9b::7f00:1", false],
  ["2002:c0a8:101::1", false],
  ["::ffff:808:808", true],
  ["not an address", false],
])("%s is public: %s", (address, expected) => {
  assert.equal(isPublicAddress(address), expected);
});

it.effect.each(["http://localhost:9/", "http://[::ffff:7f00:1]:9/", "http://[::ffff:c0a8:101]/"])(
  "reads no preview from %s",
  (url) =>
    Effect.gen(function* () {
      const previews = yield* LinkPreviews.LinkPreviews;
      const error = yield* Effect.flip(previews.preview(url));
      assert.equal(error.message, "Pages on private addresses have no preview.");
    }).pipe(Effect.provide(LinkPreviews.layer)),
);

it("connects only after resolving to public addresses", async () => {
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
    publicLookup("localhost", {}, (cause) => resolve(cause)),
  );
  assert.equal(error?.code, "EPRIVATEADDRESS");
});

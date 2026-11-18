import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";
import type { LinkPreview } from "@t3tools/contracts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const clean = (text: string | undefined, max: number) => {
  const line = text === undefined ? "" : decode(text).replace(/\s+/g, " ").trim();
  return line ? line.slice(0, max) : null;
};

const meta = (html: string, key: string) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
        .exec(tag)
        ?.slice(1)
        .find(Boolean);
    if ((attr("property") ?? attr("name"))?.toLowerCase() === key) return attr("content");
  }
  return undefined;
};

export function parsePreview(html: string, url: URL): LinkPreview | null {
  const title = clean(
    meta(html, "og:title") ?? meta(html, "twitter:title") ?? /<title[^>]*>([^<]*)/i.exec(html)?.[1],
    200,
  );
  if (!title) return null;
  const imageRef = meta(html, "og:image") ?? meta(html, "twitter:image");
  const image = imageRef ? URL.parse(decode(imageRef.trim()), url.href) : null;
  return {
    url: url.href,
    title,
    description: clean(meta(html, "og:description") ?? meta(html, "description"), 300),
    site: clean(meta(html, "og:site_name"), 60) ?? url.hostname,
    image: image && (image.protocol === "https:" || image.protocol === "http:") ? image.href : null,
  };
}

const PRIVATE = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = NodeNet.isIP(address);
  return family !== 0 && !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * `dns.lookup` for a connection that may reach public addresses only. The socket connects to the
 * address checked here, so a host that resolves differently on a second lookup cannot rebind.
 */
export const publicLookup: NodeNet.LookupFunction = (hostname, options, callback) =>
  NodeDns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const first = addresses[0];
    if (!first || !addresses.every(({ address }) => isPublicAddress(address)))
      return callback(
        Object.assign(new Error(`${hostname} resolves to a private address.`), {
          code: "EPRIVATEADDRESS",
        }),
        "",
      );
    if (options.all) return callback(null, addresses);
    callback(null, first.address, first.family);
  });

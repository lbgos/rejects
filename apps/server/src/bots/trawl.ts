export interface TrawlScrape {
  readonly url: string;
  readonly html: string;
  readonly statusCode: number;
}

export const TRAWL_TIMEOUT = "45 seconds";
export const TRAWL_HTML_CHARS = 2_000_000;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string) =>
  text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

// Each pass is linear in the page: on a script holding thousands of unclosed `<!--`, `<title` or
// `<`, plain regexes rescan to the end from each one and block the server for minutes at 2 MB.

const dropComments = (html: string) => {
  let out = "";
  let at = 0;
  for (;;) {
    const start = html.indexOf("<!--", at);
    const end = start < 0 ? -1 : html.indexOf("-->", start + 4);
    if (end < 0) return out + html.slice(at);
    out += `${html.slice(at, start)} `;
    at = end + 3;
  }
};

const RAW_BLOCK = /<(script|style|noscript|template|svg|head)\b/gi;

const dropRawBlocks = (html: string) => {
  let out = "";
  let at = 0;
  // A tag with no closing tag after one opener has none after any later opener either.
  const unclosed = new Set<string>();
  for (const open of html.matchAll(RAW_BLOCK)) {
    const tag = open[1]!.toLowerCase();
    if (open.index < at || unclosed.has(tag)) continue;
    const close = new RegExp(`</${tag}\\s*>`, "gi");
    close.lastIndex = open.index + open[0].length;
    const end = close.exec(html);
    if (end === null) {
      unclosed.add(tag);
      continue;
    }
    out += `${html.slice(at, open.index)} `;
    at = end.index + end[0].length;
  }
  return out + html.slice(at);
};

const replaceTags = (html: string, pattern: RegExp, replacement: string) => {
  const end = html.lastIndexOf(">") + 1;
  return html.slice(0, end).replace(pattern, replacement) + html.slice(end);
};

export const htmlTitle = (html: string) => {
  const open = /<title/i.exec(html);
  const contentAt = open === null ? 0 : html.indexOf(">", open.index) + 1;
  if (contentAt === 0) return "";
  const close = /<\/title>/gi;
  close.lastIndex = contentAt;
  const end = close.exec(html);
  return end === null
    ? ""
    : decodeEntities(html.slice(contentAt, end.index)).replace(/\s+/g, " ").trim();
};

export const htmlToText = (html: string) =>
  decodeEntities(
    replaceTags(
      replaceTags(
        dropRawBlocks(dropComments(html)),
        /<(?:br|\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol))\b[^>]*>/gi,
        "\n",
      ),
      /<[^>]*>/g,
      " ",
    ),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

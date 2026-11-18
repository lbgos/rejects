/**
 * A navigation carrying this query parameter gets a one-shot bounce page with a different
 * Cross-Origin-Opener-Policy. WebKit then switches browsing context groups, which moves the page
 * to a new web process and drops state stuck in the old one, then returns to the clean URL.
 */
const PROCESS_SWAP_PARAM = "t3-process-swap";

export function markProcessSwapUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(PROCESS_SWAP_PARAM, "1");
  return url.href;
}

/** The same-origin path to return to after the bounce, or null when the URL is not marked. */
export function processSwapReturnPath(url: URL): string | null {
  if (!url.searchParams.has(PROCESS_SWAP_PARAM)) return null;
  const clean = new URL(url.href);
  clean.searchParams.delete(PROCESS_SWAP_PARAM);
  // Leading slashes or backslashes would make the path protocol-relative, an open redirect.
  return `/${clean.pathname.replace(/^[/\\]+/, "")}${clean.search}`;
}

/** It records hosts, paths, statuses, error codes and step ids, never query strings, tokens or form values. */

const SIGN_IN_PATH = /onboarding|login|signin|sso|oauth|auth|session|token/i;
const TRACED_TYPES = new Set(["XHR", "Fetch", "Document"]);
const TRACED_KEYS = new Set([
  "code",
  "error",
  "error_code",
  "error_description",
  "message",
  "reason",
  "status",
  "subtask_id",
]);
/** A value shaped like a token or an id is left out, whatever key it is under. */
const OPAQUE = /[A-Za-z0-9_\-+/=%]{32,}/g;

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

export const tracedUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .map((segment) => segment.replace(OPAQUE, "…"))
      .join("/");
    return clip(`${parsed.host}${path}`, 160);
  } catch {
    return clip(url.split(/[?#]/)[0] ?? "", 160);
  }
};

export const tracedText = (text: string) =>
  clip(text.replace(/\?[^\s'"]*/g, "?…").replace(OPAQUE, "…"), 240);

export const traceSummary = (body: string) => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (found.length >= 16 || depth > 6 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        TRACED_KEYS.has(key) &&
        (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
      )
        found.push(`${key}=${tracedText(String(child))}`);
      else walk(child, depth + 1);
    }
  };
  walk(json, 0);
  return found.length === 0 ? null : found.join(" ");
};

export const traceResponse = (type: string, url: string, status: number, mimeType: string) => {
  if (!TRACED_TYPES.has(type)) return null;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const signIn = SIGN_IN_PATH.test(path);
  if (status < 400 && !(signIn && type !== "Document")) return null;
  return {
    line: `${status} ${type} ${tracedUrl(url)}`,
    readBody: /json/i.test(mimeType),
  };
};

export const issueReasons = (details: unknown) => {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/reasons?$|errortype$|violationtype$/i.test(key)) {
        for (const item of Array.isArray(child) ? child : [child])
          if (typeof item === "string") found.add(item);
      } else walk(child, depth + 1);
    }
  };
  walk(details, 0);
  return [...found].join(",");
};

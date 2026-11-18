/** Rules decide first and the classifier only judges what they leave, so hostile text can at most add a notification, never hide a VIP, a DM or a mention. */
import type { AlertReason } from "@t3tools/contracts";

export interface FeedItem {
  readonly id: string;
  readonly kind: "mail" | "dm" | "mention" | "post";
  readonly from: string;
  readonly title: string;
  readonly text: string;
  readonly at: string | null;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly bulk?: boolean | undefined;
}

export type Verdict =
  | { readonly type: "notify"; readonly reason: Exclude<AlertReason, "model"> }
  | { readonly type: "drop" }
  | { readonly type: "classify" };

const DROPPED_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM"];

const vipMatch = (from: string, vip: ReadonlyArray<string>) => {
  const sender = from.toLowerCase();
  return vip.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0) return false;
    if (entry.startsWith("@") && entry.includes("."))
      return new RegExp(`@${escape(entry.slice(1))}(?![\\w.-])`).test(sender);
    if (entry.startsWith("@")) return new RegExp(`(^|[^\\w@])${escape(entry)}(?!\\w)`).test(sender);
    return sender.includes(entry);
  });
};
const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const ruleVerdict = (item: FeedItem, vip: ReadonlyArray<string>): Verdict => {
  if (vipMatch(item.from, vip)) return { type: "notify", reason: "vip" };
  if (item.kind === "dm") return { type: "notify", reason: "dm" };
  if (item.kind === "mention") return { type: "notify", reason: "mention" };
  if (item.kind === "post") return { type: "drop" };
  if (item.bulk === true || item.labels?.some((label) => DROPPED_LABELS.includes(label)))
    return { type: "drop" };
  return { type: "classify" };
};

const TLDS =
  "com|net|org|io|co|me|app|dev|xyz|info|biz|ru|cn|su|top|link|click|ly|gl|to|tk|ml|ga|cf|gq|site|online|shop|store|live|page|cc|ai|gg|so|us|uk|de|fr|ua|eu|in|ws|pw|zip|mov";
const BARE_DOMAIN = new RegExp(
  `(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b(?:[/?#][^\\s]*)?`,
  "gi",
);

export const stripLinks = (text: string) =>
  text
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, "")
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replaceAll(/\b(?:mailto|tel|sms|javascript|data):\S*/gi, "")
    .replaceAll(/\bwww\.\S+/gi, "")
    .replaceAll(BARE_DOMAIN, "")
    .replaceAll(/\s+/g, " ")
    .trim();

const senderName = (from: string) => {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (named?.[1] ?? from).trim();
};

const cap = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export const pushText = (input: {
  readonly from: string;
  readonly title: string;
  readonly why: string;
}) => {
  const from = cap(stripLinks(senderName(input.from)) || "Unknown sender", 40);
  const title = cap(stripLinks(input.title), 80);
  const why = cap(stripLinks(input.why), 80);
  return [from, title, why].filter(Boolean).join(" · ");
};

const ALERT_LINES = 3;

/** One poll's alerts as one notification: a line each for the first few, the rest counted. */
export const alertNotice = (label: string, alerts: ReadonlyArray<Parameters<typeof pushText>[0]>) =>
  [
    ...alerts.slice(0, ALERT_LINES).map((alert) => `${label}: ${pushText(alert)}`),
    ...(alerts.length > ALERT_LINES
      ? [`${label}: ${alerts.length - ALERT_LINES} more important items`]
      : []),
  ].join("\n");

export const ruleWhy = (reason: Exclude<AlertReason, "model">, kind: FeedItem["kind"]) =>
  reason === "vip"
    ? "VIP sender"
    : reason === "dm"
      ? "direct message"
      : kind === "mention"
        ? "mentioned you"
        : "";

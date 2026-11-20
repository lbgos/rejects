// @effect-diagnostics nodeBuiltinImport:off - reads the saved fixture pages beside this test.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  blockedStop,
  CHALLENGE_POLLS,
  type ChallengeVendor,
  challengeStop,
  classifyChallenge,
  type PageSignals,
  waitOutChallenge,
} from "./challenge.ts";

const FIXTURES = NodePath.join(import.meta.dirname, "challengeFixtures");

const fixture = (file: string): PageSignals => {
  const html = NodeFS.readFileSync(NodePath.join(FIXTURES, file), "utf8");
  const decode = (text: string) =>
    text
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, "&")
      .replace(/&bull;/g, "•");
  const rendered = html
    .replace(/<(script|style|noscript|iframe|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return {
    url: "https://shop.example/",
    title: decode(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim(),
    text: decode(rendered).replace(/\s+/g, " ").trim(),
    html,
  };
};

it.each<{ file: string; vendor: ChallengeVendor | null }>([
  { file: "cloudflare-interstitial.html", vendor: "cloudflare" },
  { file: "cloudflare-managed.html", vendor: "cloudflare" },
  { file: "cloudflare-blocked.html", vendor: "cloudflare" },
  { file: "datadome.html", vendor: "datadome" },
  { file: "perimeterx.html", vendor: "perimeterx" },
  { file: "akamai.html", vendor: "akamai" },
  { file: "aws-waf.html", vendor: "aws-waf" },
  { file: "imperva.html", vendor: "imperva" },
  { file: "recaptcha.html", vendor: "recaptcha" },
  { file: "hcaptcha.html", vendor: "hcaptcha" },
  { file: "forbidden.html", vendor: "blocked" },
  { file: "cloudfront-blocked.html", vendor: "blocked" },
  { file: "ok-login-invisible-recaptcha.html", vendor: null },
  { file: "ok-cloudflare-protected-shop.html", vendor: null },
  { file: "ok-datadome-tags.html", vendor: null },
  { file: "ok-article-access-denied.html", vendor: null },
])("$file is $vendor", ({ file, vendor }) => {
  assert.equal(classifyChallenge(fixture(file))?.vendor ?? null, vendor);
});

it("reads a check from a text-only snapshot", () => {
  const snapshot = {
    url: "https://shop.example/",
    title: "",
    text: '- heading "shop.example" [level=1]\n- paragraph: Verify you are human by completing the action below.',
  };
  assert.equal(classifyChallenge(snapshot)?.vendor, "cloudflare");
  const ukrainian = {
    ...snapshot,
    text: '- main:\n  - heading "shop.example" [level=1]\n  - heading "Триває перевірка безпеки" [level=2]',
  };
  assert.equal(classifyChallenge(ukrainian)?.vendor, "cloudflare");
  // Straight after a navigation the snapshot can be empty; the title already names the check.
  const loading = { url: "https://shop.example/", title: "Трохи зачекайте…", text: "- main" };
  assert.equal(classifyChallenge(loading)?.vendor, "cloudflare");
  // AWS WAF's script check shows no text; only the page's own gokuProps names it.
  const script = { url: "https://shop.example/", title: "", text: "- main", awsWaf: true };
  assert.equal(classifyChallenge(script)?.vendor, "aws-waf");
  assert.isUndefined(classifyChallenge({ ...script, awsWaf: false }));
  const article = {
    url: "https://films.example/",
    title: "Forbidden (2024)",
    text: "Plot. ".repeat(400),
  };
  assert.isUndefined(classifyChallenge(article));
});

it("waits for a check to pass by itself, then gives up after the last poll", async () => {
  const check = fixture("cloudflare-interstitial.html");
  const shop = fixture("ok-cloudflare-protected-shop.html");
  const sleeps: Array<number> = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  let probes = 0;
  const passes = await waitOutChallenge(async () => (++probes <= 3 ? check : shop), sleep);
  assert.equal(passes, undefined);
  assert.equal(probes, 4);

  probes = 0;
  sleeps.length = 0;
  const stays = await waitOutChallenge(async () => {
    probes++;
    return check;
  }, sleep);
  assert.equal(stays?.label, "Cloudflare check");
  assert.equal(probes, CHALLENGE_POLLS + 1);
  assert.equal(
    sleeps.reduce((sum, ms) => sum + ms, 0),
    15_000,
  );

  probes = 0;
  const ordinary = await waitOutChallenge(async () => {
    probes++;
    return shop;
  }, sleep);
  assert.equal(ordinary, undefined);
  assert.equal(probes, 1);
});

it("a stop hands the user the page only when the user was asked; otherwise it names other routes", () => {
  assert.match(challengeStop("AWS WAF check", "huggingface.co", true), /End your turn now/);
  for (const stop of [
    challengeStop("AWS WAF check", "huggingface.co", false),
    blockedStop("olx.ua", "computer"),
    blockedStop("olx.ua", "account"),
  ]) {
    assert.notMatch(stop, /End your turn/);
    assert.match(stop, /needs this site itself[\s\S]*web_search[\s\S]*raw-file/);
  }
  const reader = challengeStop("AWS WAF check", "huggingface.co", false, "web_read");
  assert.include(reader, "read with web_read");
  assert.notInclude(reader, "computer_shell");
});

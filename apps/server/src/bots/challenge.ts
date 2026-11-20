/**
 * Bots never solve human checks. The web browser clicks a Turnstile checkbox at most twice; a check that still does not pass goes to the user.
 * Only pages a navigation brought are checked, so a solved widget stays.
 */

export interface PageSignals {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly html?: string | undefined;
  /** An inline script defines `gokuProps`, as AWS WAF's own check pages do while they show no text. */
  readonly awsWaf?: boolean | undefined;
}

export type ChallengeVendor =
  | "cloudflare"
  | "datadome"
  | "perimeterx"
  | "akamai"
  | "aws-waf"
  | "imperva"
  | "recaptcha"
  | "hcaptcha"
  | "blocked";

export interface Challenge {
  readonly vendor: ChallengeVendor;
  readonly label: string;
}

const LABELS: Record<ChallengeVendor, string> = {
  cloudflare: "Cloudflare check",
  datadome: "DataDome check",
  perimeterx: "PerimeterX check",
  akamai: "Akamai check",
  "aws-waf": "AWS WAF check",
  imperva: "Imperva check",
  recaptcha: "reCAPTCHA",
  hcaptcha: "hCaptcha",
  blocked: "access denied page",
};

/** A block page is short; an article that mentions "access denied" is not. */
const BLOCK_PAGE_CHARS = 1500;

const RULES: ReadonlyArray<{
  readonly vendor: ChallengeVendor;
  readonly html?: RegExp;
  readonly title?: RegExp;
  readonly text?: RegExp;
}> = [
  {
    vendor: "cloudflare",
    // Full-page checks only. `/cdn-cgi/challenge-platform/scripts/jsd/` runs on ordinary pages,
    // and a Turnstile widget in a form often passes by itself yet stays on the page.
    html: /cf_chl_opt|id="challenge-(?:form|running|stage|error-text|success-text)"|cf-browser-verification|<title>Attention Required! \| Cloudflare<\/title>/i,
    title: /^(?:just a moment|attention required! \| cloudflare|один момент|(?:трохи )?зачекайте)/i,
    text: /verify(?:ing)? you are (?:a )?human|checking if the site connection is secure|performing security verification|sorry, you have been blocked[\s\S]{0,400}cloudflare|триває перевірка безпеки|підтвердьте, що ви людина|выполняется проверка безопасности|подтвердите, что вы человек/i,
  },
  { vendor: "datadome", html: /(?:geo|ct|interstitial)\.captcha-delivery\.com/i },
  {
    vendor: "perimeterx",
    html: /id="px-captcha"|captcha\.px-cdn\.net|window\._pxCaptcha|_pxAppId[\s\S]{0,2000}px-captcha/i,
    title: /^access to this page has been denied/i,
    text: /press (?:&|and) hold/i,
  },
  {
    vendor: "akamai",
    html: /errors\.edgesuite\.net|\/_sec\/cp_challenge\/|id="sec-if-cpt-container"/i,
    text: /you don't have permission to access[\s\S]{0,300}reference\s*#\d/i,
  },
  {
    vendor: "aws-waf",
    html: /window\.gokuProps|captcha\.awswaf\.com|token\.awswaf\.com\/[^"']{0,2000}\/challenge\.js[\s\S]{0,2000}gokuProps/i,
    text: /let['’]s confirm you are human/i,
  },
  {
    vendor: "imperva",
    html: /_Incapsula_Resource|incapsula incident id/i,
    text: /request unsuccessful\. incapsula incident id/i,
  },
];

/**
 * A reCAPTCHA or hCaptcha widget that needs a click; invisible ones pass on their own. Linear in
 * the page: URL runs are bounded and each `<div` tag is read once, so a hostile page cannot stall it.
 */
const visibleWidget = (html: string): ChallengeVendor | undefined => {
  if (
    /google\.com\/recaptcha\/(?:api2|enterprise)\/anchor\?[^"']{0,2000}size=(?:normal|compact)/i.test(
      html,
    )
  )
    return "recaptcha";
  if (/hcaptcha\.com\/captcha\/v1\/[^"']{0,2000}#frame=checkbox(?!-invisible)/i.test(html))
    return "hcaptcha";
  // Up to the last `>`, every `<div` tag ends, so no match attempt scans to the end of the page.
  const classes = (html.slice(0, html.lastIndexOf(">") + 1).match(/<div[^>]*>/gi) ?? [])
    .filter((tag) => !/data-size="invisible"/i.test(tag))
    .flatMap((tag) =>
      [...tag.slice(0, tag.lastIndexOf('"') + 1).matchAll(/class="([^"]*)"/gi)].map(
        ([, value]) => value!,
      ),
    );
  if (classes.some((value) => /\bg-recaptcha\b/i.test(value))) return "recaptcha";
  if (classes.some((value) => /\bh-captcha\b/i.test(value))) return "hcaptcha";
  return undefined;
};

const BLOCKED_TITLE =
  /^(?:access denied|403 forbidden|forbidden|request blocked|you have been blocked|sorry, you have been blocked|blocked|доступ (?:запрещ[её]н|заборонено))\b/i;
const BLOCKED_TEXT =
  /\b(?:access denied|you don't have permission to access|request (?:was )?blocked|you have been blocked|403 forbidden)\b|доступ (?:запрещ[её]н|заборонено)/i;

export const classifyChallenge = (page: PageSignals): Challenge | undefined => {
  const html = page.html ?? "";
  const title = page.title.trim();
  const text = page.text.trim();
  const found = (vendor: ChallengeVendor): Challenge => ({ vendor, label: LABELS[vendor] });
  if (page.awsWaf) return found("aws-waf");
  for (const rule of RULES)
    if (
      (html && rule.html?.test(html)) ||
      (title && rule.title?.test(title)) ||
      (text && rule.text?.test(text.slice(0, 4000)))
    )
      return found(rule.vendor);
  const widget = html ? visibleWidget(html) : undefined;
  if (widget) return found(widget);
  // A hard block page has no form to fill; a login page that says "access denied" does.
  if (/<(?:form|input)\b/i.test(html)) return undefined;
  if (text.length <= BLOCK_PAGE_CHARS && (BLOCKED_TITLE.test(title) || BLOCKED_TEXT.test(text)))
    return found("blocked");
  return undefined;
};

export const CHALLENGE_PROBE = `(() => ({
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText.slice(0, 4000) : "",
  html: document.documentElement ? document.documentElement.outerHTML.slice(0, 400000) : "",
}))()`;

/** Polls while a check shows: 15 polls a second apart, the time a browser check takes to pass. */
export const CHALLENGE_POLLS = 15;
export const CHALLENGE_POLL_MS = 1000;

export const waitOutChallenge = async (
  probe: () => Promise<PageSignals>,
  sleep: (ms: number) => Promise<void>,
): Promise<Challenge | undefined> => {
  let challenge = classifyChallenge(await probe());
  for (let poll = 0; challenge && poll < CHALLENGE_POLLS; poll++) {
    await sleep(CHALLENGE_POLL_MS);
    const page = await probe().catch(() => undefined);
    // A page mid-navigation cannot answer; it keeps the last verdict for this poll.
    if (page) challenge = classifyChallenge(page);
  }
  return challenge;
};

/**
 * Other routes to what a blocked page held. The block is on this site's pages for this browser: a
 * search, another source, or an API or raw-file URL the site offers for programs are not the page.
 */
const otherRoutes = (fetcher: Fetcher) =>
  `web_search for the same question, other sources (the maker's site, arXiv, Semantic Scholar, news, other shops), or a public API or raw-file URL the site offers for programs, ${fetcher === "web_read" ? "read with web_read" : "fetched with computer_shell (a Hugging Face model: huggingface.co/api/models/<id> and huggingface.co/<id>/raw/main/README.md)"}`;
/** The tool that fetches another route: a standalone reader has web_read and no shell. */
type Fetcher = "computer_shell" | "web_read";

/** A request only this site can serve has no other route. */
const SITE_ONLY =
  "the request needs this site itself (signing in, a form, the user's account or messages)";

const NO_WORKAROUND =
  "Never try to solve, skip or get around it: do not retry, reload or snapshot this page, or fetch its pages with another browser, curl or other headers.";

export const challengeStop = (
  label: string,
  host: string,
  handedOff: boolean,
  fetcher: Fetcher = "computer_shell",
) =>
  `Stopped: ${host} shows a ${label} that needs a person. ${NO_WORKAROUND} ${
    handedOff
      ? "The user got a push to pass it on their phone, and you are woken when they are done. End your turn now with one line telling the user the page needs them."
      : `When ${SITE_ONLY}, tell the user in one line that the page needs them. Otherwise finish the user's request without it first: ${otherRoutes(fetcher)}. Only when none of that gets the answer, tell the user in one line that the page needs them and what you tried.`
  }`;

export const blockedStop = (host: string, browser: "computer" | "account") =>
  `Stopped: ${host} blocks this browser with an access denied page that no person can pass. ${
    browser === "computer"
      ? "Use web_browse for this site instead of computer_browser or computer_shell."
      : "Do not retry this page or look for a way around it."
  } If that fails too and ${SITE_ONLY}, tell the user in one line that the site blocks the bot. Otherwise finish the user's request another way first: ${otherRoutes("computer_shell")}. Only when none of that gets the answer, tell the user in one line that the site blocks the bot.`;

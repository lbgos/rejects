import { assert, it } from "@effect/vitest";
import { issueReasons, traceResponse, traceSummary, tracedText, tracedUrl } from "./sheetTrace.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd";

it("a sign-in answer is traced by its codes and steps, never its tokens", () => {
  const summary = traceSummary(
    JSON.stringify({
      flow_token: TOKEN,
      status: "success",
      subtasks: [
        { subtask_id: "LoginEnterPassword", open_link: { url: `https://x.com/?t=${TOKEN}` } },
      ],
      errors: [{ code: 399, message: `Could not log you in now. ref ${TOKEN}` }],
    }),
  );
  assert.strictEqual(
    summary,
    "status=success subtask_id=LoginEnterPassword code=399 message=Could not log you in now. ref …",
  );
  assert.isNull(traceSummary(JSON.stringify({ access_token: TOKEN })));
  assert.isNull(traceSummary("<html>"));
});

it("addresses and browser messages lose their query strings and opaque values", () => {
  assert.strictEqual(
    tracedUrl(`https://accounts.google.com/o/oauth2/${TOKEN}/auth?as=${TOKEN}#frag`),
    "accounts.google.com/o/oauth2/…/auth",
  );
  assert.strictEqual(
    tracedText(`Blocked https://x.com/i/sso?code=${TOKEN} from ${TOKEN}`),
    "Blocked https://x.com/i/sso?… from …",
  );
});

it.each([
  ["XHR", "https://api.x.com/1.1/onboarding/task.json", 200, "application/json", true],
  ["Fetch", "https://api.x.com/graphql/x/Home", 403, "application/json", true],
  ["Document", "https://x.com/i/flow/login", 200, "text/html", null],
  ["Document", "https://x.com/i/flow/login", 500, "text/html", false],
  ["XHR", "https://api.x.com/1.1/flow/viewer.json", 200, "application/json", null],
  ["Image", "https://x.com/login.png", 404, "image/png", null],
] as const)("%s %s %s: traced %s", (type, url, status, mime, readBody) => {
  assert.strictEqual(traceResponse(type, url, status, mime)?.readBody ?? null, readBody);
});

it("a DevTools issue is traced by its reasons", () => {
  assert.strictEqual(
    issueReasons({
      cookieIssueDetails: {
        cookieExclusionReasons: ["ExcludeThirdPartyPhaseout"],
        cookieWarningReasons: [],
        operation: "ReadCookie",
      },
    }),
    "ExcludeThirdPartyPhaseout",
  );
  assert.strictEqual(
    issueReasons({
      federatedAuthRequestIssueDetails: { federatedAuthRequestIssueReason: "NotSignedInWithIdp" },
    }),
    "NotSignedInWithIdp",
  );
});

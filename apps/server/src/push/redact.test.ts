import { describe, expect, it } from "vite-plus/test";
import { redact } from "./redact.ts";

describe("push redaction", () => {
  it.each([
    "sk-proj-" + "a".repeat(40),
    "sk-ant-" + "a".repeat(40),
    "ghp_" + "a".repeat(36),
    "github_pat_" + "a".repeat(40),
    "xoxb-1234567890-abcdefghijk",
    "xapp-1234567890-abcdefghijk",
    "AKIA" + "A".repeat(16),
    "AIza" + "a".repeat(35),
    "npm_" + "a".repeat(36),
    "glpat-" + "a".repeat(20),
    "sk_live_" + "a".repeat(24),
    "whsec_" + "a".repeat(24),
    "eyJ" + "a".repeat(20) + ".payload.signature",
    '"api_key": "test-key-value"',
    "access_token=test-token-value",
    "Bearer test-access-token",
    "https://hooks.slack.com/services/FAKE/TEST/key",
    "https://automation.example.test/webhook/synthetic-key",
    "https://hooks.zapier.com/hooks/catch/123/synthetic-key",
    "https://discord.com/api/webhooks/123/test-token",
    "https://canary.discordapp.com/api/webhooks/123/test-token",
    "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key",
  ])("scrubs secret form %s", (secret) => {
    expect(redact(`before ${secret} after`, "/home/test")).not.toContain(secret);
    expect(redact(secret, "/home/test").replaceAll('"', "")).toBe("[redacted]");
  });
  it("shortens every home path and preserves ordinary text", () => {
    expect(redact("Review /home/test/project and /home/test/notes", "/home/test")).toBe(
      "Review ~/project and ~/notes",
    );
    expect(redact("Thread failed, HTTP 429; retry at 12:00.", "/home/test")).toBe(
      "Thread failed, HTTP 429; retry at 12:00.",
    );
  });
});

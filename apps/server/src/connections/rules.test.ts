import { assert, describe, it } from "@effect/vitest";

import { alertNotice, type FeedItem, pushText, ruleVerdict, stripLinks } from "./rules.ts";

const item = (overrides: Partial<FeedItem>): FeedItem => ({
  id: "1",
  kind: "mail",
  from: "Someone <someone@example.org>",
  title: "Hello",
  text: "",
  at: null,
  ...overrides,
});

describe("ruleVerdict", () => {
  const vip = ["dana@acme.com", "@boss.io", "@theo"];
  it.each([
    ["a VIP address", item({ from: "Dana Ruiz <dana@acme.com>" }), "vip"],
    ["a VIP domain", item({ from: "ops@boss.io" }), "vip"],
    ["a VIP handle", item({ kind: "post", from: "Theo (@theo)" }), "vip"],
    ["a VIP even when bulk", item({ from: "dana@acme.com", bulk: true }), "vip"],
    ["a DM", item({ kind: "dm", from: "@stranger" }), "dm"],
    ["a mention", item({ kind: "mention", from: "@stranger" }), "mention"],
  ] as const)("notifies on %s", (_, input, reason) => {
    assert.deepStrictEqual(ruleVerdict(input, vip), { type: "notify", reason });
  });

  it.each([
    ["a timeline post", item({ kind: "post", from: "@theo2" })],
    ["a lookalike domain", item({ from: "x@boss.io.evil.com", bulk: true })],
    ["bulk mail", item({ bulk: true })],
    ["promotions", item({ labels: ["INBOX", "CATEGORY_PROMOTIONS"] })],
  ] as const)("drops %s", (_, input) => {
    assert.deepStrictEqual(ruleVerdict(input, vip), { type: "drop" });
  });

  it("leaves other mail to the classifier", () => {
    assert.deepStrictEqual(ruleVerdict(item({ labels: ["INBOX"] }), vip), { type: "classify" });
  });
});

describe("stripLinks", () => {
  it.each([
    ["Pay at https://evil.example/pay now", "Pay at now"],
    ["[Open invoice](https://evil.example/x) today", "Open invoice today"],
    ["see <https://evil.example> ok", "see ok"],
    ["go to www.evil.example/path", "go to"],
    ["visit evil-site.top/login fast", "visit fast"],
    ["call tel:+15551234 or mailto:a@b.co", "call or"],
    ["javascript:alert(1) data:text/html,x", ""],
    ["Mail dana@acme.com about v2.0", "Mail dana@acme.com about v2.0"],
  ])("%s", (input, expected) => {
    assert.strictEqual(stripLinks(input), expected);
  });
});

describe("pushText", () => {
  it("names the sender, keeps it short and carries no link", () => {
    const text = pushText({
      from: "Dana Ruiz <dana@acme.com>",
      title: "Renewal https://acme.example/r",
      why: "asks if renewal covers new seats, see bit.ly/x",
    });
    assert.strictEqual(text, "Dana Ruiz · Renewal · asks if renewal covers new seats, see");
    assert.notMatch(text, /https?:|bit\.ly|acme\.example/);
    const long = pushText({ from: "a".repeat(100), title: "t".repeat(200), why: "w".repeat(200) });
    assert.isAtMost(long.length, 40 + 80 + 80 + 6);
  });

  it("falls back when the sender is only a link", () => {
    assert.strictEqual(
      pushText({ from: "https://evil.example", title: "Hi", why: "" }),
      "Unknown sender · Hi",
    );
  });
});

describe("alertNotice", () => {
  it("puts one poll's alerts in one notice, a line each, and counts the rest", () => {
    const alert = (n: number) => ({
      from: `Sender ${n} <s${n}@acme.com>`,
      title: `Topic ${n}`,
      why: "",
    });
    assert.strictEqual(
      alertNotice("Mail", [1, 2, 3, 4, 5].map(alert)),
      "Mail: Sender 1 · Topic 1\nMail: Sender 2 · Topic 2\nMail: Sender 3 · Topic 3\nMail: 2 more important items",
    );
  });
});

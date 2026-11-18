import { describe, expect, it } from "@effect/vitest";

import { onSite, siteOf } from "./connections.ts";

describe("account sites", () => {
  it.each([
    ["olx.ua", "olx.ua"],
    ["https://www.olx.ua/uk/account/", "olx.ua"],
    ["Forum.Example.org", "forum.example.org"],
    ["http://192.168.1.27:8099/login", "192.168.1.27:8099"],
    ["localhost", undefined],
    ["javascript:alert(1)", undefined],
    ["file:///etc/passwd", undefined],
    ["", undefined],
  ])("siteOf(%s) is %s", (input, site) => {
    expect(siteOf(input)).toBe(site);
  });

  it.each([
    ["https://olx.ua/", "olx.ua", true],
    ["https://m.olx.ua/uk/", "olx.ua", true],
    ["http://olx.ua/", "olx.ua", true],
    ["https://olx.ua.evil.example/", "olx.ua", false],
    ["https://evilolx.ua/", "olx.ua", false],
    ["https://olx.ua:8443/", "olx.ua", false],
    ["https://accounts.google.com/", "olx.ua", false],
    ["data:text/html,hi", "olx.ua", false],
    ["http://192.168.1.27:8099/inbox", "192.168.1.27:8099", true],
    ["http://192.168.1.27:3774/", "192.168.1.27:8099", false],
  ])("onSite(%s, %s) is %s", (url, site, expected) => {
    expect(onSite(url, site)).toBe(expected);
  });
});

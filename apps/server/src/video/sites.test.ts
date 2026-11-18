import { expect, it } from "@effect/vitest";
import { videoLink } from "./sites.ts";

it("names each allowed site's video, without its query, with that site's extractors only", () => {
  expect(videoLink("https://www.instagram.com/reel/DAbc_12-x/?igsh=tracking")).toEqual({
    site: "instagram",
    url: "https://www.instagram.com/reel/DAbc_12-x/",
    extractors: ["instagram"],
  });
  expect(videoLink("https://youtu.be/mTd3tBpfYmw?si=abc")).toMatchObject({
    site: "youtube",
    url: "https://www.youtube.com/watch?v=mTd3tBpfYmw",
    youtubeId: "mTd3tBpfYmw",
  });
  for (const [url, site] of [
    ["https://www.instagram.com/someone/reel/DAbc12x/", "instagram"],
    ["https://www.tiktok.com/@some.one/video/7301234567890123456", "tiktok"],
    ["https://vm.tiktok.com/ZMabc123/", "tiktok"],
    ["https://x.com/someone/status/1850000000000000000", "x"],
    ["https://twitter.com/i/web/status/1850000000000000000", "x"],
    ["https://vimeo.com/76979871", "vimeo"],
    ["https://player.vimeo.com/video/76979871", "vimeo"],
  ] as const)
    expect(videoLink(url)?.site).toBe(site);
});

it("refuses LAN addresses, other schemes, unlisted hosts and non-video paths", () => {
  for (const url of [
    "http://192.168.1.20:8080/video.mp4",
    "http://127.0.0.1/reel/x",
    "file:///var/lib/rejects/userdata/bots.json",
    "https://example.com/video.mp4",
    "https://instagram.com.evil.example/reel/abc/",
    "https://www.instagram.com/someone/",
    "https://www.instagram.com:8443/reel/abc/",
    "https://user@x.com/someone/status/1",
    "https://vimeo.com/channels/staffpicks",
    "not a link",
  ])
    expect(videoLink(url)).toBeUndefined();
});

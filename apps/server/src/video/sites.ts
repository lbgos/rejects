import { videoIdFromUrl } from "./captions.ts";

export type VideoSite = "youtube" | "instagram" | "tiktok" | "x" | "vimeo";

export interface VideoLink {
  readonly site: VideoSite;
  /** The link without its query or fragment, so tracking parameters neither reach yt-dlp nor split the cache. */
  readonly url: string;
  /** yt-dlp's `--use-extractors` list: its generic extractor fetches any URL, so it is never on. */
  readonly extractors: ReadonlyArray<string>;
  readonly youtubeId?: string | undefined;
}

const SITES: ReadonlyArray<{
  readonly site: Exclude<VideoSite, "youtube">;
  readonly hosts: ReadonlyArray<string>;
  readonly path: RegExp;
  readonly extractors: ReadonlyArray<string>;
}> = [
  {
    site: "instagram",
    hosts: ["instagram.com", "www.instagram.com"],
    path: /^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/[\w-]+\/?$/,
    extractors: ["instagram"],
  },
  {
    site: "tiktok",
    hosts: ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
    path: /^\/@[\w.-]+\/video\/\d+\/?$/,
    extractors: ["tiktok"],
  },
  {
    site: "tiktok",
    hosts: ["vm.tiktok.com", "vt.tiktok.com"],
    path: /^\/\w+\/?$/,
    // A short link redirects to the full one, which the TikTok extractor reads.
    extractors: ["vm.tiktok", "tiktok"],
  },
  {
    site: "x",
    hosts: [
      "x.com",
      "www.x.com",
      "mobile.x.com",
      "twitter.com",
      "www.twitter.com",
      "mobile.twitter.com",
    ],
    path: /^\/(?:i\/web|[\w]+)\/status\/\d+(?:\/video\/\d+)?\/?$/,
    extractors: ["twitter"],
  },
  {
    site: "vimeo",
    hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    path: /^\/(?:video\/|channels\/[\w-]+\/)?\d+(?:\/[\da-f]+)?\/?$/,
    extractors: ["vimeo"],
  },
];

/** The video a chat link names on an allowed site, or undefined: other hosts, ports, credentials and schemes are refused before any request. */
export function videoLink(input: string): VideoLink | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port)
    return undefined;
  try {
    const id = videoIdFromUrl(url.href);
    return {
      site: "youtube",
      url: `https://www.youtube.com/watch?v=${id}`,
      extractors: ["youtube"],
      youtubeId: id,
    };
  } catch {
    // Not a YouTube video; the other sites follow.
  }
  const entry = SITES.find(
    (site) => site.hosts.includes(url.hostname) && site.path.test(url.pathname),
  );
  return entry === undefined
    ? undefined
    : {
        site: entry.site,
        url: `https://${url.hostname}${url.pathname}`,
        extractors: entry.extractors,
      };
}

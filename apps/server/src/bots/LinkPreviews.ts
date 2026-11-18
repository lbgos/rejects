import * as NodeDnsPromises from "node:dns/promises";
import type { LinkPreview } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { setWithinBudget } from "@t3tools/shared/sizedCache";
import { isPublicAddress, parsePreview, publicLookup } from "./linkPreview.ts";

const MAX_REDIRECTS = 3;
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 1024 * 1024;
const CACHE_MS = 60 * 60 * 1000;
/** Previews carry their image inline, so the cache is bounded by size, not count. */
const CACHE_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
/** For headers and the whole body, so a server that trickles bytes cannot hold a read open. */
const READ_TIMEOUT = "10 seconds";

export class LinkPreviewError extends Schema.TaggedError<LinkPreviewError>()("LinkPreviewError", {
  message: Schema.String,
}) {}
const fail = (message: string) => Effect.fail(new LinkPreviewError({ message }));

const readCapped = (response: HttpClientResponse.HttpClientResponse, max: number) => {
  let seen = 0;
  return response.stream.pipe(
    Stream.takeWhile((chunk) => {
      const keep = seen < max;
      seen += chunk.byteLength;
      return keep;
    }),
    Stream.mkUint8Array,
    Effect.map((bytes) => bytes.subarray(0, max)),
  );
};

export class LinkPreviews extends Context.Service<
  LinkPreviews,
  { readonly preview: (url: string) => Effect.Effect<LinkPreview, LinkPreviewError> }
>()("t3/bots/LinkPreviews") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  /** GETs `url` from the public internet only: each hop's host must resolve to public addresses. */
  const publicGet = Effect.fn("LinkPreviews.publicGet")(function* (start: URL, accept: string) {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return yield* fail("Only web pages have previews.");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = yield* Effect.tryPromise({
        try: () => NodeDnsPromises.lookup(host, { all: true }),
        catch: () => new LinkPreviewError({ message: `${host} does not resolve.` }),
      });
      if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address)))
        return yield* fail("Pages on private addresses have no preview.");
      const response = yield* client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({
              accept,
              "user-agent": "Mozilla/5.0 (compatible; rejects-link-preview)",
            }),
          ),
        )
        .pipe(Effect.mapError(() => new LinkPreviewError({ message: "The page did not answer." })));
      const location = response.headers["location"];
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        return yield* fail(`The page answered ${response.status}.`);
      return { response, url };
    }
    return yield* fail("The page redirects too often.");
  });

  const readPage = Effect.fn("LinkPreviews.readPage")(
    function* (start: URL) {
      const { response, url } = yield* publicGet(start, "text/html");
      if (!response.headers["content-type"]?.includes("html"))
        return yield* fail("The link is not a web page.");
      const html = yield* readCapped(response, PAGE_BYTES).pipe(
        Effect.mapError(() => new LinkPreviewError({ message: "The page did not load." })),
      );
      return { html, url };
    },
    Effect.timeoutOrElse({
      duration: READ_TIMEOUT,
      orElse: () => fail("The page did not answer."),
    }),
  );

  const read = Effect.fn("LinkPreviews.read")(function* (href: string) {
    const start = URL.parse(href);
    if (!start) return yield* fail("Not a link.");
    const { html, url } = yield* readPage(start);
    const preview = parsePreview(new TextDecoder().decode(html), url);
    if (!preview) return yield* fail("The page has no title.");
    if (!preview.image) return preview;
    // Inlined so the client never contacts the site; a missing image only drops the picture.
    const image = yield* publicGet(new URL(preview.image), "image/*").pipe(
      Effect.flatMap(({ response: picture }) => {
        const type = picture.headers["content-type"] ?? "";
        return IMAGE_TYPES.test(type)
          ? readCapped(picture, IMAGE_BYTES + 1).pipe(
              Effect.map((bytes) =>
                bytes.byteLength > IMAGE_BYTES
                  ? null
                  : `data:${type};base64,${Buffer.from(bytes).toString("base64")}`,
              ),
            )
          : Effect.succeed(null);
      }),
      Effect.timeoutOrElse({ duration: READ_TIMEOUT, orElse: () => Effect.succeed(null) }),
      Effect.orElseSucceed(() => null),
    );
    return { ...preview, image };
  });

  // Successes only, so a retry after a failure reads the page again.
  const cache = new Map<string, { readonly at: number; readonly preview: LinkPreview }>();
  return LinkPreviews.of({
    preview: Effect.fn("LinkPreviews.preview")(function* (url) {
      const now = yield* Clock.currentTimeMillis;
      const hit = cache.get(url);
      if (hit && now - hit.at < CACHE_MS) return hit.preview;
      const preview = yield* read(url);
      setWithinBudget(
        cache,
        url,
        { at: now, preview },
        (entry) => 1024 + (entry.preview.image?.length ?? 0),
        CACHE_BYTES,
      );
      return preview;
    }),
  });
});

// node:http follows no redirects, and every socket resolves through publicLookup, so a connection
// reaches only the addresses it checked.
export const layer = Layer.effect(LinkPreviews, make).pipe(
  Layer.provide(NodeHttpClient.layerNodeHttpOptions({ lookup: publicLookup })),
);

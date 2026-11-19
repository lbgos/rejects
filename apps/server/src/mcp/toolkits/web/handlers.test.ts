import { assert, it } from "@effect/vitest";
import { browseDetail } from "./handlers.ts";

it("the action log names the engine that read the page", () => {
  const open = { action: "open", url: "https://news.test/story" } as const;
  assert.equal(
    browseDetail(open, open.url, "firecrawl"),
    "https://news.test/story · https://news.test/story · via firecrawl",
  );
  assert.equal(browseDetail(open, open.url, "solver"), `${open.url} · ${open.url} · via solver`);
  assert.equal(browseDetail(open, open.url, undefined), `${open.url} · ${open.url}`);
});

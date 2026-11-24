import { describe, expect, it } from "vite-plus/test";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a background color next to a composer seam background image", () => {
    expect(cn("dark:before:bg-transparent dark:before:bg-composer-seam-below")).toBe(
      "dark:before:bg-transparent dark:before:bg-composer-seam-below",
    );
  });

  it("keeps a bots type size next to a text color, and lets a later size replace it", () => {
    expect(cn("text-bot-footnote text-muted-foreground")).toBe(
      "text-bot-footnote text-muted-foreground",
    );
    expect(cn("text-sm text-bot-action", "text-bot-body")).toBe("text-bot-action text-bot-body");
  });
});

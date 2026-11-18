import { describe, expect, it } from "vite-plus/test";
import { markdownPreview } from "./markdownPreview.ts";

describe("markdownPreview", () => {
  it("flattens lists, emphasis, code and links to one line", () => {
    expect(markdownPreview("- **Archived** → 26 newsletters\n- [x] done `x`")).toBe(
      "Archived → 26 newsletters done x",
    );
    expect(
      markdownPreview(
        "Keep Tailscale.\n\n- Free tier: 6 users. [Pricing](https://tailscale.com/pricing)",
      ),
    ).toBe("Keep Tailscale. Free tier: 6 users. Pricing");
  });
  it("keeps underscores inside names", () => {
    expect(markdownPreview("DOWN `pve1_vm111` since _15:06_")).toBe("DOWN pve1_vm111 since 15:06");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { setWithinBudget } from "./sizedCache.ts";

describe("setWithinBudget", () => {
  it("drops the oldest entries until the sizes fit and keeps the new one", () => {
    const cache = new Map([
      ["a", 4],
      ["b", 4],
      ["c", 4],
    ]);
    setWithinBudget(cache, "a", 4, (size) => size, 12);
    expect([...cache.keys()]).toEqual(["b", "c", "a"]);
    setWithinBudget(cache, "d", 6, (size) => size, 12);
    expect([...cache.keys()]).toEqual(["a", "d"]);
    setWithinBudget(cache, "e", 20, (size) => size, 12);
    expect([...cache.keys()]).toEqual(["e"]);
  });
});

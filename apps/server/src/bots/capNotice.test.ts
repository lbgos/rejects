import { assert, it } from "@effect/vitest";
import { capNotice } from "./capNotice.ts";

it("states the numbers, the top source and how to raise the cap on one line", () => {
  const text = capNotice({
    dailyTokenCap: 20_000_000,
    tokensToday: 20_100_000,
    usage: [
      {
        day: "2026-11-11",
        tokens: 20_100_000,
        turns: 31,
        sources: [
          { source: "Hardware watch", tokens: 10_050_000, turns: 3 },
          { source: "Chat", tokens: 10_050_000, turns: 28 },
        ],
      },
    ],
  });
  assert.equal(
    text,
    "Daily token cap reached: 20M of 20M in 31 turns, mostly Hardware watch (50%). Stopped until tomorrow. Raise the cap in bot settings or ask Main.",
  );
  assert.notInclude(text, "\n");
});

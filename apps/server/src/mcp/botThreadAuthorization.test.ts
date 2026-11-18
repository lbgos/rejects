import { assert, it } from "@effect/vitest";
import { crossFamilySendMode } from "./botThreadAuthorization.ts";

it.each([
  { mode: undefined, sent: "queue" },
  { mode: "auto", sent: "queue" },
  { mode: "queue", sent: "queue" },
  { mode: "steer", sent: undefined },
  { mode: "restart", sent: undefined },
] as const)("a bot's message outside its family sends $mode as $sent", ({ mode, sent }) => {
  assert.equal(crossFamilySendMode(mode), sent);
});

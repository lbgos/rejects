import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { parseConnectionsFile } from "./ConnectionStore.ts";

const send = {
  id: "send-1",
  botThreadId: "inbox",
  accountId: "a-work",
  address: "work@example.org",
  draftId: "r-1",
  messageId: "m1",
  to: "anna@example.com",
  subject: "Tuesday",
  status: "pending",
  createdAt: "2026-11-14T00:00:00Z",
  decidedAt: null,
  error: null,
};
const file = (sends: ReadonlyArray<unknown>) =>
  JSON.stringify({
    settings: { gmail: { watch: true, model: null, vip: [], bots: ["inbox"] } },
    seen: {},
    alerts: [],
    sends,
  });

it.each([
  { row: "a send row without cc and bcc", sends: [send], kept: ["send-1"] },
  {
    row: "a send row that no longer decodes, beside a good one",
    sends: [{ ...send, id: "broken", status: "queued" }, send],
    kept: ["send-1"],
  },
])("loads $row and keeps the rest of the file", ({ sends, kept }) => {
  const state = parseConnectionsFile(file(sends));
  assert.deepEqual(
    state.sends.map((s) => s.id),
    kept,
  );
  assert.isUndefined(state.sends[0]?.cc);
  assert.deepEqual(state.settings.gmail.bots, [ThreadId.make("inbox")]);
});

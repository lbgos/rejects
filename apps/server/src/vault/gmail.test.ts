import { assert, it } from "@effect/vitest";

import { draftSummary, rawMessage } from "./gmail.ts";

const decoded = (raw: string | undefined) => Buffer.from(raw ?? "", "base64url").toString("utf8");

it("builds a reply in the thread and refuses header values that add lines", () => {
  const message = decoded(
    rawMessage(
      { to: "anna@example.com", subject: "Вторник", body: "Да, в 10." },
      { messageId: "<b@example.com>", references: "<a@example.com>" },
    ),
  );
  assert.include(message, "To: anna@example.com\r\n");
  assert.include(message, `Subject: =?UTF-8?B?${Buffer.from("Вторник").toString("base64")}?=`);
  assert.include(
    message,
    "In-Reply-To: <b@example.com>\r\nReferences: <a@example.com> <b@example.com>",
  );
  assert.include(message, Buffer.from("Да, в 10.").toString("base64"));
  for (const injected of [
    { to: "anna@example.com\r\nBcc: someone@example.net", subject: "Hi", body: "" },
    { to: "anna@example.com", subject: "Hi\nBcc: someone@example.net", body: "" },
    { to: "anna@example.com", cc: "x@example.com\rBcc: y@example.net", subject: "Hi", body: "" },
  ])
    assert.isUndefined(rawMessage(injected));
});

it("names every recipient header of a draft in full", () => {
  const many = Array.from({ length: 12 }, (_, i) => `person${i}@example.com`).join(", ");
  const headers = [
    { name: "To", value: many },
    { name: "cc", value: "copy@example.com" },
    { name: "BCC", value: "hidden@example.net" },
    { name: "Subject", value: "Hi" },
  ];
  assert.deepEqual(draftSummary({ id: "r-1", message: { id: "m1", payload: { headers } } }), {
    draftId: "r-1",
    messageId: "m1",
    to: many,
    cc: "copy@example.com",
    bcc: "hidden@example.net",
    subject: "Hi",
  });
});

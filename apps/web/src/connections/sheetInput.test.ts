import type { SheetInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { createInputQueue, inputFromBeforeInput } from "./sheetInput";

it("sends input one request at a time, in order, merging what piles up", async () => {
  const sent: SheetInput[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const push = createInputQueue(async (input) => {
    sent.push(input);
    if (sent.length === 1) await gate;
  });
  push({ type: "text", text: "a" });
  push({ type: "text", text: "b" });
  push({ type: "text", text: "c" });
  push({ type: "key", key: "Enter" });
  push({ type: "scroll", dy: 100 });
  push({ type: "scroll", dy: -30 });
  push({ type: "text", text: "d" });
  expect(sent).toEqual([{ type: "text", text: "a" }]);
  release();
  await vi.waitFor(() => expect(sent).toHaveLength(5));
  expect(sent.slice(1)).toEqual([
    { type: "text", text: "bc" },
    { type: "key", key: "Enter" },
    { type: "scroll", dy: 70 },
    { type: "text", text: "d" },
  ]);
});

it("keeps sending after a request fails", async () => {
  const sent: string[] = [];
  const push = createInputQueue(async (input) => {
    sent.push(input.type);
    if (sent.length === 1) throw new Error("offline");
  });
  push({ type: "back" });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  push({ type: "reload" });
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(sent).toEqual(["back", "reload"]);
});

const text = (value: string) => ({ getData: () => value });

it.each([
  [
    { inputType: "insertText", data: "x", dataTransfer: null },
    { type: "text", text: "x" },
  ],
  [{ inputType: "insertText", data: null, dataTransfer: null }, undefined],
  [
    { inputType: "insertFromPaste", data: null, dataTransfer: text("pw") },
    { type: "text", text: "pw" },
  ],
  [
    { inputType: "insertLineBreak", data: null, dataTransfer: null },
    { type: "key", key: "Enter" },
  ],
  [
    { inputType: "deleteContentBackward", data: null, dataTransfer: null },
    { type: "key", key: "Backspace" },
  ],
  [{ inputType: "insertCompositionText", data: "ж", dataTransfer: null }, undefined],
  [{ inputType: "historyUndo", data: null, dataTransfer: null }, undefined],
])("maps %j for the remote page", (event, expected) => {
  expect(inputFromBeforeInput(event)).toEqual(expected);
});

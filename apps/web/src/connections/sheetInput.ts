import type { SheetInput } from "@t3tools/contracts";

const TEXT_MAX = 2000;

/** Two requests in flight may arrive reversed, which scrambles typed text. Input that piles up while one is in flight is merged. */
export function createInputQueue(send: (input: SheetInput) => Promise<unknown>) {
  const queue: SheetInput[] = [];
  let busy = false;

  const drain = async () => {
    busy = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        // A failed request is the caller's to report; the input behind it still goes out.
        await Promise.resolve(send(next)).catch(() => undefined);
      }
    } finally {
      busy = false;
    }
  };

  return (input: SheetInput) => {
    const last = queue.at(-1);
    if (
      input.type === "text" &&
      last?.type === "text" &&
      last.text.length + input.text.length <= TEXT_MAX
    )
      queue[queue.length - 1] = { type: "text", text: last.text + input.text };
    else if (input.type === "scroll" && last?.type === "scroll")
      queue[queue.length - 1] = { type: "scroll", dy: last.dy + input.dy };
    else queue.push(input);
    if (!busy) void drain();
  };
}

export const inputFromBeforeInput = (event: {
  readonly inputType: string;
  readonly data: string | null;
  readonly dataTransfer: { getData: (format: string) => string } | null;
}): SheetInput | undefined => {
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText": {
      const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
      return text === "" ? undefined : { type: "text", text: text.slice(0, TEXT_MAX) };
    }
    case "insertFromPaste":
    case "insertFromDrop": {
      const text = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
      return text === "" ? undefined : { type: "text", text: text.slice(0, TEXT_MAX) };
    }
    case "insertLineBreak":
    case "insertParagraph":
      return { type: "key", key: "Enter" };
    case "deleteContentBackward":
    case "deleteWordBackward":
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward":
      return { type: "key", key: "Backspace" };
    default:
      return undefined;
  }
};

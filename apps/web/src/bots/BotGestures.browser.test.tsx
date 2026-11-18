import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../test/render";
import { TimelineRowCtx } from "../components/chat/timelineRowContext";
import { BotGestures } from "./BotGestures";
import "./bots.css";

const threadRef = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
};

function Bubble() {
  return (
    <BotGestures
      from="bot"
      messageId={MessageId.make("message-1")}
      text="some words to select"
      at="2026-11-16T09:27:00.000Z"
    >
      <div>
        <h3 className="sr-only select-none">rejects</h3>
        <div data-thread-find-text="true">
          <p>some words to select</p>
        </div>
      </div>
    </BotGestures>
  );
}

function touch(target: Element, type: "touchstart" | "touchend") {
  const point = new Touch({ identifier: 1, target, clientX: 20, clientY: 20 });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === "touchstart" ? [point] : [],
    }),
  );
}

const userSelect = (el: Element | null) => (el ? getComputedStyle(el).userSelect : null);

it("hands the bubble to native selection from the menu until the selection clears", async () => {
  await using screen = await render(
    <TimelineRowCtx value={{ threadRef } as never}>
      <Bubble />
    </TimelineRowCtx>,
    { router: false },
  );
  const bubble = screen.getByTestId("bot-bubble").element();
  const contextmenu = () =>
    bubble.dispatchEvent(
      new PointerEvent("contextmenu", { pointerType: "mouse", bubbles: true, cancelable: true }),
    );

  // A finger on a fine-pointer device still holds the bubble unselectable for its hold.
  expect(userSelect(bubble)).toBe("text");
  touch(bubble, "touchstart");
  expect(userSelect(bubble)).toBe("none");
  touch(bubble, "touchend");
  expect(userSelect(bubble)).toBe("text");

  expect(contextmenu()).toBe(false);
  await page.getByRole("menuitem", { name: "Select text" }).click();
  await expect.element(screen.getByTestId("bot-bubble")).toHaveAttribute("data-selecting");
  expect(window.getSelection()?.toString()).toBe("some words to select");

  // While selecting, a hold or right-click is the browser's and opens no menu.
  expect(contextmenu()).toBe(true);
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  window.getSelection()?.removeAllRanges();
  await vi.waitFor(() => expect(bubble.hasAttribute("data-selecting")).toBe(false));
  expect(contextmenu()).toBe(false);
});

it("keeps every editor and card row in a touch bot chat selectable", async () => {
  const session = cdp();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await using screen = await render(
      <div data-bots-mode="true">
        <div className="messages-timeline-scroll">
          <div data-timeline-row-kind="message" data-testid="message-row">
            <div data-bot-time-label data-testid="time">
              Today
            </div>
            <TimelineRowCtx value={{ threadRef } as never}>
              <Bubble />
            </TimelineRowCtx>
          </div>
          <div data-timeline-row-kind="event">
            <div data-bot-time-label data-testid="event-time">
              Today
            </div>
            <div data-testid="card">
              <p data-testid="card-text">Paste the API key</p>
              <form>
                <input data-testid="card-input" type="password" />
                <textarea data-testid="card-textarea" />
              </form>
            </div>
          </div>
          <div data-timeline-row-kind="message">
            <div className="select-none">
              <span contentEditable suppressContentEditableWarning data-testid="nested-editor" />
            </div>
          </div>
        </div>
        <div data-chat-composer-overlay="true" data-testid="composer">
          <div contentEditable suppressContentEditableWarning data-testid="composer-editor" />
        </div>
      </div>,
      { router: false },
    );
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    const at = (id: string) => userSelect(screen.getByTestId(id).element());

    // Every editor anywhere under the timeline or the composer keeps its caret.
    const editors = screen.container.querySelectorAll(
      "input, textarea, [contenteditable]:not([contenteditable='false'])",
    );
    expect(editors).toHaveLength(4);
    for (const editor of editors) expect(userSelect(editor)).toBe("text");
    for (const id of ["message-row", "time", "event-time", "bot-bubble", "composer"])
      expect([id, at(id)]).toEqual([id, "none"]);
    for (const id of ["card", "card-text"]) expect([id, at(id)]).toEqual([id, "text"]);
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});

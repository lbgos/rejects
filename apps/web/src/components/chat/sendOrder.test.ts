import { describe, expect, it, vi } from "vite-plus/test";

function stubStorage() {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  vi.stubGlobal("window", { localStorage: storage });
}

/** A fresh module is a fresh page: its open sends are gone, the journal in storage is not. */
async function loadPage() {
  vi.resetModules();
  return import("./sendOrder");
}

const reserve = (
  sendOrder: typeof import("./sendOrder"),
  messageId: string,
  threadKey = "env:thread",
) =>
  sendOrder.reserveSend({
    threadKey,
    messageId,
    draftText: `text ${messageId}`,
    attachmentCount: 0,
  });

describe("sendOrder", () => {
  it("holds a follow-up until the send before it is acknowledged", async () => {
    stubStorage();
    const sendOrder = await loadPage();
    const batch = reserve(sendOrder, "batch");
    const followUp = reserve(sendOrder, "follow-up");
    const other = reserve(sendOrder, "other-thread", "env:other");
    expect([batch.followsEarlierSend, followUp.followsEarlierSend]).toEqual([false, true]);
    expect(other.followsEarlierSend).toBe(false);

    const order: string[] = [];
    void followUp.earlierSendsSent.then((sent) => order.push(`follow-up ${sent}`));
    await Promise.resolve();
    order.push("batch sent");
    batch.settle("sent");
    await followUp.earlierSendsSent;
    expect(order).toEqual(["batch sent", "follow-up true"]);
    expect(sendOrder.hasOpenSends("env:thread")).toBe(true);
    followUp.settle("sent");
    expect(sendOrder.hasOpenSends("env:thread")).toBe(false);
  });

  it("stops every follow-up behind a failed send", async () => {
    stubStorage();
    const sendOrder = await loadPage();
    const batch = reserve(sendOrder, "batch");
    const second = reserve(sendOrder, "second");
    const third = reserve(sendOrder, "third");
    batch.settle("failed");
    expect(await second.earlierSendsSent).toBe(false);
    second.settle("failed");
    expect(await third.earlierSendsSent).toBe(false);
  });

  it("lets the user remove or edit a held follow-up until it dispatches", async () => {
    stubStorage();
    const sendOrder = await loadPage();
    const batch = reserve(sendOrder, "batch");
    const removed = reserve(sendOrder, "removed");
    const edited = reserve(sendOrder, "edited");
    const last = reserve(sendOrder, "last");
    const cancels: string[] = [];
    for (const ticket of [removed, edited, last]) {
      ticket.hold((mode) => {
        cancels.push(`${ticket.messageId} ${mode}`);
        ticket.settle("cancelled");
      });
    }
    expect(
      sendOrder.useSendOrderStore
        .getState()
        .threads["env:thread"]?.held.map((send) => send.messageId),
    ).toEqual(["removed", "edited", "last"]);

    sendOrder.cancelHeldSend("env:thread", "removed", "remove");
    sendOrder.cancelHeldSend("env:thread", "edited", "edit");
    expect(cancels).toEqual(["removed remove", "edited edit"]);
    expect(removed.beginDispatch()).toBe(false);

    batch.settle("sent");
    expect(await last.earlierSendsSent).toBe(true);
    expect(last.beginDispatch()).toBe(true);
    sendOrder.cancelHeldSend("env:thread", "last", "remove");
    expect(cancels).toHaveLength(2);
  });

  it("returns a closed page's unsent messages once and drops those the server has", async () => {
    stubStorage();
    const now = Date.UTC(2026, 10, 26, 12);
    vi.setSystemTime(now);
    const closedPage = await loadPage();
    reserve(closedPage, "reached-server");
    reserve(closedPage, "lost-batch");
    reserve(closedPage, "lost-follow-up");
    reserve(closedPage, "other-thread", "env:other");

    const page = await loadPage();
    reserve(page, "this-page");
    const serverHas = (messageId: string) => messageId === "reached-server";
    // Another tab that still beats keeps its sends.
    expect(page.takeUnsentFromClosedPages("env:thread", serverHas)).toEqual([]);

    vi.setSystemTime(now + 4 * 60_000);
    expect(page.takeUnsentFromClosedPages("env:thread", serverHas)).toEqual([
      { draftText: "text lost-batch", attachmentCount: 0 },
      { draftText: "text lost-follow-up", attachmentCount: 0 },
    ]);
    expect(page.takeUnsentFromClosedPages("env:thread", serverHas)).toEqual([]);

    // This page's own open send is not an orphan; another thread keeps its entry.
    const nextPage = await loadPage();
    expect(nextPage.takeUnsentFromClosedPages("env:thread", () => false)).toEqual([
      { draftText: "text this-page", attachmentCount: 0 },
    ]);

    // A send more than a week old is not brought back.
    vi.setSystemTime(now + 8 * 24 * 60 * 60_000);
    expect(nextPage.takeUnsentFromClosedPages("env:other", () => false)).toEqual([]);
    vi.useRealTimers();
  });
});

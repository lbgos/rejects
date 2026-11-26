import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { randomUUID } from "~/lib/utils";

export type SendOutcome = "sent" | "failed" | "cancelled";
export type HeldSendCancel = "remove" | "edit";

/**
 * A message between the user's send and the server's acknowledgement. Sends in one thread reach
 * the server in the order they were made: a send that waits on uploads holds the ones after it.
 */
export interface SendTicket {
  readonly messageId: string;
  /** An earlier send in this thread was still open when this one was made. */
  readonly followsEarlierSend: boolean;
  /** Resolves once every earlier send settled: true when none of them failed. */
  readonly earlierSendsSent: Promise<boolean>;
  /** Lets the user remove the held message or take it back to edit until it dispatches. */
  hold: (onCancel: (mode: HeldSendCancel) => void) => void;
  /** False when the user already cancelled it; after true it can no longer be cancelled. */
  beginDispatch: () => boolean;
  /** Idempotent. */
  settle: (outcome: SendOutcome) => void;
}

interface Slot {
  readonly messageId: string;
  readonly draftText: string;
  readonly settled: Promise<SendOutcome>;
  readonly resolve: (outcome: SendOutcome) => void;
  state: "open" | "dispatching" | "cancelled" | "settled";
  onCancel: ((mode: HeldSendCancel) => void) | null;
}

export interface HeldSend {
  readonly messageId: string;
  readonly draftText: string;
}

interface ThreadSends {
  /** Every open send, oldest first. */
  readonly messageIds: ReadonlyArray<string>;
  /** Open sends the user can still remove or edit. They outlive the view that sent them. */
  readonly held: ReadonlyArray<HeldSend>;
}

const EMPTY_THREAD_SENDS: ThreadSends = { messageIds: [], held: [] };

export const useSendOrderStore = create<{
  readonly threads: Readonly<Record<string, ThreadSends>>;
}>(() => ({ threads: {} }));

const chains = new Map<string, Slot[]>();

function publish(threadKey: string): void {
  const chain = chains.get(threadKey) ?? [];
  useSendOrderStore.setState((state) => {
    const threads = { ...state.threads };
    if (chain.length === 0) delete threads[threadKey];
    else
      threads[threadKey] = {
        messageIds: chain.map((slot) => slot.messageId),
        held: chain
          .filter((slot) => slot.state === "open" && slot.onCancel !== null)
          .map(({ messageId, draftText }) => ({ messageId, draftText })),
      };
    return { threads };
  });
}

export function useThreadSends(threadKey: string): ThreadSends {
  return useSendOrderStore((state) => state.threads[threadKey] ?? EMPTY_THREAD_SENDS);
}

export function openSendCount(threadKey: string): number {
  return chains.get(threadKey)?.length ?? 0;
}

export function hasOpenSends(threadKey: string): boolean {
  return openSendCount(threadKey) > 0;
}

export function reserveSend(input: {
  readonly threadKey: string;
  readonly messageId: string;
  /** What comes back in the composer if the page closes before the server has the message. */
  readonly draftText: string;
  readonly attachmentCount: number;
}): SendTicket {
  const { threadKey, messageId } = input;
  const chain = chains.get(threadKey) ?? [];
  const earlier = [...chain];
  let resolve!: (outcome: SendOutcome) => void;
  const settled = new Promise<SendOutcome>((done) => {
    resolve = done;
  });
  const slot: Slot = {
    messageId,
    draftText: input.draftText,
    settled,
    resolve,
    state: "open",
    onCancel: null,
  };
  chains.set(threadKey, [...chain, slot]);
  startHeartbeat();
  writeJournal([
    ...readJournal(),
    {
      threadKey,
      messageId,
      pageId: PAGE_ID,
      draftText: input.draftText,
      attachmentCount: input.attachmentCount,
      createdAt: new Date().toISOString(),
    },
  ]);
  publish(threadKey);
  return {
    messageId,
    followsEarlierSend: earlier.length > 0,
    earlierSendsSent: Promise.all(earlier.map((other) => other.settled)).then(
      (outcomes) => !outcomes.includes("failed"),
    ),
    hold: (onCancel) => {
      if (slot.state !== "open") return;
      slot.onCancel = onCancel;
      publish(threadKey);
    },
    beginDispatch: () => {
      if (slot.state !== "open") return false;
      slot.state = "dispatching";
      publish(threadKey);
      return true;
    },
    settle: (outcome) => {
      if (slot.state === "settled") return;
      slot.state = "settled";
      const remaining = (chains.get(threadKey) ?? []).filter((other) => other !== slot);
      if (remaining.length === 0) chains.delete(threadKey);
      else chains.set(threadKey, remaining);
      if (chains.size === 0) stopHeartbeat();
      writeJournal(readJournal().filter((entry) => entry.messageId !== messageId));
      publish(threadKey);
      slot.resolve(outcome);
    },
  };
}

export function cancelHeldSend(threadKey: string, messageId: string, mode: HeldSendCancel): void {
  const slot = chains.get(threadKey)?.find((candidate) => candidate.messageId === messageId);
  if (slot?.state !== "open" || slot.onCancel === null) return;
  slot.state = "cancelled";
  slot.onCancel(mode);
}

// The journal outlives the page, so a send cut off by a reload or a closed tab comes back.
const JOURNAL_KEY = "t3code:unsent-messages:v1";
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_ID = randomUUID();

const JournalEntry = Schema.Struct({
  threadKey: Schema.String,
  messageId: Schema.String,
  pageId: Schema.String,
  draftText: Schema.String,
  attachmentCount: Schema.Number,
  createdAt: Schema.String,
});
type JournalEntry = typeof JournalEntry.Type;
const Journal = Schema.Array(JournalEntry);

function readJournal(): ReadonlyArray<JournalEntry> {
  const cutoff = Date.now() - JOURNAL_MAX_AGE_MS;
  try {
    return (getLocalStorageItem(JOURNAL_KEY, Journal) ?? []).filter(
      (entry) => Date.parse(entry.createdAt) >= cutoff,
    );
  } catch {
    return [];
  }
}

function writeJournal(entries: ReadonlyArray<JournalEntry>): void {
  try {
    setLocalStorageItem(JOURNAL_KEY, entries, Journal);
  } catch {
    // Storage full or blocked: the send itself still goes out.
  }
}

// A page with open sends beats every 30 s and clears its beat on pagehide. Another page claims its
// entries only once the beat is gone or older than 3 min, which background timer throttling stays
// under.
const PAGES_KEY = "t3code:unsent-message-pages:v1";
const HEARTBEAT_MS = 30_000;
const PAGE_GONE_MS = 3 * 60_000;
const Pages = Schema.Record(Schema.String, Schema.Number);
let heartbeat: ReturnType<typeof setInterval> | null = null;

function readPages(): Readonly<Record<string, number>> {
  try {
    return getLocalStorageItem(PAGES_KEY, Pages) ?? {};
  } catch {
    return {};
  }
}

function writePageBeat(alive: boolean): void {
  const now = Date.now();
  const pages = Object.fromEntries(
    Object.entries(readPages()).filter(
      ([pageId, seenAt]) => pageId !== PAGE_ID && seenAt >= now - PAGE_GONE_MS,
    ),
  );
  if (alive) pages[PAGE_ID] = now;
  try {
    setLocalStorageItem(PAGES_KEY, pages, Pages);
  } catch {
    // Without the beat, another page may claim these sends early; they still go out here.
  }
}

function startHeartbeat(): void {
  if (heartbeat !== null) return;
  writePageBeat(true);
  heartbeat = setInterval(() => writePageBeat(true), HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeat === null) return;
  clearInterval(heartbeat);
  heartbeat = null;
  writePageBeat(false);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => {
    if (heartbeat !== null) writePageBeat(false);
  });
  // A page restored from the back-forward cache still owns its sends.
  window.addEventListener("pageshow", () => {
    if (heartbeat !== null) writePageBeat(true);
  });
}

/**
 * Takes this thread's sends that a closed page left open. Those the server never got are returned,
 * oldest first; the rest are dropped. A page that still beats keeps its entries.
 */
export function takeUnsentFromClosedPages(
  threadKey: string,
  serverHasMessage: (messageId: string) => boolean,
): ReadonlyArray<Pick<JournalEntry, "draftText" | "attachmentCount">> {
  const journal = readJournal();
  const pages = readPages();
  const goneBefore = Date.now() - PAGE_GONE_MS;
  const orphaned = journal.filter(
    (entry) =>
      entry.threadKey === threadKey &&
      entry.pageId !== PAGE_ID &&
      (pages[entry.pageId] ?? 0) < goneBefore,
  );
  if (orphaned.length === 0) return [];
  writeJournal(journal.filter((entry) => !orphaned.includes(entry)));
  return orphaned
    .filter((entry) => !serverHasMessage(entry.messageId))
    .map(({ draftText, attachmentCount }) => ({ draftText, attachmentCount }));
}

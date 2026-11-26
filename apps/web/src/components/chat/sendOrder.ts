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
  readonly settled: Promise<SendOutcome>;
  readonly resolve: (outcome: SendOutcome) => void;
  state: "open" | "dispatching" | "cancelled" | "settled";
  onCancel: ((mode: HeldSendCancel) => void) | null;
}

interface ThreadSends {
  /** Every open send, oldest first. */
  readonly messageIds: ReadonlyArray<string>;
  /** Open sends the user can still remove or edit. */
  readonly heldMessageIds: ReadonlyArray<string>;
}

const EMPTY_THREAD_SENDS: ThreadSends = { messageIds: [], heldMessageIds: [] };

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
        heldMessageIds: chain
          .filter((slot) => slot.state === "open" && slot.onCancel !== null)
          .map((slot) => slot.messageId),
      };
    return { threads };
  });
}

export function useThreadSends(threadKey: string): ThreadSends {
  return useSendOrderStore((state) => state.threads[threadKey] ?? EMPTY_THREAD_SENDS);
}

export function hasOpenSends(threadKey: string): boolean {
  return (chains.get(threadKey)?.length ?? 0) > 0;
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
  const slot: Slot = { messageId, settled, resolve, state: "open", onCancel: null };
  chains.set(threadKey, [...chain, slot]);
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
  try {
    return getLocalStorageItem(JOURNAL_KEY, Journal) ?? [];
  } catch {
    return [];
  }
}

function writeJournal(entries: ReadonlyArray<JournalEntry>): void {
  const cutoff = Date.now() - JOURNAL_MAX_AGE_MS;
  try {
    setLocalStorageItem(
      JOURNAL_KEY,
      entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff),
      Journal,
    );
  } catch {
    // Storage full or blocked: the send itself still goes out.
  }
}

/**
 * Takes this thread's sends that an earlier page left open. Those the server never got are
 * returned, oldest first; the rest are dropped. Another tab's open sends look the same and are
 * taken too.
 */
export function takeUnsentFromClosedPages(
  threadKey: string,
  serverHasMessage: (messageId: string) => boolean,
): ReadonlyArray<Pick<JournalEntry, "draftText" | "attachmentCount">> {
  const journal = readJournal();
  const orphaned = journal.filter(
    (entry) => entry.threadKey === threadKey && entry.pageId !== PAGE_ID,
  );
  if (orphaned.length === 0) return [];
  writeJournal(journal.filter((entry) => !orphaned.includes(entry)));
  return orphaned
    .filter((entry) => !serverHasMessage(entry.messageId))
    .map(({ draftText, attachmentCount }) => ({ draftText, attachmentCount }));
}

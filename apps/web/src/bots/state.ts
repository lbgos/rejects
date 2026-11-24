import {
  BOTS_ENDPOINTS,
  type BotSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { botRequest } from "../bots/http";
import { readPreparedConnection, usePreparedConnection } from "../state/session";

const empty: readonly BotSummary[] = [];
const noKeys: ReadonlySet<string> = new Set();

interface BotStoreState {
  readonly byEnvironment: Readonly<Record<string, readonly BotSummary[]>>;
  readonly projectKeys: ReadonlySet<string>;
  readonly listFailed: Readonly<Record<string, boolean>>;
  readonly notesRevision: Readonly<Record<string, number>>;
}

const projectKeysOf = (byEnvironment: BotStoreState["byEnvironment"]): ReadonlySet<string> => {
  const keys = Object.entries(byEnvironment).flatMap(([environmentId, bots]) =>
    bots.map((bot) => `${environmentId}:${bot.projectId}`),
  );
  return keys.length === 0 ? noKeys : new Set(keys);
};

// Persisted so a reload knows the bot projects before the first list request returns.
const useBotStore = create<BotStoreState>()(
  persist(() => ({ byEnvironment: {}, projectKeys: noKeys, listFailed: {}, notesRevision: {} }), {
    name: "rejects-bots",
    version: 1,
    partialize: (state) => ({ byEnvironment: state.byEnvironment }),
    merge: (persisted, current) => {
      const byEnvironment =
        (persisted as Partial<BotStoreState> | undefined)?.byEnvironment ?? current.byEnvironment;
      return { ...current, byEnvironment, projectKeys: projectKeysOf(byEnvironment) };
    },
  }),
);

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key));

/** Keeps unchanged bots (and the list) identical across polls, so readers re-render only on change. */
function shareUnchanged(previous: readonly BotSummary[] | undefined, next: readonly BotSummary[]) {
  if (!previous) return next;
  const shared = next.map((bot) => {
    const old = previous.find((b) => b.threadId === bot.threadId);
    return old && JSON.stringify(old) === JSON.stringify(bot) ? old : bot;
  });
  return shared.length === previous.length && shared.every((bot, i) => bot === previous[i])
    ? previous
    : shared;
}

const pending = new Map<EnvironmentId, Promise<void>>();
/** The bot conversation on screen; each list poll reports it while in use so the server skips its push. */
let viewing: ThreadId | undefined;
/** Random per page load: the server tracks each tab and device on its own. */
const client = Math.random().toString(36).slice(2);
/** A visible page counts as in use for two minutes after its last input. */
const IDLE_MS = 120_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "focus"];
let lastInput = 0;
const markInput = () => {
  lastInput = Date.now();
};
export function setViewingBot(threadId: ThreadId | undefined) {
  if (threadId && !viewing)
    for (const type of INPUT_EVENTS)
      window.addEventListener(type, markInput, { capture: true, passive: true });
  if (!threadId && viewing)
    for (const type of INPUT_EVENTS) window.removeEventListener(type, markInput, { capture: true });
  if (threadId) markInput();
  viewing = threadId;
}
const inUse = () => document.visibilityState === "visible" && Date.now() - lastInput < IDLE_MS;
export function readBots(environmentId: EnvironmentId): readonly BotSummary[] {
  return useBotStore.getState().byEnvironment[environmentId] ?? empty;
}
export function subscribeBots(listener: () => void): () => void {
  return useBotStore.subscribe(listener);
}
function readBotProjectKeys(): ReadonlySet<string> {
  return useBotStore.getState().projectKeys;
}
export function isBotThread(
  environmentId: EnvironmentId,
  thread: { readonly projectId: string },
): boolean {
  return isBotProject(readBotProjectKeys(), { environmentId, projectId: thread.projectId });
}
export function withoutBotProjects<
  T extends { readonly environmentId: string; readonly id: string },
>(keys: ReadonlySet<string>, projects: readonly T[]): readonly T[] {
  if (keys.size === 0) return projects;
  return projects.filter(
    (project) =>
      !isBotProject(keys, { environmentId: project.environmentId, projectId: project.id }),
  );
}
export function refreshBots(environmentId: EnvironmentId) {
  const current = pending.get(environmentId);
  if (current) return current;
  const request = botRequest(environmentId, BOTS_ENDPOINTS.list, {
    ...(viewing ? (inUse() ? { viewing, client } : { left: viewing, client }) : {}),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
    .then((list) => {
      useBotStore.setState((s) => {
        const listFailed = s.listFailed[environmentId]
          ? { ...s.listFailed, [environmentId]: false }
          : s.listFailed;
        const bots = shareUnchanged(s.byEnvironment[environmentId], list);
        if (bots === s.byEnvironment[environmentId])
          return listFailed === s.listFailed ? s : { listFailed };
        const byEnvironment = { ...s.byEnvironment, [environmentId]: bots };
        const projectKeys = projectKeysOf(byEnvironment);
        return {
          byEnvironment,
          projectKeys: sameKeys(projectKeys, s.projectKeys) ? s.projectKeys : projectKeys,
          listFailed,
        };
      });
      navigator.serviceWorker?.controller?.postMessage({
        type: "badge",
        count: list.filter((b) => b.unread).length,
      });
    })
    .catch((error: unknown) => {
      // Still connecting is not a failure: the list stays loading until the request can go out.
      if (!readPreparedConnection(environmentId)) throw error;
      useBotStore.setState((s) =>
        s.listFailed[environmentId]
          ? s
          : { listFailed: { ...s.listFailed, [environmentId]: true } },
      );
      throw error;
    })
    .finally(() => pending.delete(environmentId));
  pending.set(environmentId, request);
  return request;
}
export function patchBot(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  patch: Partial<BotSummary>,
) {
  useBotStore.setState((s) => ({
    byEnvironment: {
      ...s.byEnvironment,
      [environmentId]: (s.byEnvironment[environmentId] ?? empty).map((bot) =>
        bot.threadId === threadId ? { ...bot, ...patch } : bot,
      ),
    },
  }));
}
export function notesChanged(environmentId: EnvironmentId) {
  useBotStore.setState((s) => ({
    notesRevision: {
      ...s.notesRevision,
      [environmentId]: (s.notesRevision[environmentId] ?? 0) + 1,
    },
  }));
}
export function useNotesRevision(environmentId: EnvironmentId) {
  return useBotStore((s) => s.notesRevision[environmentId] ?? 0);
}
export function useBot(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  return useBotStore((s) =>
    environmentId && threadId
      ? s.byEnvironment[environmentId]?.find((b) => b.threadId === threadId)
      : undefined,
  );
}
export function useBotProjectKeys(): ReadonlySet<string> {
  return useBotStore((s) => s.projectKeys);
}
export function isBotProject(
  keys: ReadonlySet<string>,
  item: { readonly environmentId: string; readonly projectId: string },
) {
  return keys.has(`${item.environmentId}:${item.projectId}`);
}
/**
 * Opening a bot reads its notification once; a later "Mark unread" stays unread. A cold start
 * from a notification renders the persisted unread bot before the connection is ready.
 */
export function useReadOnOpen(
  environmentId: EnvironmentId,
  bot: Pick<BotSummary, "threadId" | "unread" | "notifiedAt"> | undefined,
) {
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const read = useRef<string | null>(null);
  const threadId = bot?.threadId;
  const unread = bot?.unread ?? false;
  const notifiedAt = bot?.notifiedAt ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records that the open conversation read its server notification
  useEffect(() => {
    if (!threadId || !unread || !connected) return;
    const key = `${threadId}:${notifiedAt}`;
    if (read.current === key) return;
    read.current = key;
    void botRequest(environmentId, BOTS_ENDPOINTS.read, { threadId, notifiedAt })
      .then(() => refreshBots(environmentId))
      .catch(() => undefined);
  }, [threadId, unread, notifiedAt, environmentId, connected]);
}
export function useBotsListFailed(environmentId: EnvironmentId | null) {
  return useBotStore((s) => (environmentId ? s.listFailed[environmentId] === true : false));
}

export function useBotsLoaded(environmentId: EnvironmentId | null) {
  return useBotStore((s) => (environmentId ? s.byEnvironment[environmentId] !== undefined : false));
}

/**
 * One poll per environment, however many readers (components, the notification coordinator) need
 * it. Returns the reader's release.
 */
const pollers = new Map<EnvironmentId, { readers: number; stop: () => void }>();
export function pollBots(environmentId: EnvironmentId) {
  const refresh = () => {
    void refreshBots(environmentId).catch(() => undefined);
  };
  // A new reader still gets a fresh list; refreshBots shares one request in flight.
  refresh();
  let poller = pollers.get(environmentId);
  if (!poller) {
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    // Hiding reports `left` at once, so a reply that lands right after the phone locks still pushes.
    document.addEventListener("visibilitychange", refresh);
    poller = {
      readers: 0,
      stop: () => {
        window.clearInterval(timer);
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", refresh);
      },
    };
    pollers.set(environmentId, poller);
  }
  poller.readers++;
  const current = poller;
  return () => {
    if (--current.readers > 0) return;
    current.stop();
    pollers.delete(environmentId);
  };
}

export function useBots(environmentId: EnvironmentId | null) {
  const bots = useBotStore((s) =>
    environmentId ? (s.byEnvironment[environmentId] ?? empty) : empty,
  );
  // The first request can only go out once the environment connection is prepared.
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server's bot list on a timer, on focus and on visibility changes while mounted
  useEffect(() => {
    if (!environmentId || !connected) return;
    return pollBots(environmentId);
  }, [environmentId, connected]);
  return bots;
}

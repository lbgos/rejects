import {
  BOTS_ENDPOINTS,
  type EnvironmentId,
  MEMORY_PAGE_MAX,
  type MemoryNotesPage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";
import { useNotesRevision } from "./state";

export const NOTES_PAGE = 50;

export function useNotes(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  request: { readonly query: string; readonly retired: boolean; readonly limit: number },
) {
  const [page, setPage] = useState<MemoryNotesPage | null>(null);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const revision = useNotesRevision(environmentId);
  const { query, retired, limit } = request;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads notes from the server; revision marks an edit
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const read = async () => {
      const notes: MemoryNotesPage["notes"][number][] = [];
      let total = 0;
      for (let offset = 0; offset < limit; offset += MEMORY_PAGE_MAX) {
        const next = await botRequest(
          environmentId,
          BOTS_ENDPOINTS.notes,
          {
            threadId,
            offset,
            limit: Math.min(MEMORY_PAGE_MAX, limit - offset),
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(retired ? { retired: true } : {}),
          },
          controller.signal,
        );
        notes.push(...next.notes);
        total = next.total;
        if (notes.length >= total) break;
      }
      return { notes, total };
    };
    read().then(setPage, () => undefined);
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a revision bump means the notes changed on the server, so they are read again.
  }, [environmentId, threadId, query, retired, limit, revision, connected]);
  return page;
}

import { BOTS_ENDPOINTS, type EnvironmentId, type ZdrState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";

/** The server's zero data retention state; null until it answers, and always on a build without the private call policy, which has no `/api/bots/zdr`. */
export function useZdrState(environmentId: EnvironmentId | null) {
  const [state, setState] = useState<ZdrState | null>(null);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's switch once the connection is ready
  useEffect(() => {
    if (!connected || environmentId === null) return;
    const controller = new AbortController();
    botRequest(environmentId, BOTS_ENDPOINTS.zdr, {}, controller.signal).then(
      setState,
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, connected]);
  return [state, setState] as const;
}

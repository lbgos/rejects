import { BOTS_ENDPOINTS, type BotPreferences, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";

export function useBotPreferences(environmentId: EnvironmentId | null) {
  const [preferences, setPreferences] = useState<BotPreferences | null>(null);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's preferences once the connection is ready
  useEffect(() => {
    if (!connected || environmentId === null) return;
    const controller = new AbortController();
    botRequest(environmentId, BOTS_ENDPOINTS.preferences, {}, controller.signal).then(
      setPreferences,
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, connected]);
  const save = (change: BotPreferences) =>
    environmentId === null
      ? Promise.resolve()
      : botRequest(environmentId, BOTS_ENDPOINTS.setPreferences, change).then(setPreferences);
  return [preferences, save] as const;
}

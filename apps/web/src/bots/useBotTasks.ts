import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

export function useScheduledTasks(environmentId: EnvironmentId | null) {
  return (
    useEnvironmentQuery(
      environmentId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
    ).data?.tasks ?? []
  );
}

export function nextWakeAt(
  tasks: ReadonlyArray<{ enabled: boolean; nextRunAt: string | null }>,
): string | null {
  return (
    tasks.flatMap((t) => (t.enabled && t.nextRunAt ? [t.nextRunAt] : [])).toSorted()[0] ?? null
  );
}

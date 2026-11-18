import { type ConnectionKind, isConnectionKind } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useBotTabHostActive } from "../bots/BotTabHost";
import { EnvironmentConnecting } from "../bots/EnvironmentConnecting";
import { ConnectionsScreen } from "../connections/ConnectionsScreen";
import { SidebarInset } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../state/environments";

export const Route = createFileRoute("/_chat/connections")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { site?: string; connector?: ConnectionKind; telegram?: true } => ({
    ...(typeof search.site === "string" ? { site: search.site } : {}),
    ...(isConnectionKind(search.connector) ? { connector: search.connector } : {}),
    ...(search.telegram === true || search.telegram === "true" ? { telegram: true as const } : {}),
  }),
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  const environmentId = usePrimaryEnvironmentId();
  if (useBotTabHostActive()) return null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      {environmentId ? (
        <ConnectionsScreen environmentId={environmentId} />
      ) : (
        <EnvironmentConnecting />
      )}
    </SidebarInset>
  );
}

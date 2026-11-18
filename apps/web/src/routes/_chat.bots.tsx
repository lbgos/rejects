import { createFileRoute } from "@tanstack/react-router";
import { BotsHome } from "../bots/BotsHome";
import { useBotTabHostActive } from "../bots/BotTabHost";
import { SidebarInset } from "../components/ui/sidebar";
export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (search: Record<string, unknown>) => ({
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  component: BotsRoute,
});
function BotsRoute() {
  const { thread } = Route.useSearch();
  if (useBotTabHostActive()) return null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <BotsHome thread={thread} />
    </SidebarInset>
  );
}

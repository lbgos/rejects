import { useParams, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useBot } from "./state";

export function useBotsMode(): { readonly active: boolean; readonly home: boolean } {
  // The rendered route's path, which matches the route params below; the pending path would turn
  // the mode off while a bot's thread loads.
  const pathname = useRouterState({
    select: ({ resolvedLocation, location }) => (resolvedLocation ?? location).pathname,
  });
  const home = pathname === "/bots" || pathname.startsWith("/bots/");
  // Route params are decoded; ids such as `builtin:steward` are percent-encoded in the path.
  const threadRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const bot = useBot(threadRef?.environmentId ?? null, threadRef?.threadId ?? null);
  const active = home || pathname === "/connections" || bot !== undefined;
  const modal = isAppModalPage(pathname);
  const [underModal, setUnderModal] = useState(active);
  if (!modal && underModal !== active) setUnderModal(active);
  return { active: modal ? underModal : active, home };
}

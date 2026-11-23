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
  // A link to no page is drawn inside the bots app, whose list is the way back.
  const notFound = useRouterState({
    select: ({ matches }) => matches.some((match) => match.globalNotFound === true),
  });
  const active = home || pathname === "/connections" || bot !== undefined || notFound;
  const modal = isAppModalPage(pathname);
  // A page that loads straight into Settings or Usage has no page under it yet; the app's home
  // is the bots list, so it is drawn as part of the bots app.
  const [underModal, setUnderModal] = useState(active || modal);
  if (!modal && underModal !== active) setUnderModal(active);
  return { active: modal ? underModal : active, home };
}

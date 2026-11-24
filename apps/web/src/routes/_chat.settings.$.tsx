import { createFileRoute, redirect } from "@tanstack/react-router";

// Old settings pages land on the settings list. The settings layout first sends links whose row
// moved to that row's page. An empty splat is the list itself on narrow screens.
export const Route = createFileRoute("/_chat/settings/$")({
  beforeLoad: ({ params }) => {
    if (params._splat) throw redirect({ to: "/settings", replace: true });
  },
});

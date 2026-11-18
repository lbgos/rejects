import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_chat/")({
  beforeLoad: () => {
    throw redirect({ to: "/bots", search: { thread: undefined }, replace: true });
  },
});

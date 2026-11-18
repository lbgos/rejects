import type { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Connections from "../../../connections/Connections.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { ConnectionsToolkit } from "./tools.ts";

const withConnections = Effect.fn("ConnectionsTools.call")(function* <A>(
  use: (
    connections: Connections.Connections["Service"],
    scope: Invocation.McpInvocationScope,
  ) => Effect.Effect<A, OrchestratorMcpFailure>,
) {
  return yield* use(yield* Connections.Connections, yield* Invocation.McpInvocationContext);
});

export const layer = Access.toLayer(ConnectionsToolkit, {
  connections_list: Access.readsAsCaller(() => withConnections((c, scope) => c.list(scope))),
  mail_search: Access.readsAsCaller(({ query, limit }) =>
    withConnections((c, scope) => c.read(scope, "gmail", "mail_search", { query, limit })),
  ),
  mail_read: Access.readsAsCaller(({ id }) =>
    withConnections((c, scope) => c.read(scope, "gmail", "mail_read", { id })),
  ),
  slack_unread: Access.readsAsCaller(({ sinceHours }) =>
    withConnections((c, scope) => c.read(scope, "slack", "slack_unread", { sinceHours })),
  ),
  slack_read: Access.readsAsCaller(({ channel, limit }) =>
    withConnections((c, scope) => c.read(scope, "slack", "slack_read", { channel, limit })),
  ),
  inbox_alerts: Access.readsAsCaller(() => withConnections((c, scope) => c.alerts(scope))),
});

import type { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MailAccounts from "../../../connections/MailAccounts.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { MailToolkit } from "./tools.ts";

const withMail = Effect.fn("MailTools.call")(function* <A>(
  use: (
    mail: MailAccounts.MailAccounts["Service"],
    scope: Invocation.McpInvocationScope,
  ) => Effect.Effect<A, OrchestratorMcpFailure>,
) {
  return yield* use(yield* MailAccounts.MailAccounts, yield* Invocation.McpInvocationContext);
});

export const layer = Access.toLayer(MailToolkit, {
  connect_account: Access.actsAsCaller(({ service }) =>
    withMail((mail, scope) => mail.connectLink(scope, service)),
  ),
  mail_accounts: Access.readsAsCaller(() => withMail((mail, scope) => mail.list(scope))),
  gmail_search: Access.readsAsCaller(({ account, query, limit }) =>
    withMail((mail, scope) => mail.call(scope, account, "search", { query, limit })),
  ),
  gmail_read: Access.readsAsCaller(({ account, id }) =>
    withMail((mail, scope) => mail.call(scope, account, "read", { id })),
  ),
  gmail_labels: Access.readsAsCaller(({ account }) =>
    withMail((mail, scope) => mail.call(scope, account, "labels", {})),
  ),
  gmail_sort: Access.actsAsCaller(({ account, ids, action, label }) =>
    withMail((mail, scope) => mail.call(scope, account, "sort", { ids, action, label })),
  ),
  gmail_draft: Access.actsAsCaller(({ account, ...draft }) =>
    withMail((mail, scope) => mail.call(scope, account, "draft", draft)),
  ),
  gmail_send: Access.actsAsCaller(({ account, draftId }) =>
    withMail((mail, scope) => mail.requestSend(scope, account, draftId)),
  ),
});

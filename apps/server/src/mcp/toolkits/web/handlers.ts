import { OrchestratorMcpFailure, siteOf } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { challengeStop } from "../../../bots/challenge.ts";
import * as WebBrowser from "../../../bots/WebBrowser.ts";
import * as Accounts from "../../../connections/Accounts.ts";
import * as BotSecrets from "../../../secrets/BotSecrets.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { type BotActs, botActs } from "../botActs.ts";
import { WebToolkit } from "./tools.ts";

const asBot = Effect.fn("WebTools.asBot")(function* () {
  const scope = yield* Invocation.requireThreadScope(yield* Invocation.McpInvocationContext, "web");
  return {
    web: yield* WebBrowser.WebBrowser,
    bot: scope.botThreadId ?? scope.thread.threadId,
  };
});

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

type Input = typeof WebBrowser.WebBrowseInput.Type;
const acting = (input: Input) => input.action !== "snapshot";
const describe = (input: Input) =>
  input.action === "type"
    ? `${input.secretRef === undefined ? `"${input.text ?? ""}"` : `secret ${input.secretRef}`} into ${input.ref}${input.submit ? " + Enter" : ""}`
    : (input.url ?? input.ref ?? input.text ?? "");

/** The owner's action log line; `via` names the engine that read the page when it was not the tab. */
export const browseDetail = (input: Input, url: string, via: WebBrowser.BrowseVia | undefined) =>
  `${describe(input)} · ${url}${via ? ` · via ${via}` : ""}`;

const redactPage = (page: typeof WebBrowser.WebPage.Type, redact: BotActs["redact"]) => ({
  ...page,
  url: redact(page.url),
  snapshot: redact(page.snapshot),
});

const browseAccount = Effect.fn("WebTools.browseAccount")(function* (
  input: Input,
  account: string,
) {
  const site = siteOf(account);
  if (site === undefined) return yield* invalid("account must be a site such as olx.ua.");
  const problem = WebBrowser.webInputProblem(input);
  if (problem) return yield* invalid(problem);
  const { scope, bot, redact, fail, record } = yield* botActs("web");
  const secrets = yield* BotSecrets.BotSecrets;
  const secret =
    input.secretRef === undefined ? undefined : yield* secrets.typed(bot, input.secretRef);
  const step = {
    action: `web_browse ${input.action}`,
    site,
    ...(input.secretRef === undefined ? {} : { secret: input.secretRef }),
  };
  const page = yield* (yield* Accounts.Accounts)
    .browse(scope, site, WebBrowser.accountAction(input), {
      secret,
      hasLogin: (hosts) => secrets.hasLogin(bot, hosts),
    })
    .pipe(
      Effect.tapError((error) =>
        acting(input)
          ? record({ ...step, detail: `${describe(input)} · ${error.message}`, status: "refused" })
          : Effect.void,
      ),
      Effect.mapError((error) => fail(error.message, error.code)),
    );
  if (secret !== undefined) yield* secrets.spent(secret);
  if (acting(input))
    yield* record({
      ...step,
      detail: `${describe(input)} · ${page.url}${page.blocked ? ` · blocked ${page.blocked}` : ""}`,
      status: page.blocked ? "refused" : "ok",
    });
  return redactPage(
    {
      url: page.url,
      snapshot: page.snapshot,
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      ...(page.blocked === undefined ? {} : { blocked: page.blocked }),
    },
    redact,
  );
});

export const layer = Access.toLayer(WebToolkit, {
  web_search: Access.readsAsCaller(({ query }) =>
    asBot().pipe(Effect.flatMap(({ web, bot }) => web.search(bot, query))),
  ),
  web_browse: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { web, bot } = yield* asBot();
      if (input.account !== undefined) {
        yield* web.forget(bot);
        return yield* browseAccount(input, input.account);
      }
      const { redact, fail, record } = yield* botActs("web");
      const { page, challenge, via } = yield* web
        .browse(bot, input)
        .pipe(Effect.mapError((error) => fail(error.message, error.code)));
      if (acting(input))
        yield* record({
          action: `web_browse ${input.action}`,
          detail: browseDetail(input, page.url, via),
          status: challenge ? "refused" : "ok",
        });
      // The user's own browser has no screen to hand over, so the bot stops and says so.
      if (challenge)
        return yield* fail(
          challengeStop(challenge.label, siteOf(page.url) ?? page.url, false),
          "capability_denied",
        );
      return redactPage(page, redact);
    }),
  ),
  request_login: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* Accounts.Accounts).requestLogin(scope, input);
    }),
  ),
});

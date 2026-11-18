import {
  CONNECTIONS_CALLBACK_PATH,
  CONNECTIONS_ENDPOINTS,
  CONNECTIONS_LINK_PATH,
  OAUTH_SERVICE_LABEL,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { route } from "../bots/http.ts";
import * as BotSecrets from "../secrets/BotSecrets.ts";
import * as Accounts from "./Accounts.ts";
import * as Connections from "./Connections.ts";
import * as MailAccounts from "./MailAccounts.ts";

const escapeHtml = (text: string) => text.replaceAll(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>rejects</title><style>:root{color-scheme:dark}body{margin:0;background:#000;color:#fff;font:17px/1.4 -apple-system,system-ui,sans-serif;padding:48px 20px}p{margin:0 0 12px}.e{color:#ff6b6b}button{font:inherit;color:#000;background:#fff;border:0;border-radius:8px;padding:10px 16px;margin-top:8px;cursor:pointer}</style></head><body>${body}</body></html>`;

/** The page Safari shows after Google redirects back. It carries no rejects session. */
const callbackPage = (ok: boolean, message: string) =>
  page(`<p class="${ok ? "" : "e"}">${escapeHtml(message)}</p>`);

const htmlResponse = (html: string, status: number) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });

/** A link's handle from `?h=`; the link page and its form both carry it there. */
const handleOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, "http://link").searchParams.get("h") ?? "";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const connections = yield* Connections.Connections;
    const mail = yield* MailAccounts.MailAccounts;
    const accounts = yield* Accounts.Accounts;
    const secrets = yield* BotSecrets.BotSecrets;
    const ok = () => ({});
    return Layer.mergeAll(
      route(CONNECTIONS_ENDPOINTS.state, () => connections.state),
      route(CONNECTIONS_ENDPOINTS.setField, (input) =>
        connections.setField(input).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.start, ({ kind }) => connections.connect(kind)),
      route(CONNECTIONS_ENDPOINTS.disconnect, ({ kind }) =>
        connections.disconnect(kind).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.pause, ({ kind, paused }) =>
        connections.pause(kind, paused).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.settings, (input) =>
        connections.settings(input).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.grant, (input) => connections.grant(input).pipe(Effect.map(ok))),
      route(CONNECTIONS_ENDPOINTS.sheetOpen, (input) =>
        accounts.sheetOpen(input).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.sheetFrame, ({ site, after }) =>
        accounts.sheetFrame(site, after),
      ),
      route(CONNECTIONS_ENDPOINTS.sheetViewport, ({ site, ...viewport }) =>
        accounts.sheetViewport(site, viewport).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.sheetInput, ({ site, input }) =>
        accounts.sheetInput(site, input).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.sheetClose, ({ site, done }) =>
        accounts.sheetClose(site, done).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.loginRequests, () => accounts.pending),
      route(CONNECTIONS_ENDPOINTS.secretChoosePage, ({ id }) => accounts.choosePage(id)),
      route(CONNECTIONS_ENDPOINTS.loginDismiss, ({ id }) =>
        accounts.dismiss(id).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.accountGrant, (input) =>
        accounts.grant(input).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.accountSignOut, ({ site }) =>
        accounts.signOut(site).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.accountRevoke, ({ site }) =>
        accounts.revoke(site).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.accountOrigins, ({ site, origins }) =>
        accounts.origins(site, origins).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.checkDone, ({ id }) =>
        accounts.checkDone(id).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.mailState, () => mail.state),
      route(CONNECTIONS_ENDPOINTS.mailDisconnect, ({ id }) =>
        mail.disconnect(id).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.mailSendDecide, ({ id, approve }) =>
        mail.decideSend(id, approve),
      ),
      // A bot's connect link, opened in any browser without rejects' cookie. GET only shows what
      // it connects, so a link preview cannot use it up; the button's POST does.
      HttpRouter.add(
        "GET",
        CONNECTIONS_LINK_PATH,
        Effect.gen(function* () {
          const handle = handleOf(yield* HttpServerRequest.HttpServerRequest);
          const peek = yield* mail.linkPeek(handle).pipe(Effect.result);
          if (peek._tag === "Failure")
            return htmlResponse(callbackPage(false, peek.failure.message), 400);
          const label = OAUTH_SERVICE_LABEL[peek.success.service];
          return htmlResponse(
            page(
              `<p>Connect a ${escapeHtml(label)} account to ${escapeHtml(peek.success.bot)}.</p><form method="post" action="${CONNECTIONS_LINK_PATH}?h=${encodeURIComponent(handle)}"><button type="submit">Continue to ${escapeHtml(label)}</button></form>`,
            ),
            200,
          );
        }),
      ),
      HttpRouter.add(
        "POST",
        CONNECTIONS_LINK_PATH,
        Effect.gen(function* () {
          const handle = handleOf(yield* HttpServerRequest.HttpServerRequest);
          const opened = yield* mail.linkOpen(handle).pipe(Effect.result);
          return opened._tag === "Failure"
            ? htmlResponse(callbackPage(false, opened.failure.message), 400)
            : HttpServerResponse.redirect(opened.success, {
                status: 303,
                headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
              });
        }),
      ),
      route(CONNECTIONS_ENDPOINTS.secrets, () => secrets.list),
      route(CONNECTIONS_ENDPOINTS.secretSave, ({ id, value }) =>
        secrets.save(id, value).pipe(Effect.map(ok)),
      ),
      route(CONNECTIONS_ENDPOINTS.secretRemove, ({ id }) =>
        secrets.remove(id).pipe(Effect.map(ok)),
      ),
      // Safari lands here without rejects' cookie; the single-use state is the authorization.
      HttpRouter.add(
        "GET",
        CONNECTIONS_CALLBACK_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://callback");
          const param = (name: string) => url.searchParams.get(name) ?? undefined;
          const state = param("state");
          const result =
            state === undefined
              ? { ok: false, message: "This link has no sign-in state. Start again in rejects." }
              : yield* mail.callback({
                  state,
                  code: param("code"),
                  scope: param("scope"),
                  error: param("error"),
                });
          return htmlResponse(callbackPage(result.ok, result.message), result.ok ? 200 : 400);
        }),
      ),
    );
  }),
);

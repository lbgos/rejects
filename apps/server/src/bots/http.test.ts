import {
  AuthEnvironmentScopes,
  AuthSessionId,
  BotRecord,
  BOTS_ENDPOINTS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe, expect, it } from "vite-plus/test";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { route } from "./http.ts";

const record = Schema.decodeSync(BotRecord)({
  name: "Homelab",
  persona: "Watch the homelab.",
  modelSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
  dailyTokenCap: 1000,
  threadId: "bot-1",
  projectId: "project-1",
  createdAt: "2026-11-09T00:00:00.000Z",
  unread: false,
  lastNotification: null,
  notifiedAt: null,
});

const decodeScopes = Schema.decodeUnknownSync(AuthEnvironmentScopes);

const serve = () => {
  const calls: Array<{ readonly route: string; readonly payload: object }> = [];
  const routes = Layer.mergeAll(
    route(BOTS_ENDPOINTS.setLocalNetwork, (payload) => {
      calls.push({ route: "setLocalNetwork", payload });
      return Effect.succeed(record);
    }),
    route(BOTS_ENDPOINTS.update, (payload) => {
      calls.push({ route: "update", payload });
      return Effect.succeed(record);
    }),
    route(BOTS_ENDPOINTS.list, (payload, scopes) => {
      calls.push({ route: "list", payload: { ...payload, scopes } });
      return Effect.succeed([]);
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: (request) =>
          Effect.succeed({
            sessionId: AuthSessionId.make("session-1"),
            subject: "test",
            method: "bearer-access-token",
            scopes: decodeScopes((request.headers["x-scopes"] ?? "").split(",").filter(Boolean)),
          }),
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const post = (path: string, scopes: string, body: object) =>
    handler(
      new Request(`http://rejects.test${path}`, {
        method: "POST",
        headers: { "x-scopes": scopes, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { calls, post, [Symbol.asyncDispose]: dispose };
};

describe("Local network access", () => {
  it("only a session with the settings scope sets it; a bot edit cannot carry it", async () => {
    await using server = serve();
    const grant = { threadId: "bot-1", localNetwork: ["192.168.1.27:22"] };

    const operate = await server.post(
      BOTS_ENDPOINTS.setLocalNetwork.path,
      "orchestration:operate",
      grant,
    );
    expect(operate.status).toBe(403);
    expect(server.calls).toEqual([]);

    const update = await server.post(BOTS_ENDPOINTS.update.path, "orchestration:operate", {
      ...grant,
      name: "Homelab",
      persona: "Watch the homelab.",
      modelSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      dailyTokenCap: 1000,
    });
    expect(update.status).toBe(200);
    expect(server.calls.map(({ payload }) => "localNetwork" in payload)).toEqual([false]);

    for (const entry of ["192.168.1.27", "010.0.0.1:22", "10.0.0.5/24:22", "8.8.8.8:53"]) {
      const invalid = await server.post(BOTS_ENDPOINTS.setLocalNetwork.path, "settings:write", {
        threadId: "bot-1",
        localNetwork: [entry],
      });
      expect(invalid.status, entry).toBe(400);
    }

    const owner = await server.post(BOTS_ENDPOINTS.setLocalNetwork.path, "settings:write", grant);
    expect(owner.status).toBe(200);
    expect(server.calls.at(-1)).toEqual({ route: "setLocalNetwork", payload: grant });
  });
});

describe("Bots list", () => {
  // The list seeds the user's time zone only for a caller that may set preferences.
  it("hands the handler the caller's scopes", async () => {
    await using server = serve();
    for (const scopes of ["orchestration:read", "orchestration:read,orchestration:operate"]) {
      const response = await server.post(BOTS_ENDPOINTS.list.path, scopes, {
        timeZone: "Europe/Kyiv",
      });
      expect(response.status).toBe(200);
    }
    expect(server.calls).toEqual([
      { route: "list", payload: { timeZone: "Europe/Kyiv", scopes: ["orchestration:read"] } },
      {
        route: "list",
        payload: {
          timeZone: "Europe/Kyiv",
          scopes: ["orchestration:read", "orchestration:operate"],
        },
      },
    ]);
  });
});

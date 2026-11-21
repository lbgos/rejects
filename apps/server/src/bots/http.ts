import {
  BOT_BRIDGE_ENDPOINTS,
  BOT_MEMORY_NOTES_MAX,
  BOTS_ENDPOINTS,
  AuthOrchestrationOperateScope,
  STUCK_CONTROL_ENDPOINT,
  TAB_TRANSITION_ENDPOINT,
  editNote,
  MEMORY_NOTES_MAX,
  setReaction,
  type AuthEnvironmentScope,
  type BotDreamRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";
import { authenticateHttpScope } from "../auth/http.ts";
import * as WebPush from "../push/WebPush.ts";
import * as BotBridge from "./BotBridge.ts";
import * as Bots from "./BotService.ts";
import * as BotMemoryStore from "./BotMemoryStore.ts";
import * as BotSetup from "./BotSetup.ts";
import * as BotStore from "./BotStore.ts";
import * as BotComputer from "./BotComputer.ts";
import * as BotRecordings from "./BotRecordings.ts";
import * as BotNotifications from "./BotNotifications.ts";
import * as BotDreams from "./BotDreams.ts";
import * as LinkPreviews from "./LinkPreviews.ts";
import * as StuckControls from "./StuckControls.ts";
import { BotSandbox } from "./BotSandbox.ts";
import { collectReadiness } from "./readiness.ts";
import * as ServerConfig from "../config.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { HttpClient } from "effect/http";
const failure = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status });

type Endpoint<P extends Schema.Top, S extends Schema.Top> = {
  readonly path: HttpRouter.PathInput;
  readonly payload: P;
  readonly success: S;
  readonly scope: AuthEnvironmentScope;
};
type RouteError = { readonly _tag: string; readonly message: string; readonly reason?: string };

/** `scopes` are the caller's, for handlers that do more for a client that may write. */
export const routeWithScopes = <P extends Schema.Top, S extends Schema.Top, E extends RouteError>(
  endpoint: Endpoint<P, S>,
  handle: (
    payload: P["Type"],
    scopes: ReadonlyArray<AuthEnvironmentScope>,
  ) => Effect.Effect<S["Type"], E>,
) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(endpoint.payload));
  const encode = Schema.encodeEffect(endpoint.success);
  return HttpRouter.add(
    "POST",
    endpoint.path,
    Effect.gen(function* () {
      const session = yield* authenticateHttpScope(endpoint.scope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.text.pipe(Effect.option);
      if (Option.isNone(body)) return failure(400, "Could not read the request body.");
      const payload = yield* decode(body.value).pipe(Effect.option);
      if (Option.isNone(payload)) return failure(400, "Invalid request payload.");
      const result = yield* handle(payload.value, session.scopes).pipe(Effect.result);
      if (result._tag === "Failure") {
        return failure(500, result.failure.message);
      }
      const encoded = yield* encode(result.success).pipe(Effect.option);
      if (Option.isNone(encoded)) return failure(500, "Could not encode the response.");
      return HttpServerResponse.jsonUnsafe(encoded.value);
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );
};

/** Calls `handle` with the payload alone, so a point-free method's optional parameters stay unset. */
export const route = <P extends Schema.Top, S extends Schema.Top, E extends RouteError>(
  endpoint: Endpoint<P, S>,
  handle: (payload: P["Type"]) => Effect.Effect<S["Type"], E>,
) => routeWithScopes(endpoint, (payload) => handle(payload));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const push = yield* WebPush.WebPush;
    const bots = yield* Bots.BotService;
    const setup = yield* BotSetup.BotSetup;
    const botStore = yield* BotStore.BotStore;
    const memory = yield* BotMemoryStore.BotMemoryStore;
    const dreams = yield* BotDreams.BotDreams;
    const computer = yield* BotComputer.BotComputer;
    const recordings = yield* BotRecordings.BotRecordings;
    const notifications = yield* BotNotifications.BotNotifications;
    const bridge = yield* BotBridge.BotBridge;
    const previews = yield* LinkPreviews.LinkPreviews;
    const stuck = yield* StuckControls.StuckControls;
    const sandbox = yield* BotSandbox;
    const config = yield* ServerConfig.ServerConfig;
    const readinessContext = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >();
    return Layer.mergeAll(
      route(
        {
          path: "/api/push/key",
          payload: Schema.Struct({}),
          success: Schema.Struct({ key: Schema.String }),
          scope: AuthOrchestrationOperateScope,
        },
        () => push.key.pipe(Effect.map((key) => ({ key }))),
      ),
      route(
        {
          path: "/api/push/subscribe",
          payload: WebPush.Subscription,
          success: Schema.Struct({}),
          scope: AuthOrchestrationOperateScope,
        },
        (input) => push.subscribe(input).pipe(Effect.as({})),
      ),
      route(
        {
          path: "/api/push/unsubscribe",
          payload: Schema.Struct({ endpoint: Schema.String }),
          success: Schema.Struct({}),
          scope: AuthOrchestrationOperateScope,
        },
        ({ endpoint }) => push.unsubscribe(endpoint).pipe(Effect.as({})),
      ),
      routeWithScopes(BOTS_ENDPOINTS.list, ({ viewing, left, client = "", timeZone }, scopes) =>
        Effect.all([
          viewing ? notifications.seen(viewing, true, client) : Effect.void,
          left ? notifications.seen(left, false, client) : Effect.void,
          // A viewer that cannot set preferences cannot pin the zone either.
          timeZone && scopes.includes(BOTS_ENDPOINTS.setPreferences.scope)
            ? botStore.seedTimeZone(timeZone).pipe(Effect.ignore({ log: true }))
            : Effect.void,
        ]).pipe(
          Effect.andThen(
            Effect.all({
              list: botStore.list,
              runs: dreams.runs.pipe(Effect.orElseSucceed((): ReadonlyArray<BotDreamRun> => [])),
            }),
          ),
          Effect.flatMap(({ list, runs }) =>
            memory.counts.pipe(
              Effect.orElseSucceed(() => new Map<string, number>()),
              Effect.map((counts) =>
                list.map((bot) => ({
                  ...bot,
                  noteCount: counts.get(bot.threadId) ?? 0,
                  dreams: runs.filter((run) => run.threadId === bot.threadId),
                })),
              ),
            ),
          ),
        ),
      ),
      route(BOTS_ENDPOINTS.create, bots.create),
      route(BOTS_ENDPOINTS.preferences, () => botStore.preferences),
      route(BOTS_ENDPOINTS.setPreferences, botStore.setPreferences),
      route(BOTS_ENDPOINTS.setup, setup.setup),
      route(BOTS_ENDPOINTS.readiness, () =>
        sandbox.state.pipe(
          Effect.flatMap((state) => collectReadiness(config, state)),
          Effect.provide(readinessContext),
        ),
      ),
      route(BOTS_ENDPOINTS.proposal, () => setup.proposal),
      route(BOTS_ENDPOINTS.approveProposal, ({ proposalId, nonce, messageId }) =>
        setup.approve(proposalId, nonce, messageId).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.releaseProposal, ({ proposalId }) =>
        setup.release(proposalId).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.update, bots.update),
      route(BOTS_ENDPOINTS.notes, ({ threadId, ...request }) =>
        memory.page(threadId ?? "you", request),
      ),
      route(BOTS_ENDPOINTS.setLocalNetwork, ({ threadId, localNetwork }) =>
        bots.setLocalNetwork(threadId, localNetwork),
      ),
      route(BOTS_ENDPOINTS.editNote, ({ threadId, id, text }) =>
        Effect.gen(function* () {
          const scope = threadId ?? "you";
          if (threadId !== null && !(yield* botStore.get(threadId)))
            return yield* new BotStore.BotStoreError({ operation: "missing" });
          const at = DateTime.formatIso(yield* DateTime.now);
          const max = threadId === null ? MEMORY_NOTES_MAX : BOT_MEMORY_NOTES_MAX;
          // Forgetting a note is the user's word: it is deleted, not retired.
          yield* memory.edit(scope, (notes) => editNote(notes, id, text, at, max), {
            remove: "delete",
          });
          return {};
        }),
      ),
      route(BOTS_ENDPOINTS.setNote, ({ threadId, id, pinned, retired }) =>
        memory.setNote(threadId ?? "you", id, { pinned, retired }).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.dreams, () => dreams.state),
      route(BOTS_ENDPOINTS.setDreams, (change) => dreams.set(change)),
      route(BOTS_ENDPOINTS.dreamNow, () => dreams.runNow),
      route(BOTS_ENDPOINTS.undoDream, ({ id }) => dreams.undo(id)),
      route(BOTS_ENDPOINTS.linkPreview, ({ url }) => previews.preview(url)),
      route(BOTS_ENDPOINTS.mute, ({ threadId, muted }) =>
        botStore.edit(threadId, ({ muted: _muted, ...current }) =>
          muted ? { ...current, muted } : current,
        ),
      ),
      route(BOTS_ENDPOINTS.react, ({ threadId, messageId, emoji }) =>
        botStore.edit(threadId, (current) => ({
          ...current,
          reactions: setReaction(current.reactions, messageId, emoji),
        })),
      ),
      route(BOTS_ENDPOINTS.read, ({ threadId, notifiedAt }) =>
        botStore.markRead(threadId, notifiedAt).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.unread, ({ threadId }) =>
        botStore.markUnread(threadId).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.clear, ({ threadId }) => bots.clear(threadId)),
      route(BOTS_ENDPOINTS.delete, ({ threadId }) => bots.remove(threadId).pipe(Effect.as({}))),
      route(BOTS_ENDPOINTS.computerControl, ({ threadId, active }) =>
        computer.control(threadId, active).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.computerInput, ({ threadId, input }) =>
        computer.input(threadId, input).pipe(Effect.as({})),
      ),
      route(BOTS_ENDPOINTS.screen, ({ threadId }) => computer.screen(threadId)),
      route(BOTS_ENDPOINTS.recordings, ({ threadId }) => recordings.list(threadId)),
      route(BOTS_ENDPOINTS.recordingImage, ({ threadId, id, step }) =>
        recordings.image(threadId, id, step).pipe(Effect.map((image) => ({ image }))),
      ),
      route(BOTS_ENDPOINTS.computerStop, ({ threadId, reset }) =>
        computer.stop(threadId, { reset }).pipe(Effect.as({})),
      ),
      route(BOT_BRIDGE_ENDPOINTS.state, () => bridge.state),
      route(BOT_BRIDGE_ENDPOINTS.grant, (input) => bridge.grant(input).pipe(Effect.as({}))),
      route(BOT_BRIDGE_ENDPOINTS.decide, bridge.decide),
      route(STUCK_CONTROL_ENDPOINT, stuck.report),
      route(TAB_TRANSITION_ENDPOINT, (report) =>
        Effect.logInfo(`tab-transition ${JSON.stringify(report)}`).pipe(Effect.as({})),
      ),
    );
  }),
).pipe(Layer.provide(LinkPreviews.layer));

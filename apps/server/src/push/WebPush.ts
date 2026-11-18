// @effect-diagnostics nodeBuiltinImport:off -- VAPID and subscription encryption are supplied by web-push.
import { redact } from "./redact.ts";
import webPush from "web-push";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { contact, warnInvalidContact } from "../contact.ts";

export const Subscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(4096)),
  expirationTime: Schema.optional(Schema.NullOr(Schema.Number)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(256)),
    auth: Schema.String.check(Schema.isMaxLength(256)),
  }),
});
const encodeNotification = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      threadId: ThreadId,
      unreadCount: Schema.Number,
    }),
  ),
);
const Keys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
const State = Schema.Struct({ vapid: Keys, subscriptions: Schema.Array(Subscription) });
export class PushError extends Schema.TaggedError<PushError>()("PushError", {
  operation: Schema.Literals(["load", "save", "subscribe", "send"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Push notifications failed during ${this.operation}.`;
  }
}
export class WebPush extends Context.Service<
  WebPush,
  {
    readonly key: Effect.Effect<string, PushError>;
    readonly subscribe: (subscription: typeof Subscription.Type) => Effect.Effect<void, PushError>;
    readonly unsubscribe: (endpoint: string) => Effect.Effect<void, PushError>;
    readonly send: (input: {
      title: string;
      body: string;
      threadId: ThreadId;
      unreadCount: number;
    }) => Effect.Effect<{ delivered: number; failed: number }, PushError>;
  }
>()("t3/push/WebPush") {}
const make = Effect.gen(function* () {
  const store = yield* Secrets.ServerSecretStore;
  yield* warnInvalidContact;
  /** Apple's push service answers 403 BadJwtToken unless `sub` is a mailto: or https: URL on a real domain. */
  const vapidSubject = yield* contact;
  const lock = yield* Semaphore.make(1);
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(State));
  const encode = Schema.encodeEffect(Schema.fromJsonString(State));
  const read = store.get("web-push").pipe(
    Effect.flatMap((value) =>
      Option.isSome(value) ? decode(new TextDecoder().decode(value.value)) : Effect.undefined,
    ),
    Effect.mapError((cause) => new PushError({ operation: "load", cause })),
  );
  let state = yield* read;
  const save = (next: typeof State.Type) =>
    encode(next).pipe(
      Effect.flatMap((json) => store.set("web-push", new TextEncoder().encode(json))),
      Effect.tap(() =>
        Effect.sync(() => {
          state = next;
        }),
      ),
      Effect.mapError((cause) => new PushError({ operation: "save", cause })),
    );
  const ensure = lock.withPermit(
    Effect.suspend(() =>
      state
        ? Effect.succeed(state)
        : Effect.try({
            try: () => ({ vapid: webPush.generateVAPIDKeys(), subscriptions: [] }),
            catch: (cause) => new PushError({ operation: "save", cause }),
          }).pipe(Effect.tap(save)),
    ),
  );
  const remove = (endpoint: string) =>
    lock.withPermit(
      Effect.suspend(() =>
        state
          ? save({
              ...state,
              subscriptions: state.subscriptions.filter((s) => s.endpoint !== endpoint),
            })
          : Effect.void,
      ),
    );
  const deliver = Effect.fn("WebPush.deliver")(function* (payload: string) {
    const current = yield* ensure;
    const results = yield* Effect.forEach(
      current.subscriptions,
      (subscription) =>
        Effect.tryPromise({
          try: () =>
            webPush.sendNotification(
              { endpoint: subscription.endpoint, keys: subscription.keys },
              payload,
              {
                vapidDetails: { subject: vapidSubject, ...current.vapid },
                TTL: 3600,
                timeout: 10000,
              },
            ),
          catch: (cause) => new PushError({ operation: "send", cause }),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.succeed(true),
            onFailure: (error) => {
              const cause = error.cause;
              const statusCode =
                typeof cause === "object" && cause !== null && "statusCode" in cause
                  ? cause.statusCode
                  : undefined;
              const expired = statusCode === 404 || statusCode === 410;
              return Effect.logWarning("web push delivery failed", {
                host: new URL(subscription.endpoint).host,
                statusCode,
                reason: cause instanceof Error ? cause.message : undefined,
                body:
                  typeof cause === "object" && cause !== null && "body" in cause
                    ? String(cause.body).slice(0, 200)
                    : undefined,
              }).pipe(
                Effect.andThen(expired ? remove(subscription.endpoint) : Effect.void),
                Effect.as(false),
              );
            },
          }),
        ),
      { concurrency: 4 },
    );
    return {
      delivered: results.filter(Boolean).length,
      failed: results.filter((ok) => !ok).length,
    };
  });
  return WebPush.of({
    key: ensure.pipe(Effect.map((s) => s.vapid.publicKey)),
    subscribe: Effect.fn("WebPush.subscribe")(function* (sub) {
      const url = yield* Effect.try({
        try: () => new URL(sub.endpoint),
        catch: () => new PushError({ operation: "subscribe" }),
      });
      if (url.protocol !== "https:" || !sub.keys.auth || !sub.keys.p256dh)
        return yield* new PushError({ operation: "subscribe" });
      yield* ensure;
      yield* lock.withPermit(
        Effect.suspend(() =>
          save({
            ...state!,
            subscriptions: [
              ...state!.subscriptions.filter((s) => s.endpoint !== sub.endpoint),
              sub,
            ].slice(-64),
          }),
        ),
      );
    }),
    unsubscribe: remove,
    send: Effect.fn("WebPush.send")(function* (input) {
      const payload = yield* encodeNotification({
        ...input,
        title: redact(input.title),
        // Push services reject payloads over 4 KB; a lock screen shows a few lines anyway.
        body: Array.from(redact(input.body)).slice(0, 500).join(""),
      }).pipe(Effect.mapError((cause) => new PushError({ operation: "send", cause })));
      return yield* deliver(payload);
    }),
  });
});
export const layer = Layer.effect(WebPush, make);

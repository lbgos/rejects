import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import webPush from "web-push";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Push from "./WebPush.ts";

it.effect("rejects insecure subscriptions and removes expired push endpoints", () => {
  const send = vi
    .spyOn(webPush, "sendNotification")
    .mockRejectedValue(Object.assign(new Error("Expired subscription"), { statusCode: 410 }));
  const layer = Push.layer.pipe(
    Layer.provide(Secrets.layer),
    Layer.provide(Config.layerTest(process.cwd(), { prefix: "bots-push-test-" })),
    Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.gen(function* () {
    const push = yield* Push.WebPush;
    const subscription = {
      endpoint: "https://push.example.test/device",
      keys: { auth: "test", p256dh: "test" },
    };
    assert.equal(
      (yield* Effect.flip(
        push.subscribe({ ...subscription, endpoint: "http://push.example.test/device" }),
      )).operation,
      "subscribe",
    );
    yield* push.subscribe(subscription);
    const notification = {
      title: "news",
      body: "Ready token=synthetic-token",
      threadId: ThreadId.make("news"),
      unreadCount: 1,
    };
    assert.deepEqual(yield* push.send(notification), { delivered: 0, failed: 1 });
    assert.deepEqual(yield* push.send(notification), { delivered: 0, failed: 0 });
    assert.equal(send.mock.calls.length, 1);
    assert.equal(JSON.parse(String(send.mock.calls[0]?.[1])).body, "Ready [redacted]");
    // Apple rejects a `sub` claim without a dotted domain (such as @localhost) with 403 BadJwtToken.
    assert.match(
      String(send.mock.calls[0]?.[2]?.vapidDetails?.subject),
      /^(mailto:[^@\s]+@[^@\s.]+(\.[^@\s.]+)+|https:\/\/[^\s/.]+(\.[^\s/.]+)+.*)$/,
    );
  }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => send.mockRestore())));
});

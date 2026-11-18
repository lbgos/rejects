/**
 * Slack with a user token (`xoxp-`) from the user's own internal app. The vault refuses a token
 * whose scopes could write anything, so read-only does not rest on the connector alone.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ReadItem } from "./item.ts";

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", {
  message: Schema.String,
  reconnect: Schema.Boolean,
}) {}

export const writeScopes = (scopes: ReadonlyArray<string>) =>
  scopes.filter(
    (scope) => !/^[a-z.]+:(read|history)(\.[a-z]+)?$/.test(scope) && scope !== "identify",
  );

const Reply = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const AuthTest = Schema.Struct({
  ok: Schema.Boolean,
  user: Schema.String,
  user_id: Schema.String,
  team: Schema.String,
});
const Conversations = Schema.Struct({
  channels: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      is_im: Schema.optional(Schema.Boolean),
      is_mpim: Schema.optional(Schema.Boolean),
      user: Schema.optional(Schema.String),
    }),
  ),
});
const History = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ts: Schema.String,
      user: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      subtype: Schema.optional(Schema.String),
    }),
  ),
});
const UserInfo = Schema.Struct({
  user: Schema.Struct({ name: Schema.String, real_name: Schema.optional(Schema.String) }),
});

const isoAt = (ts: string) => DateTime.formatIso(DateTime.makeUnsafe(Number(ts) * 1000));
const decodeReply = Schema.decodeUnknownEffect(Reply);

export const makeSlack = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const fail = (message: string, reconnect = false) => new SlackError({ message, reconnect });
  const names = new Map<string, string>();

  const call = Effect.fn("Slack.call")(function* <S extends Schema.Top>(
    token: string,
    method: string,
    params: Record<string, string>,
    schema: S,
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyUrlParams(params),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("Slack did not answer.")),
      );
    const body = yield* response.json.pipe(Effect.mapError(() => fail("Slack sent no JSON.")));
    const reply = yield* decodeReply(body).pipe(
      Effect.mapError(() => fail("Slack's response was unexpected.")),
    );
    if (!reply.ok)
      return yield* fail(
        `Slack refused: ${reply.error ?? "unknown"}`,
        reply.error === "invalid_auth" ||
          reply.error === "token_revoked" ||
          reply.error === "account_inactive",
      );
    const decoded = yield* Effect.succeed(body).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => fail("Slack's response was unexpected.")),
    );
    return {
      body: decoded,
      scopes: (response.headers["x-oauth-scopes"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });

  const userName = (token: string, id: string | undefined) =>
    id === undefined
      ? Effect.succeed("")
      : names.has(id)
        ? Effect.succeed(names.get(id) ?? id)
        : call(token, "users.info", { user: id }, UserInfo).pipe(
            Effect.map(({ body }) => body.user.real_name || body.user.name),
            Effect.tap((name) => Effect.sync(() => names.set(id, name))),
            Effect.orElseSucceed(() => id),
          );

  const history = Effect.fn("Slack.history")(function* (
    token: string,
    channel: string,
    oldest: number,
    limit: number,
  ) {
    const { body } = yield* call(
      token,
      "conversations.history",
      { channel, oldest: String(oldest), limit: String(limit) },
      History,
    );
    return body.messages.filter((m) => m.subtype === undefined);
  });

  const unread = Effect.fn("Slack.unread")(function* (token: string, oldest: number) {
    const me = (yield* call(token, "auth.test", {}, AuthTest)).body;
    const { body } = yield* call(
      token,
      "users.conversations",
      { types: "im,mpim,public_channel,private_channel", exclude_archived: "true", limit: "100" },
      Conversations,
    );
    const items: Array<ReadItem> = [];
    for (const channel of body.channels.slice(0, 40)) {
      const direct = channel.is_im === true || channel.is_mpim === true;
      const messages = yield* history(token, channel.id, oldest, 20).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const message of messages) {
        if (message.user === me.user_id) continue;
        const mentioned = (message.text ?? "").includes(`<@${me.user_id}>`);
        if (!direct && !mentioned) continue;
        items.push({
          id: `${channel.id}:${message.ts}`,
          kind: direct ? "dm" : "mention",
          from: yield* userName(token, message.user),
          title: direct ? "direct message" : `#${channel.name ?? channel.id}`,
          text: (message.text ?? "").slice(0, 2000),
          at: isoAt(message.ts),
        });
      }
    }
    return items;
  });

  return {
    check: Effect.fn("Slack.check")(function* (token: string) {
      const { body, scopes } = yield* call(token, "auth.test", {}, AuthTest);
      const writes = writeScopes(scopes);
      if (writes.length > 0)
        return yield* fail(
          `This token can write (${writes.join(", ")}). Use a token with read scopes only.`,
        );
      return `${body.user} · ${body.team}`;
    }),
    unread,
    read: Effect.fn("Slack.read")(function* (token: string, channel: string, limit: number) {
      const messages = yield* history(token, channel, 0, limit);
      return yield* Effect.forEach(messages, (m) =>
        userName(token, m.user).pipe(
          Effect.map((from) => ({
            id: `${channel}:${m.ts}`,
            from,
            text: (m.text ?? "").slice(0, 2000),
            at: isoAt(m.ts),
          })),
        ),
      );
    }),
    feed: (token: string, nowSeconds: number) => unread(token, nowSeconds - 2 * 24 * 3600),
    revoke: (token: string) => call(token, "auth.revoke", {}, Reply).pipe(Effect.ignore),
  };
});
export type Slack = Effect.Success<typeof makeSlack>;

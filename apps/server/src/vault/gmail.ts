/**
 * Gmail through Google's API. The instance connector holds a `gmail.readonly` token; a bot's own
 * accounts hold `gmail.modify` and `gmail.compose` for sorting and drafts. Sending a draft runs
 * only from the user's confirm in rejects. Access tokens live in memory only.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ReadItem } from "./item.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Schema.TaggedError<GmailError>()("GmailError", {
  message: Schema.String,
  reconnect: Schema.Boolean,
}) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
const Header = Schema.Struct({ name: Schema.String, value: Schema.String });
interface Part {
  readonly mimeType?: string | undefined;
  readonly body?: { readonly data?: string | undefined } | undefined;
  readonly parts?: ReadonlyArray<Part> | undefined;
  readonly headers?: ReadonlyArray<typeof Header.Type> | undefined;
}
const Part: Schema.Codec<Part> = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
  parts: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<Part> => Part))),
  headers: Schema.optional(Schema.Array(Header)),
});
const Message = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  snippet: Schema.optional(Schema.String),
  internalDate: Schema.optional(Schema.String),
  payload: Schema.optional(Part),
});
const MessageList = Schema.Struct({
  messages: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});
const Profile = Schema.Struct({ emailAddress: Schema.String });
const Label = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.optional(Schema.String),
});
const LabelList = Schema.Struct({ labels: Schema.optional(Schema.Array(Label)) });
const Draft = Schema.Struct({
  id: Schema.String,
  message: Schema.Struct({
    id: Schema.String,
    threadId: Schema.optional(Schema.String),
    payload: Schema.optional(Part),
  }),
});
const Sent = Schema.Struct({ id: Schema.String, threadId: Schema.optional(Schema.String) });

export interface DraftInput {
  readonly to: string;
  readonly cc?: string | undefined;
  readonly subject: string;
  readonly body: string;
  /** A message id from search: the draft answers it, in its thread. */
  readonly replyTo?: string | undefined;
}

/** RFC 2047 for a header with non-ASCII text. */
const encodedWord = (text: string) =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;

/**
 * A plain-text message as Gmail's `raw` (base64url). Undefined when a header value holds a line
 * break, which would let the text add headers or recipients.
 */
export const rawMessage = (
  input: DraftInput,
  reply?: { readonly messageId: string; readonly references: string },
): string | undefined => {
  const headers = [
    input.to,
    input.cc ?? "",
    input.subject,
    reply?.messageId ?? "",
    reply?.references ?? "",
  ];
  if (headers.some((value) => /[\r\n]/.test(value))) return undefined;
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${encodedWord(input.subject)}`,
    ...(reply && reply.messageId
      ? [
          `In-Reply-To: ${reply.messageId}`,
          `References: ${`${reply.references} ${reply.messageId}`.trim()}`,
        ]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    (
      Buffer.from(input.body, "utf8")
        .toString("base64")
        .match(/.{1,76}/g) ?? []
    ).join("\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
};

export interface MailSummary extends ReadItem {
  readonly labels: ReadonlyArray<string>;
  readonly bulk: boolean;
}

const header = (part: Part | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decodeBody = (data: string) =>
  Buffer.from(data.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");

const bodyText = (part: Part | undefined): string => {
  const find = (p: Part | undefined, type: string): string | undefined => {
    if (!p) return undefined;
    if (p.mimeType === type && p.body?.data) return decodeBody(p.body.data);
    for (const child of p.parts ?? []) {
      const found = find(child, type);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const plain = find(part, "text/plain");
  if (plain !== undefined) return plain;
  const html = find(part, "text/html") ?? "";
  return html
    .replaceAll(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replaceAll(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&nbsp;/g, " ")
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n\s*\n+/g, "\n\n")
    .trim();
};

/** The draft's current message and every recipient header, as the confirm card shows them. */
export const draftSummary = (draft: typeof Draft.Type) => ({
  draftId: draft.id,
  messageId: draft.message.id,
  to: header(draft.message.payload, "To"),
  cc: header(draft.message.payload, "Cc"),
  bcc: header(draft.message.payload, "Bcc"),
  subject: header(draft.message.payload, "Subject"),
});

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

export const makeGmail = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const fail = (message: string, reconnect = false) => new GmailError({ message, reconnect });

  const token = Effect.fn("Gmail.token")(function* (form: Record<string, string>) {
    const response = yield* http
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams(form),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("Google did not answer.")),
      );
    const body = yield* response.json.pipe(Effect.mapError(() => fail("Google sent no JSON.")));
    if (response.status !== 200) {
      const error = (body as { error?: string }).error;
      return yield* fail(
        error === "invalid_grant"
          ? "Google revoked the grant. Reconnect."
          : `Google refused: ${error ?? response.status}`,
        error === "invalid_grant",
      );
    }
    return yield* decodeTokenResponse(body).pipe(
      Effect.mapError(() => fail("Google's token response was unexpected.")),
    );
  });

  const call = Effect.fn("Gmail.call")(function* <S extends Schema.Top>(
    accessToken: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    schema: S,
    body?: unknown,
  ) {
    const base =
      method === "GET"
        ? HttpClientRequest.get(`${API}${path}`)
        : method === "PUT"
          ? HttpClientRequest.put(`${API}${path}`)
          : HttpClientRequest.post(`${API}${path}`);
    const request = HttpClientRequest.bearerToken(base, accessToken);
    const response = yield* http
      .execute(body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body))
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("Gmail did not answer.")),
      );
    if (response.status === 401) return yield* fail("Gmail refused the token. Reconnect.", true);
    if (response.status === 404) return yield* fail("Gmail has no such message, draft or label.");
    if (response.status !== 200 && response.status !== 204)
      return yield* fail(`Gmail answered ${response.status}.`);
    // batchModify answers 204 with no body.
    const json = response.status === 204 ? Effect.succeed<unknown>({}) : response.json;
    return yield* json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => fail("Gmail's response was unexpected.")),
    );
  });
  const get = <S extends Schema.Top>(accessToken: string, path: string, schema: S) =>
    call(accessToken, "GET", path, schema);
  const Empty = Schema.Struct({});

  const labels = (accessToken: string) =>
    get(accessToken, "/labels", LabelList).pipe(Effect.map((list) => list.labels ?? []));

  const summary = (message: typeof Message.Type): MailSummary => ({
    id: message.id,
    kind: "mail",
    from: header(message.payload, "From"),
    title: header(message.payload, "Subject"),
    text: message.snippet ?? "",
    at: message.internalDate ? isoAt(Number(message.internalDate)) : null,
    labels: message.labelIds ?? [],
    bulk: header(message.payload, "List-Unsubscribe") !== "",
  });

  const search = Effect.fn("Gmail.search")(function* (
    accessToken: string,
    query: string,
    limit: number,
  ) {
    const list = yield* get(
      accessToken,
      `/messages?${new URLSearchParams({ q: query, maxResults: String(limit) })}`,
      MessageList,
    );
    return yield* Effect.forEach(
      list.messages ?? [],
      ({ id }) =>
        get(
          accessToken,
          `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe`,
          Message,
        ).pipe(Effect.map(summary)),
      { concurrency: 4 },
    );
  });

  return {
    exchange: (input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }) =>
      token({
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      }),
    refresh: (input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
    }) =>
      token({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    profile: (accessToken: string) =>
      get(accessToken, "/profile", Profile).pipe(Effect.map((p) => p.emailAddress)),
    search,
    read: Effect.fn("Gmail.read")(function* (accessToken: string, id: string) {
      const message = yield* get(
        accessToken,
        `/messages/${encodeURIComponent(id)}?format=full`,
        Message,
      );
      return {
        ...summary(message),
        to: header(message.payload, "To"),
        date: header(message.payload, "Date"),
        text: bodyText(message.payload).slice(0, 8000),
      };
    }),
    labels,
    createLabel: (accessToken: string, name: string) =>
      call(accessToken, "POST", "/labels", Label, {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    /** Adds and removes label ids on up to 1000 messages. */
    modify: (
      accessToken: string,
      ids: ReadonlyArray<string>,
      add: ReadonlyArray<string>,
      remove: ReadonlyArray<string>,
    ) =>
      call(accessToken, "POST", "/messages/batchModify", Empty, {
        ids,
        addLabelIds: add,
        removeLabelIds: remove,
      }).pipe(Effect.asVoid),
    trash: (accessToken: string, id: string, back: boolean) =>
      call(
        accessToken,
        "POST",
        `/messages/${encodeURIComponent(id)}/${back ? "untrash" : "trash"}`,
        Schema.Struct({ id: Schema.String }),
      ).pipe(Effect.asVoid),
    /** Creates the draft, or replaces draft `draftId`'s message. */
    saveDraft: Effect.fn("Gmail.saveDraft")(function* (
      accessToken: string,
      draftId: string | undefined,
      input: DraftInput,
    ) {
      let threadId: string | undefined;
      let reply: { messageId: string; references: string } | undefined;
      if (input.replyTo !== undefined) {
        const original = yield* get(
          accessToken,
          `/messages/${encodeURIComponent(input.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
          Message,
        );
        threadId = original.threadId;
        reply = {
          messageId: header(original.payload, "Message-ID"),
          references: header(original.payload, "References"),
        };
      }
      const raw = rawMessage(input, reply);
      if (raw === undefined) return yield* fail("To, Cc and subject must be one line each.");
      const message = { raw, ...(threadId ? { threadId } : {}) };
      const draft = yield* draftId === undefined
        ? call(accessToken, "POST", "/drafts", Draft, { message })
        : call(accessToken, "PUT", `/drafts/${encodeURIComponent(draftId)}`, Draft, {
            id: draftId,
            message,
          });
      return { draftId: draft.id, messageId: draft.message.id };
    }),
    draft: (accessToken: string, draftId: string) =>
      get(accessToken, `/drafts/${encodeURIComponent(draftId)}?format=metadata`, Draft).pipe(
        Effect.map(draftSummary),
      ),
    sendDraft: (accessToken: string, draftId: string) =>
      call(accessToken, "POST", "/drafts/send", Sent, { id: draftId }),
    feed: (accessToken: string) => search(accessToken, "in:inbox newer_than:2d", 25),
    revoke: (refreshToken: string) =>
      http
        .execute(
          HttpClientRequest.post("https://oauth2.googleapis.com/revoke").pipe(
            HttpClientRequest.bodyUrlParams({ token: refreshToken }),
          ),
        )
        .pipe(Effect.timeout("20 seconds"), Effect.ignore),
  };
});
export type Gmail = Effect.Success<typeof makeGmail>;

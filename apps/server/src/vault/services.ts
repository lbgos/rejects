/**
 * The OAuth services bots connect accounts to. A new service is one entry here (endpoints,
 * scopes, where its client is pasted), its API calls in the vault's `accountOp`, and its bot
 * tools in `mcp/toolkits/mail`.
 */
import {
  type ConnectionKind,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  type OAuthService,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export interface ServiceSpec {
  /** The connector whose write-only fields hold the OAuth client id and secret. */
  readonly client: ConnectionKind;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  /** Every one must be granted, or the connect is refused. */
  readonly scopes: ReadonlyArray<string>;
  readonly authorizeParams: Readonly<Record<string, string>>;
}

export const SERVICES = {
  gmail: {
    client: "gmail",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: [GMAIL_MODIFY_SCOPE, GMAIL_COMPOSE_SCOPE],
    // Offline plus consent returns a refresh token on every connect; the chooser picks among
    // the accounts the browser is signed in to.
    authorizeParams: {
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
    },
  },
} as const satisfies Record<OAuthService, ServiceSpec>;

export const authorizeUrl = (
  service: OAuthService,
  input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
  },
) => {
  const spec: ServiceSpec = SERVICES[service];
  const url = new URL(spec.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: spec.scopes.join(" "),
    ...spec.authorizeParams,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

/** Whether `scope` (space separated, as the provider sends it) holds every scope the service needs. */
export const grantedAll = (service: OAuthService, scope: string | undefined) => {
  const granted = (scope ?? "").split(/\s+/);
  return SERVICES[service].scopes.every((needed) => granted.includes(needed));
};

export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  message: Schema.String,
  /** The grant is gone: the account needs a new link. */
  reconnect: Schema.Boolean,
}) {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
export type TokenResponse = typeof TokenResponse.Type;
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

interface Client {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Token exchange, refresh and revoke against a service's endpoints. */
export const makeOAuthClient = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const fail = (message: string, reconnect = false) => new OAuthError({ message, reconnect });
  const token = Effect.fn("OAuthClient.token")(function* (
    service: OAuthService,
    form: Record<string, string>,
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.post(SERVICES[service].tokenUrl).pipe(
          HttpClientRequest.bodyUrlParams(form),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => fail("The provider did not answer.")),
      );
    const body = yield* response.json.pipe(
      Effect.mapError(() => fail("The provider sent no JSON.")),
    );
    if (response.status !== 200) {
      const error = (body as { error?: string }).error;
      return yield* fail(
        error === "invalid_grant"
          ? "The grant was revoked. Connect the account again."
          : `The provider refused: ${error ?? response.status}`,
        error === "invalid_grant",
      );
    }
    return yield* decodeTokenResponse(body).pipe(
      Effect.mapError(() => fail("The provider's token response was unexpected.")),
    );
  });
  return {
    exchange: (
      service: OAuthService,
      input: Client & {
        readonly code: string;
        readonly verifier: string;
        readonly redirectUri: string;
      },
    ) =>
      token(service, {
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      }),
    refresh: (service: OAuthService, input: Client & { readonly refreshToken: string }) =>
      token(service, {
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }),
    revoke: (service: OAuthService, refreshToken: string) =>
      http
        .execute(
          HttpClientRequest.post(SERVICES[service].revokeUrl).pipe(
            HttpClientRequest.bodyUrlParams({ token: refreshToken }),
          ),
        )
        .pipe(Effect.timeout("20 seconds"), Effect.ignore),
  };
});
export type OAuthClient = Effect.Success<typeof makeOAuthClient>;

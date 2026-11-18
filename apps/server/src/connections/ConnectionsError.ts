import * as Schema from "effect/Schema";

export class ConnectionsError extends Schema.TaggedError<ConnectionsError>()("ConnectionsError", {
  message: Schema.String,
}) {}

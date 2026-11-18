import * as Schema from "effect/Schema";

export const ZdrModelState = Schema.Struct({
  driver: Schema.String,
  model: Schema.String,
  name: Schema.String,
  route: Schema.String,
  blocked: Schema.NullOr(Schema.String),
  validThrough: Schema.NullOr(Schema.String),
});
export type ZdrModelState = typeof ZdrModelState.Type;

/** Served only by a build with the ZDR extension; the web shows the setting when it answers. */
export const ZdrState = Schema.Struct({
  enabled: Schema.Boolean,
  models: Schema.Array(ZdrModelState),
  lastCheck: Schema.NullOr(
    Schema.Struct({ at: Schema.String, ok: Schema.Boolean, summary: Schema.String }),
  ),
});
export type ZdrState = typeof ZdrState.Type;

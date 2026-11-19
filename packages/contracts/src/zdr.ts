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

/** A bot the host's switch file lets call one model outside the allowlist. */
export const ZdrExceptionState = Schema.Struct({
  bot: Schema.String,
  model: Schema.String,
  route: Schema.String,
});
export type ZdrExceptionState = typeof ZdrExceptionState.Type;

/** Served only by a build with the ZDR extension; the web shows the setting when it answers. */
export const ZdrState = Schema.Struct({
  enabled: Schema.Boolean,
  models: Schema.Array(ZdrModelState),
  exceptions: Schema.Array(ZdrExceptionState),
  lastCheck: Schema.NullOr(
    Schema.Struct({ at: Schema.String, ok: Schema.Boolean, summary: Schema.String }),
  ),
});
export type ZdrState = typeof ZdrState.Type;

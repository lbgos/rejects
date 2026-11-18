import * as Schema from "effect/Schema";

const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1279 }));
const Vertical = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 799 }));
const Position = { x: Coordinate, y: Vertical };
export const ComputerAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("screenshot") }),
  Schema.Struct({
    action: Schema.Literals(["click", "double-click"]),
    ...Position,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
  }),
  Schema.Struct({ action: Schema.Literal("drag"), ...Position, toX: Coordinate, toY: Vertical }),
  Schema.Struct({
    action: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(20000)),
  }),
  Schema.Struct({
    action: Schema.Literal("key"),
    text: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+]{1,100}$/)),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    ...Position,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    seconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  }),
]);
export type ComputerAction = typeof ComputerAction.Type;

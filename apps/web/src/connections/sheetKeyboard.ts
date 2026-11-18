import type { SheetField, SheetFocus } from "@t3tools/contracts";

/** After Enter or Tab the page may load its next step and focus a field there; the keyboard waits this long for it. */
export const KEYBOARD_HOLD_MS = 2500;
/** A tap this close to a field's edge still counts: a field's frame is often drawn around its input. */
const FIELD_SLOP = 6;

export const fieldAt = (
  fields: ReadonlyArray<SheetField>,
  point: { readonly x: number; readonly y: number },
) =>
  fields.some(
    (field) =>
      point.x >= field.x - FIELD_SLOP &&
      point.x <= field.x + field.width + FIELD_SLOP &&
      point.y >= field.y - FIELD_SLOP &&
      point.y <= field.y + field.height + FIELD_SLOP,
  );

/**
 * The sheet's keyboard follows the page's focus. iOS raises a keyboard only for a focus inside a
 * tap, so a tap on a field opens it at once (`fieldAt`); the page's answer, read after the tap,
 * closes it when focus is not in a text field.
 */
export interface KeyboardFollow {
  /** The latest tap sent; a focus read from before it is stale. */
  readonly tap: number | null;
  /** Until then, a page that left its field keeps the keyboard. */
  readonly holdUntil: number;
  /** Whether the page had a text field focused at the last read taken. */
  readonly editing: boolean;
}

export type KeyboardMove = "open" | "close" | "none" | { readonly recheckAt: number };

export const followFocus = (
  state: KeyboardFollow,
  focus: SheetFocus | undefined,
  now: number,
  local: {
    readonly typing: boolean;
    /**
     * A fine pointer: a focus outside a tap works, and the field never closes, since keys typed
     * there go to the page whatever it focuses. On touch screens neither holds.
     */
    readonly canOpen: boolean;
  },
): { readonly state: KeyboardFollow; readonly move: KeyboardMove } => {
  if (!focus || focus.editing === null || (state.tap !== null && focus.tap !== state.tap))
    return { state, move: "none" };
  const next = { ...state, editing: focus.editing };
  if (focus.editing)
    return {
      state: next,
      move: !state.editing && !local.typing && local.canOpen ? "open" : "none",
    };
  if (!local.typing || local.canOpen) return { state: next, move: "none" };
  return { state: next, move: now < state.holdUntil ? { recheckAt: state.holdUntil } : "close" };
};

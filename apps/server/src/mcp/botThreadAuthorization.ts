/**
 * The delivery mode for a bot's message outside its own family (Main to another bot, Thread Watch
 * to a user thread): always a queued message. Steer and restart act on the target's running turn,
 * so they are refused (undefined).
 */
export const crossFamilySendMode = (mode: "auto" | "queue" | "steer" | "restart" | undefined) =>
  mode === "steer" || mode === "restart" ? undefined : ("queue" as const);

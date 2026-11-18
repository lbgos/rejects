import type { EnvironmentId, ShowUiInput, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export type UiTip = ShowUiInput & { readonly id: string };

const DISMISSED_KEY = "rejects:ui-tips-dismissed";
const DISMISSED_MAX = 50;

const readDismissed = (): ReadonlyArray<string> => {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The bot chat's `show_ui` tips, kept app-wide so a tip survives leaving the chat to reach its
 * place on a phone. Dismissed call ids persist per device, so a reload does not bring one back.
 */
export const useUiTips = create<{
  readonly chat: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly tips: ReadonlyArray<UiTip>;
  readonly dismissed: ReadonlyArray<string>;
  readonly publish: (
    chat: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    tips: ReadonlyArray<UiTip>,
  ) => void;
  readonly dismiss: (id: string) => void;
}>()((set, get) => ({
  chat: null,
  tips: [],
  dismissed: readDismissed(),
  publish: (chat, tips) => {
    const current = get();
    // Another chat without tips leaves the open chat's tips alone.
    if (tips.length === 0 && current.chat?.threadId !== chat.threadId) return;
    if (
      current.chat?.threadId === chat.threadId &&
      current.tips.length === tips.length &&
      current.tips.every((tip, index) => tip.id === tips[index]?.id)
    )
      return;
    set({ chat, tips });
  },
  dismiss: (id) => {
    const dismissed = [...get().dismissed.filter((other) => other !== id), id].slice(
      -DISMISSED_MAX,
    );
    set({ dismissed });
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
    } catch {
      // Dismissed for this page load only.
    }
  },
}));

export const currentUiTip = (state: ReturnType<typeof useUiTips.getState>) =>
  state.tips.find((tip) => !state.dismissed.includes(tip.id)) ?? null;

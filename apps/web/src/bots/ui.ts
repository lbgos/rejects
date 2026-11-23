import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { BotTemplateId, EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

export type BotPanel = "schedule" | "activity" | "memory" | "screen" | "bridge";

export interface BotDialogRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly focus: "cap" | null;
  readonly template?: BotTemplateId;
}

export interface BotReply {
  readonly threadId: ThreadId;
  readonly text: string;
}

export const useBotUi = create<{
  readonly panel: { readonly target: ScopedThreadRef; readonly panel: BotPanel } | null;
  readonly dialog: BotDialogRequest | null;
  readonly reply: BotReply | null;
}>(() => ({ panel: null, dialog: null, reply: null }));

export const botPanelOn = (
  panel: { readonly target: ScopedThreadRef; readonly panel: BotPanel } | null,
  ref: ScopedThreadRef | null | undefined,
) => (panel && ref && scopedThreadKey(panel.target) === scopedThreadKey(ref) ? panel.panel : null);

export const openBotPanel = (target: ScopedThreadRef, panel: BotPanel) => {
  useRightPanelStore.getState().close(target);
  useBotUi.setState({ panel: { target, panel } });
};
export const closeBotPanel = () => useBotUi.setState({ panel: null });
export const openBotDialog = (dialog: BotDialogRequest) => useBotUi.setState({ dialog });
export const closeBotDialog = () => useBotUi.setState({ dialog: null });
export const setBotReply = (reply: BotReply | null) => useBotUi.setState({ reply });

useRightPanelStore.subscribe((next) => {
  const open = useBotUi.getState().panel;
  if (open && selectThreadRightPanelState(next.byThreadKey, open.target).isOpen) closeBotPanel();
});

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { botPanelOn, openBotPanel, useBotUi } from "./ui";

const steward = (environment: string) =>
  scopeThreadRef(environment as EnvironmentId, ThreadId.make("builtin:steward"));
const sheet = {
  type: "file",
  id: "invoices",
  name: "invoices.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 6000,
} as const;
const filesOpen = (ref: ReturnType<typeof steward>) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).isOpen;

describe("bot chat side panels", () => {
  it("shows the bot's own panel or its files, one at a time, per environment", () => {
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    useBotUi.setState({ panel: null });
    const here = steward("env-a");
    const there = steward("env-b");

    useRightPanelStore.getState().openAttachment(here, sheet);
    openBotPanel(here, "screen");
    expect(filesOpen(here)).toBe(false);
    expect(botPanelOn(useBotUi.getState().panel, here)).toBe("screen");
    expect(botPanelOn(useBotUi.getState().panel, there)).toBeNull();

    useRightPanelStore.getState().openAttachment(there, sheet);
    expect(botPanelOn(useBotUi.getState().panel, here)).toBe("screen");

    useRightPanelStore.getState().openAttachment(here, sheet);
    expect(useBotUi.getState().panel).toBeNull();
    expect(filesOpen(here)).toBe(true);
  });
});

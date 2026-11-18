import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { UiSpotlight } from "./UiSpotlight";
import { useUiTips } from "./uiTips";

vi.mock("./state", () => ({ useBot: () => ({ name: "Помощник" }) }));

const ringTop = () =>
  Number.parseFloat(
    document.querySelector<HTMLElement>("[data-ui-spotlight] > [aria-hidden]")?.style.top ?? "NaN",
  );

it("keeps the ring on its target when only the visual viewport moves it", async () => {
  const target = document.createElement("button");
  target.dataset.uiTarget = "dictation";
  Object.assign(target.style, {
    position: "fixed",
    top: "600px",
    left: "100px",
    width: "40px",
    height: "40px",
  });
  document.body.append(target);
  using _target = { [Symbol.dispose]: () => target.remove() };
  useUiTips
    .getState()
    .publish({ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("main") }, [
      { id: "tip-visual-viewport", target: "dictation", text: "Нажми на микрофон." },
    ]);
  await using _screen = await render(
    <SidebarProvider>
      <UiSpotlight />
    </SidebarProvider>,
  );
  await vi.waitFor(() => expect(ringTop()).toBe(594));

  // The iOS keyboard lifts the composer through the visual viewport, with no window resize.
  target.style.top = "300px";
  window.visualViewport?.dispatchEvent(new Event("resize"));
  await vi.waitFor(() => expect(ringTop()).toBe(294));
});

it("offers Show for a control on a hidden tab screen and rings it once its tab is shown", async () => {
  const pane = document.createElement("div");
  pane.dataset.botTabPane = "bots";
  pane.dataset.active = "false";
  pane.style.visibility = "hidden";
  const target = document.createElement("button");
  target.dataset.uiTarget = "new_bot";
  Object.assign(target.style, {
    position: "fixed",
    top: "100px",
    left: "100px",
    width: "40px",
    height: "40px",
  });
  pane.append(target);
  document.body.append(pane);
  using _pane = { [Symbol.dispose]: () => pane.remove() };
  useUiTips
    .getState()
    .publish({ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("main") }, [
      { id: "tip-hidden-pane", target: "new_bot", text: "Нажми на карандаш." },
    ]);
  await using _screen = await render(
    <SidebarProvider>
      <UiSpotlight />
    </SidebarProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Show" })).toBeVisible();
  expect(ringTop()).toBeNaN();

  pane.dataset.active = "true";
  pane.style.visibility = "";
  await vi.waitFor(() => expect(ringTop()).toBe(94));
});

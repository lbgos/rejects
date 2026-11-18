import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import "./bots.css";

const Tabs = ({ searchShown }: { searchShown: boolean }) => (
  <div>
    <div data-bot-tab-pane="bots" data-active={searchShown}>
      <div data-bot-searching />
    </div>
    <nav data-bots-tab-bar aria-label="Tabs" />
  </div>
);

const barDisplay = () => {
  const bar = document.querySelector("[data-bots-tab-bar]");
  return bar ? getComputedStyle(bar).display : "missing";
};

it("steps the tab bar aside only for a search on the shown tab screen", async () => {
  document.documentElement.dataset.botsApp = "";
  using _app = { [Symbol.dispose]: () => delete document.documentElement.dataset.botsApp };
  await using screen = await render(<Tabs searchShown={false} />);
  expect(barDisplay()).toBe("block");

  await screen.rerender(<Tabs searchShown />);
  expect(barDisplay()).toBe("none");
});

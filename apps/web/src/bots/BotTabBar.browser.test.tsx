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

it("slides the leaving and active tab panes in the matching direction", async () => {
  document.documentElement.dataset.botsApp = "";
  using _app = { [Symbol.dispose]: () => delete document.documentElement.dataset.botsApp };
  const SlideHost = ({ dir }: { dir: "forward" | "back" | undefined }) => (
    <div data-bot-tab-host data-dir={dir}>
      <div data-bot-tab-pane="bots" data-active="false" data-leaving={dir ? "true" : undefined} />
      <div data-bot-tab-pane="you" data-active="true" />
      <div data-bot-tab-pane="settings" data-active="false" />
    </div>
  );
  await using screen = await render(<SlideHost dir="forward" />);
  const bots = document.querySelector('[data-bot-tab-pane="bots"]')!;
  const you = document.querySelector('[data-bot-tab-pane="you"]')!;
  const settings = document.querySelector('[data-bot-tab-pane="settings"]')!;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  expect(getComputedStyle(settings).visibility).toBe("hidden");
  expect(getComputedStyle(bots).visibility).toBe(reducedMotion ? "hidden" : "visible");
  expect(getComputedStyle(bots).animationName).toBe(
    reducedMotion ? "none" : "bots-tab-slide-out-forward",
  );
  expect(getComputedStyle(you).animationName).toBe(
    reducedMotion ? "none" : "bots-tab-slide-in-forward",
  );

  await screen.rerender(<SlideHost dir="back" />);
  expect(getComputedStyle(bots).animationName).toBe(
    reducedMotion ? "none" : "bots-tab-slide-out-back",
  );
  expect(getComputedStyle(you).animationName).toBe(
    reducedMotion ? "none" : "bots-tab-slide-in-back",
  );

  await screen.rerender(<SlideHost dir={undefined} />);
  expect(getComputedStyle(bots).visibility).toBe("hidden");
  expect(getComputedStyle(you).animationName).toBe("none");
});

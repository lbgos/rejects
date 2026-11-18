import { StuckControlReport } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { startStuckControlDetection } from "./stuckControl";

const decodeReport = Schema.decodeUnknownSync(StuckControlReport);

const PAGE_TEXT = ["Mom's flight lands at 9", "holiday-photos.zip", "Research bot"];

function Page() {
  const [pressed, setPressed] = useState(false);
  return (
    <main>
      <p>{PAGE_TEXT[0]}</p>
      <input defaultValue={PAGE_TEXT[1]} />
      <button type="button" data-slot="button" data-variant="ghost" aria-label={PAGE_TEXT[2]}>
        +
      </button>
      <button type="button" aria-pressed={pressed} onClick={() => setPressed(!pressed)}>
        Toggle
      </button>
      <button type="button" disabled>
        Off
      </button>
      {/* Like an icon-only copy button: the page does not change, the clipboard does. */}
      <button type="button" onClick={() => void writeTextToClipboard("x").catch(() => undefined)}>
        Copy
      </button>
    </main>
  );
}

function detect(now: number) {
  const reports: StuckControlReport[] = [];
  const stop = startStuckControlDetection({
    routeId: () => "/_chat/$environmentId/$threadId",
    onRoute: () => () => undefined,
    send: (report) => reports.push(report),
    version: "0.0.24",
    now: () => now,
    storage: localStorage,
  });
  return { reports, [Symbol.dispose]: stop };
}

// The detector listens on the document; a router adds nothing here.
const renderPage = () => render(<Page />, { router: false });

async function tapThrice(
  screen: Awaited<ReturnType<typeof renderPage>>,
  name: string,
  options?: { readonly force: boolean },
) {
  const button = screen.getByRole("button", { name });
  for (let tap = 0; tap < 3; tap += 1) await userEvent.click(button, options);
}

it("reports a dead control once, by its data attributes only", async () => {
  localStorage.clear();
  await using screen = await renderPage();
  using detector = detect(1_000);
  await tapThrice(screen, PAGE_TEXT[2]!);
  expect(detector.reports).toHaveLength(1);
  const [report] = detector.reports;
  expect(decodeReport(report)).toEqual(report);
  expect(report).toMatchObject({
    control: "slot.button.ghost",
    route: "/_chat/$environmentId/$threadId",
    confirmed: false,
  });
  const sent = JSON.stringify(detector.reports);
  for (const text of [...PAGE_TEXT, "Toggle"]) expect(sent).not.toContain(text);
});

it("ignores a toggle, a disabled control and a copy button", async () => {
  localStorage.clear();
  await using screen = await renderPage();
  using detector = detect(1_000);
  await tapThrice(screen, "Toggle");
  await tapThrice(screen, "Off", { force: true });
  await tapThrice(screen, "Copy");
  expect(detector.reports).toEqual([]);
});

it("confirms the report when the app starts again within a minute", async () => {
  localStorage.clear();
  await using screen = await renderPage();
  {
    using detector = detect(1_000);
    await tapThrice(screen, PAGE_TEXT[2]!);
    expect(detector.reports).toHaveLength(1);
  }
  using restarted = detect(31_000);
  expect(restarted.reports).toMatchObject([{ control: "slot.button.ghost", confirmed: true }]);
  expect(restarted.reports[0]?.ring.at(-1)).toBe("boot@0");
});

it("reports the same control again from a second session in this browser", async () => {
  localStorage.clear();
  await using screen = await renderPage();
  {
    using first = detect(1_000);
    await tapThrice(screen, PAGE_TEXT[2]!);
    expect(first.reports).toHaveLength(1);
  }
  // A reload past the restart window shares localStorage but is a new session.
  using second = detect(200_000);
  await tapThrice(screen, PAGE_TEXT[2]!);
  expect(second.reports).toMatchObject([{ control: "slot.button.ghost", confirmed: false }]);
  await tapThrice(screen, PAGE_TEXT[2]!);
  expect(second.reports).toHaveLength(1);
});

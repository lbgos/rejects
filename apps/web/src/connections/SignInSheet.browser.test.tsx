import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../test/render";
import { SignInSheet } from "./SignInSheet";

const environmentId = EnvironmentId.make("env");
const calls = vi.hoisted(() => ({
  log: [] as Array<{ path: string; body: Record<string, unknown> }>,
  stale: false,
  staleSent: false,
  popup: false,
  /** A touch screen: the browser under test has a fine pointer. */
  touch: false,
  focus: undefined as unknown,
  /** Answers the frame poll that is waiting, as the vault does when the page changes. */
  deliver: null as ((frame: Record<string, unknown>) => void) | null,
}));

vi.mock("../hooks/useMediaQuery", async (importOriginal) => {
  const real = await importOriginal<typeof import("../hooks/useMediaQuery")>();
  return {
    ...real,
    useMediaQuery: (query: Parameters<typeof real.useMediaQuery>[0]) => {
      const matches = real.useMediaQuery(query);
      return typeof query === "object" && query.pointer === "fine"
        ? matches && !calls.touch
        : matches;
    },
  };
});

vi.mock("../bots/http", () => ({
  botRequest: (
    _environmentId: unknown,
    endpoint: { readonly path: string },
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const name = endpoint.path.split("/").pop() ?? "";
    calls.log.push({ path: name, body });
    if (name !== "frame") return Promise.resolve({});
    if (calls.stale && !calls.staleSent && (body.after as number) >= 1) {
      calls.staleSent = true;
      return Promise.resolve({
        open: true,
        seq: 1,
        image: null,
        url: "https://example.org/login",
        title: "Example",
        width: 361,
        height: 626,
      });
    }
    if ((body.after as number) >= 1)
      return new Promise((resolve, reject) => {
        calls.deliver = resolve;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const canvas = document.createElement("canvas");
    canvas.width = 390;
    canvas.height = 844;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 390, 844);
    return Promise.resolve({
      open: true,
      seq: 1,
      image: canvas.toDataURL("image/jpeg"),
      url: "https://example.org/login",
      title: "Example",
      width: 390,
      height: 844,
      popup: calls.popup,
      focus: calls.focus,
    });
  },
}));

const sent = (path: string) => calls.log.filter((call) => call.path === path).map((c) => c.body);
const inputs = () => sent("input").map((body) => body.input);

const mount = async (options: { popup?: boolean; focus?: unknown; touch?: boolean } = {}) => {
  calls.log.length = 0;
  calls.staleSent = false;
  calls.popup = options.popup ?? false;
  calls.touch = options.touch ?? false;
  calls.focus = options.focus;
  calls.deliver = null;
  await page.viewport(390, 844);
  return render(
    <SignInSheet environmentId={environmentId} site="example.org" onClose={() => undefined} />,
    { router: false },
  );
};

const sheetRect = () => document.querySelector("[data-sign-in-sheet]")!.getBoundingClientRect();

it("fills the screen below the safe area and sizes the page to its own area", async () => {
  await using _screen = await mount();
  await vi.waitFor(() => expect(sent("viewport")).toHaveLength(1));
  const rect = sheetRect();
  expect(rect.height).toBeGreaterThan(844 * 0.9);
  expect(rect.bottom).toBeLessThanOrEqual(844);
  const area = document.querySelector("[data-sign-in-page]")!.getBoundingClientRect();
  expect(sent("viewport")[0]).toMatchObject({
    site: "example.org",
    width: Math.floor(area.width),
    height: Math.floor(area.height),
    scale: Math.min(window.devicePixelRatio, 3),
  });
  const middle = document.elementFromPoint(area.left + area.width / 2, area.top + area.height / 2);
  expect(middle?.tagName).toBe("IMG");
});

it("shows a way to close a window the page opened, in place of Forward", async () => {
  await using screen = await mount({ popup: true });
  await screen.getByRole("button", { name: "Close window" }).click();
  expect(inputs()).toContainEqual({ type: "closePopup" });
  expect(document.querySelector("[aria-label=Forward]")).toBeNull();
});

it("follows the visual viewport through a keyboard and back, with nothing left over the page", async () => {
  await using _screen = await mount();
  await vi.waitFor(() => expect(sent("viewport")).toHaveLength(1));
  await page.viewport(390, 500);
  await vi.waitFor(() => expect(sheetRect().bottom).toBeLessThanOrEqual(500));
  expect(Math.round(500 - sheetRect().bottom)).toBeLessThanOrEqual(16);
  await vi.waitFor(() => expect(sent("viewport").at(-1)?.height).toBeLessThan(500));
  await page.viewport(390, 844);
  await vi.waitFor(() => expect(sheetRect().height).toBeGreaterThan(844 * 0.9));
  const dialog = document.querySelector("[role=dialog]")!.getBoundingClientRect();
  expect([dialog.top, dialog.left, dialog.width, dialog.height]).toEqual([0, 0, 390, 844]);
  const area = document.querySelector("[data-sign-in-page]")!.getBoundingClientRect();
  expect(
    document.elementFromPoint(area.left + 5, area.top + 5)?.closest("[data-sign-in-sheet]"),
  ).not.toBeNull();
});

it("sends typing to the page as it happens, in order, and pastes", async () => {
  await using screen = await mount({ touch: true });
  await vi.waitFor(() => expect(sent("viewport")).toHaveLength(1));
  await screen.getByRole("button", { name: "Type into the page" }).click();
  const field = document.querySelector("textarea")!;
  expect(document.activeElement).toBe(field);
  const type = (init: InputEventInit) =>
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, cancelable: true, ...init }),
    );
  type({ inputType: "insertText", data: "h" });
  type({ inputType: "insertText", data: "i" });
  type({ inputType: "deleteContentBackward" });
  type({ inputType: "insertLineBreak" });
  const paste = new DataTransfer();
  paste.setData("text/plain", "pasted");
  type({ inputType: "insertFromPaste", dataTransfer: paste });
  await vi.waitFor(() => expect(JSON.stringify(inputs())).toContain("pasted"));
  const runs = inputs().reduce<Array<{ type: string; text?: string; key?: string }>>(
    (all, input) => {
      const last = all.at(-1);
      const next = input as { type: string; text?: string; key?: string };
      if (next.type === "text" && last?.type === "text")
        last.text = (last.text ?? "") + (next.text ?? "");
      else all.push({ ...next });
      return all;
    },
    [],
  );
  expect(runs).toEqual([
    { type: "text", text: "hi" },
    { type: "key", key: "Backspace" },
    { type: "key", key: "Enter" },
    { type: "text", text: "pasted" },
  ]);
  expect(field.value).toBe("​​");
  await screen.getByRole("button", { name: "Hide keyboard" }).click();
  expect(document.activeElement).not.toBe(field);
});

it("closes from a pull on the handle, and a short pull springs back", async () => {
  await using _screen = await mount();
  await vi.waitFor(() => expect(sent("viewport")).toHaveLength(1));
  const handle = document.querySelector("[data-sign-in-sheet] > div")!;
  const pull = (distance: number) => {
    const at = { pointerId: 7, bubbles: true, clientX: 195 };
    handle.dispatchEvent(new PointerEvent("pointerdown", { ...at, clientY: 20 }));
    handle.dispatchEvent(new PointerEvent("pointermove", { ...at, clientY: 20 + distance }));
    handle.dispatchEvent(new PointerEvent("pointerup", { ...at, clientY: 20 + distance }));
  };
  pull(40);
  expect(sent("close")).toHaveLength(0);
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>("[data-sign-in-sheet]")!.style.transform).toBe(""),
  );
  pull(160);
  await vi.waitFor(() => expect(sent("close")).toEqual([{ site: "example.org", done: false }]));
});

it.each([
  { button: "Cancel", done: false },
  { button: "Done", done: true },
])("the $button button closes the sheet", async ({ button, done }) => {
  await using screen = await mount();
  await vi.waitFor(() => expect(sent("viewport")).toHaveLength(1));
  await screen.getByRole("button", { name: button }).click();
  await vi.waitFor(() => expect(sent("close")).toEqual([{ site: "example.org", done }]));
});

it("keeps a picture its own shape and maps taps by it when a newer page size arrives without one", async () => {
  calls.stale = true;
  try {
    await using _screen = await mount();
    await vi.waitFor(() => expect(calls.staleSent).toBe(true));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-sign-in-page] img")).not.toBeNull(),
    );
    const image = document.querySelector<HTMLImageElement>("[data-sign-in-page] img")!;
    const box = image.getBoundingClientRect();
    const drawn = Math.min(box.width / 390, box.height / 844);
    image.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: box.left + 195 * drawn,
        clientY: box.top + 650 * drawn,
      }),
    );
    await vi.waitFor(() => expect(inputs().length).toBeGreaterThan(0));
    const tap = inputs().at(-1) as { type: string; x: number; y: number };
    expect(tap.type).toBe("tap");
    expect(tap.x).toBeCloseTo(195, -0.5);
    expect(tap.y).toBeCloseTo(650, -0.5);
    const before = inputs().length;
    image.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: box.right - 1, clientY: box.top + 20 }),
    );
    expect(inputs().length).toBe(before);
  } finally {
    calls.stale = false;
  }
});

it("raises the keyboard on a tap over a page field and drops it once the page's focus leaves it", async () => {
  const fields = [{ x: 20, y: 100, width: 300, height: 50 }];
  await using _screen = await mount({ focus: { editing: false, fields, tap: null }, touch: true });
  await vi.waitFor(() => expect(document.querySelector("[data-sign-in-page] img")).not.toBeNull());
  const image = document.querySelector<HTMLImageElement>("[data-sign-in-page] img")!;
  const field = document.querySelector("textarea")!;
  const tapAt = (x: number, y: number) => {
    const box = image.getBoundingClientRect();
    const drawn = Math.min(box.width / 390, box.height / 844);
    image.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: box.left + x * drawn,
        clientY: box.top + y * drawn,
      }),
    );
    return (inputs().at(-1) as { id: number }).id;
  };
  // Waits for the sheet's next poll, answers it, and waits until the sheet has taken the answer.
  const read = async (editing: boolean, tap: number) => {
    await vi.waitFor(() => expect(calls.deliver).not.toBeNull());
    const deliver = calls.deliver!;
    calls.deliver = null;
    deliver({
      open: true,
      seq: 2 + tap,
      image: null,
      url: "https://example.org/login",
      title: "Example",
      width: 390,
      height: 844,
      focus: { editing, fields, tap },
    });
    await vi.waitFor(() => expect(calls.deliver).not.toBeNull());
  };

  const onField = tapAt(100, 125);
  expect(document.activeElement).toBe(field);
  await read(true, onField);
  const offField = tapAt(100, 400);
  expect(document.activeElement).toBe(field);
  await read(false, onField);
  expect(document.activeElement).toBe(field);
  await read(false, offField);
  expect(document.activeElement).not.toBe(field);
});

it("takes the keys from a focused composer behind it: a click into the page and typing reach the page", async () => {
  const composer = document.createElement("textarea");
  document.body.append(composer);
  using _composer = { [Symbol.dispose]: () => composer.remove() };
  composer.focus();
  // No focus read, as from a vault that sends none: the click is not over a known field.
  await using screen = await mount();
  await vi.waitFor(() => expect(document.querySelector("[data-sign-in-page] img")).not.toBeNull());
  await expect.element(screen.getByRole("button", { name: "Hide keyboard" })).toBeInTheDocument();
  await userEvent.click(document.querySelector("[data-sign-in-page] img")!, {
    position: { x: 100, y: 300 },
  });
  await userEvent.keyboard("ab");
  await userEvent.click(screen.getByText("example.org"));
  await userEvent.keyboard("c");
  const typed = () =>
    (inputs() as Array<{ type: string; text?: string }>)
      .filter((input) => input.type === "text")
      .map((input) => input.text)
      .join("");
  await vi.waitFor(() => expect(typed()).toBe("abc"));
  expect(composer.value).toBe("");
});

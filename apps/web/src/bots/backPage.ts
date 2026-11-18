import { placeGesture } from "./useHorizontalDrag";

/** The page root carries `data-back-page`; the copy is inert and never receives input. */
interface PageCopy {
  readonly node: HTMLElement;
  readonly rect: DOMRect;
  readonly scrolls: ReadonlyArray<readonly [index: number, top: number]>;
}

let remembered: PageCopy | null = null;

export function rememberBackPage() {
  if (!window.matchMedia("(max-width: 767px)").matches) return;
  // BotTabHost keeps the other tab screens mounted; the active one is the page left behind.
  const page =
    document.querySelector('[data-bot-tab-pane][data-active="true"] [data-back-page]') ??
    document.querySelector("[data-back-page]");
  if (!(page instanceof HTMLElement)) return;
  const scrolls: Array<readonly [number, number]> = [];
  page.querySelectorAll("*").forEach((element, index) => {
    if (element.scrollTop > 0) scrolls.push([index, element.scrollTop]);
  });
  const node = page.cloneNode(true) as HTMLElement;
  node.removeAttribute("data-back-page");
  for (const element of node.querySelectorAll("[id]")) element.removeAttribute("id");
  remembered = { node, rect: page.getBoundingClientRect(), scrolls };
}

export function mountBackPage(page: HTMLElement) {
  const parent = page.parentElement;
  if (!remembered || !parent) return null;
  const { node, rect, scrolls } = remembered;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  layer.dataset.backPageLayer = "";
  Object.assign(layer.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    overflow: "hidden",
    pointerEvents: "none",
  });
  const dim = document.createElement("div");
  Object.assign(dim.style, { position: "absolute", inset: "0", background: "#000" });
  layer.append(node, dim);
  parent.insertBefore(layer, page);
  const elements = node.querySelectorAll("*");
  for (const [index, top] of scrolls) {
    const element = elements[index];
    if (element) element.scrollTop = top;
  }
  page.style.zIndex = "1";
  return {
    place(offset: number, settle: boolean) {
      const progress = Math.min(Math.max(offset / rect.width, 0), 1);
      placeGesture(layer, `translateX(${(progress - 1) * 0.3 * rect.width}px)`, settle);
      dim.style.transition = settle ? "opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "";
      dim.style.opacity = String(0.25 * (1 - progress));
    },
    remove() {
      layer.remove();
      page.style.zIndex = "";
    },
  };
}

import { describe, expect, it } from "vite-plus/test";

import { isEmptyListItem, isShortCell } from "./markdownHast.logic";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, ...children: ReadonlyArray<unknown>) => ({
  type: "element",
  tagName,
  children,
});

describe("isEmptyListItem", () => {
  it.each([
    ["a marker with nothing after it", element("li"), true],
    ["a marker followed by whitespace", element("li", text("\n")), true],
    ["text", element("li", text("Mon 24 Nov")), false],
    ["a task checkbox with no label yet", element("li", element("input")), false],
    ["an image alone", element("li", element("p", element("img"))), false],
  ])("%s", (_name, node, expected) => {
    expect(isEmptyListItem(node)).toBe(expected);
  });
});

describe("isShortCell", () => {
  it.each([
    ["an amount", element("td", text("300 g")), true],
    ["a value inside emphasis", element("td", element("strong", text("-27"))), true],
    ["a sentence", element("td", text("yes, about 300 g in the bag")), false],
    ["an empty cell", element("td"), false],
  ])("%s", (_name, node, expected) => {
    expect(isShortCell(node)).toBe(expected);
  });
});

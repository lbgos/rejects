import { describe, expect, it } from "vite-plus/test";

import { preserveUserIndentation } from "./userMessageIndentation";

const pad = (count: number) => "\u00a0".repeat(count);

describe("preserveUserIndentation", () => {
  it.each([
    [
      "pasted code under a sentence",
      "def average(scores):\n    for score in scores:\n        total = 0\n\treturn total",
      `def average(scores):\n${pad(4)}for score in scores:\n${pad(8)}total = 0\n${pad(4)}return total`,
    ],
    ["a nested list", "- one\n  - two\n    three", "- one\n  - two\n    three"],
    ["an indented code block", "see:\n\n    x = 1\n      y = 2", "see:\n\n    x = 1\n      y = 2"],
    [
      "fenced code",
      "run\n```py\nif x:\n    y()\n```\n  after",
      "run\n```py\nif x:\n    y()\n```\n  after",
    ],
    ["a quote's continuation", "> said\n  more", "> said\n  more"],
    ["text with no indentation", "one\ntwo", "one\ntwo"],
  ])("%s", (_name, input, expected) => {
    expect(preserveUserIndentation(input)).toBe(expected);
  });
});

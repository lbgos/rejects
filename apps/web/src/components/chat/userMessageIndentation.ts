const NBSP = "\u00a0";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Markdown drops the leading whitespace of a paragraph's continuation lines, which is where pasted
 * code keeps its meaning (`for` and `return` at different depths). Those lines get their
 * indentation back as non-breaking spaces. Fenced code, indented code blocks and lists already
 * keep theirs, so they are left alone.
 */
export function preserveUserIndentation(text: string): string {
  if (!/\n[ \t]/.test(text)) return text;
  let fence: string | null = null;
  // Whether the block the line continues is a plain paragraph: only its indentation is lost.
  let paragraph = false;
  return text
    .split("\n")
    .map((line) => {
      const opened = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (opened !== undefined) {
        fence = opened;
        paragraph = false;
        return line;
      }
      if (line.trim() === "") {
        paragraph = false;
        return line;
      }
      const indent = /^[ \t]+/.exec(line)?.[0] ?? "";
      if (!paragraph) {
        // A block's first line: four spaces start a code block, a marker starts a list.
        paragraph = !LIST_ITEM.test(line) && !/^ {4}|^\t/.test(indent) && !/^\s*[>#|]/.test(line);
        return line;
      }
      if (indent === "" || LIST_ITEM.test(line)) return line;
      return NBSP.repeat(indent.replaceAll("\t", "    ").length) + line.slice(indent.length);
    })
    .join("\n");
}

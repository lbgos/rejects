export function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

export function hastPlainTextDeep(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    return node.value;
  }
  if (!("children" in node) || !Array.isArray(node.children)) return "";
  return node.children.map(hastPlainTextDeep).join("");
}

export function hastHasText(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (
    "type" in node &&
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string" &&
    node.value.trim().length > 0
  ) {
    return true;
  }
  return "children" in node && Array.isArray(node.children) && node.children.some(hastHasText);
}

const SHORT_CELL_LENGTH = 12;

/** A table cell whose whole text is a short value, such as an amount, a day or a time. */
export function isShortCell(node: unknown): boolean {
  const text = hastPlainTextDeep(node).trim();
  return text.length > 0 && text.length <= SHORT_CELL_LENGTH;
}

/** A list item with no content: no element and no text beyond whitespace. */
export function isEmptyListItem(node: unknown): boolean {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return false;
  }
  return node.children.every(
    (child: unknown) =>
      !!child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string" &&
      child.value.trim() === "",
  );
}

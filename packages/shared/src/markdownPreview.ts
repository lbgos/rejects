export function markdownPreview(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/[*`#>]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

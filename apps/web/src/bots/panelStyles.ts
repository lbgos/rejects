export const SHEET_LIST =
  "sheet-list md:divide-y [&>li]:relative max-md:[&>li+li]:before:absolute max-md:[&>li+li]:before:start-5 max-md:[&>li+li]:before:end-0 max-md:[&>li+li]:before:top-0 max-md:[&>li+li]:before:h-px max-md:[&>li+li]:before:bg-bot-hairline";
export const ROW_TEXT = "text-sm max-md:text-bot-body";
export const ROW_META = "text-xs text-muted-foreground tabular-nums max-md:text-bot-callout";
export const EMPTY_NOTE =
  "px-4 py-3 text-sm text-muted-foreground max-md:px-9 max-md:pt-2 max-md:text-bot-footnote";
/** A group's heading: the same quiet line above every grouped list, on every bots screen. */
export const SECTION_TITLE =
  "truncate text-sm font-medium text-foreground max-md:text-bot-footnote max-md:font-normal max-md:text-muted-foreground";
export const SECTION_HEADER = `px-4 pt-4 pb-1.5 max-md:px-9 max-md:pt-5 ${SECTION_TITLE}`;
export const FACT_ROW =
  "flex items-baseline justify-between gap-3 px-4 py-2.5 max-md:px-5 max-md:py-3";

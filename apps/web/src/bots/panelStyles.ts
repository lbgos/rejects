/** A grouped list. Its rows are parted by a hairline that starts at the text, at every width. */
export const SHEET_LIST =
  "sheet-list [&>li]:relative [&>li+li]:before:absolute [&>li+li]:before:start-4 [&>li+li]:before:end-0 [&>li+li]:before:top-0 [&>li+li]:before:h-px [&>li+li]:before:bg-bot-hairline max-md:[&>li+li]:before:start-5";
export const ROW_TEXT = "text-sm max-md:text-bot-body";
export const ROW_META =
  "text-bot-footnote text-muted-foreground tabular-nums max-md:text-bot-callout";
/** A row that acts when pressed, not one that shows a value: it is set in the action colour. */
export const ACTION_ROW =
  "flex w-full items-center gap-2 px-4 py-2.5 text-left text-bot-action outline-none not-disabled:hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:text-muted-foreground max-md:px-5 max-md:py-3 max-md:not-disabled:hover:bg-transparent";
export const EMPTY_NOTE =
  "px-4 py-3 text-sm text-muted-foreground max-md:px-9 max-md:pt-2 max-md:text-bot-footnote";
/** A group's heading: the same quiet line above every grouped list, on every bots screen. */
export const SECTION_TITLE = "truncate text-bot-footnote font-normal text-muted-foreground";
export const SECTION_HEADER = `px-4 pt-4 pb-1.5 max-md:px-9 max-md:pt-5 ${SECTION_TITLE}`;
export const FACT_ROW =
  "flex items-baseline justify-between gap-3 px-4 py-2.5 max-md:px-5 max-md:py-3";

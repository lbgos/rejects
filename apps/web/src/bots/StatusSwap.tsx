import { type ReactNode, useState } from "react";
import { cn } from "~/lib/utils";
import { type StatusSwapState, swapStatus } from "./presentation";

/**
 * A live status line that slides the old line out and the new one in when the line changes.
 * Text that only grows (a streamed thought) updates in place. The leaving copy is plain text,
 * absolutely placed, so the swap never changes the line's size.
 */
export function StatusSwap({
  text,
  wrap = false,
  children,
}: {
  text: string;
  /** Multi-line content; a single line truncates. */
  wrap?: boolean;
  children?: ReactNode;
}) {
  const [state, setState] = useState<StatusSwapState>({ text, leaving: null, swaps: 0 });
  const next = swapStatus(state, text);
  if (next !== state) setState(next);
  return (
    <span className="relative block min-w-0 overflow-hidden">
      {next.leaving !== null ? (
        <span
          key={`out:${next.swaps}`}
          data-status-out
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0",
            wrap ? "line-clamp-4" : "truncate",
          )}
        >
          {next.leaving}
        </span>
      ) : null}
      <span
        key={`in:${next.swaps}`}
        data-status-in={next.swaps > 0 || undefined}
        className={cn("block min-w-0", !wrap && "truncate")}
      >
        {children ?? text}
      </span>
    </span>
  );
}

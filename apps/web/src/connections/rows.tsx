import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SHEET_LIST } from "../bots/panelStyles";
import { toastManager } from "../components/ui/toast";
import { t, uiLocales } from "../i18n";
import { cn } from "../lib/utils";

export const clock = (at: string) =>
  new Date(at).toLocaleString(uiLocales, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const failed = (error: unknown) =>
  toastManager.add({
    type: "error",
    title: error instanceof Error ? error.message : t("That did not work."),
  });

export function Row({
  title,
  value,
  onClick,
  tone = "muted",
  icon,
}: {
  title: string;
  value: string;
  onClick: () => void;
  tone?: "muted" | "error";
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent max-md:px-5 max-md:text-bot-body max-md:hover:bg-transparent"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 shrink-0 truncate">{title}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-right",
          tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pt-5">
      {title ? (
        <h2 className="px-4 pb-1 text-xs font-medium text-muted-foreground max-md:px-5 max-md:text-bot-heading max-md:font-bold max-md:text-foreground">
          {title}
        </h2>
      ) : null}
      <ul className={SHEET_LIST}>{children}</ul>
      {footer ? (
        <p className="px-4 pt-1.5 text-xs break-words text-muted-foreground max-md:px-5 max-md:text-bot-footnote">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

export const FIELD_ROW =
  "flex min-h-11 items-center justify-between gap-3 px-4 py-1.5 text-sm max-md:px-5 max-md:py-0 max-md:text-bot-body";

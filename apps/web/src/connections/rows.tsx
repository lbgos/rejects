import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SECTION_TITLE, SHEET_LIST } from "../bots/panelStyles";
import { Button } from "../components/ui/button";
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
  disabled = false,
}: {
  title: string;
  value: string;
  onClick: () => void;
  tone?: "muted" | "error";
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm not-disabled:hover:bg-accent disabled:text-muted-foreground max-md:px-5 max-md:text-bot-body max-md:not-disabled:hover:bg-transparent"
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
      {title ? <h2 className={cn("px-4 pb-1.5 max-md:px-9", SECTION_TITLE)}>{title}</h2> : null}
      <ul className={SHEET_LIST}>{children}</ul>
      {footer ? (
        <p className="px-4 pt-1.5 text-xs break-words text-muted-foreground max-md:px-9 max-md:text-bot-footnote">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

/** The vault holds every sign-in; while it is down the notice says so once, with the way to check again. */
export function VaultDownNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm max-md:px-5 max-md:text-bot-body">
      <span className="min-w-0 flex-1">
        {t("Sign-ins are unavailable: the account vault is not answering.")}
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("Try again")}
      </Button>
    </li>
  );
}

export const FIELD_ROW =
  "flex min-h-11 items-center justify-between gap-3 px-4 py-1.5 text-sm max-md:px-5 max-md:py-0 max-md:text-bot-body";

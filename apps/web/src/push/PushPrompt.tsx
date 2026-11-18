import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { usePush } from "./usePush";

const DISMISSED = "rejects-push-prompt-dismissed";
const readDismissed = () => {
  try {
    return window.localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
};

export function PushPrompt({ environmentId }: { environmentId: EnvironmentId }) {
  const push = usePush();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed || push.enabled !== false || push.environmentId !== environmentId) return null;
  return (
    <li
      data-push-prompt
      className="flex items-center gap-1 ps-2 pt-2 text-xs text-muted-foreground max-md:ps-5 max-md:pe-2 max-md:text-bot-footnote"
    >
      <span className="min-w-0 flex-1 py-1">
        {push.message ?? push.blocker ?? t("Get bot replies on this device.")}
      </span>
      {push.blocker ? null : (
        <Button size="sm" variant="ghost" disabled={push.busy} onClick={() => void push.enable()}>
          {push.busy ? t("Turning on…") : t("Turn on")}
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label={t("Hide")}
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(DISMISSED, "1");
          } catch {
            // Hidden for this session only.
          }
        }}
      >
        <XIcon />
      </Button>
    </li>
  );
}

import { useState } from "react";
import { Button } from "../components/ui/button";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { t } from "../i18n";

// A normal load finds its server well within this; only a stuck one shows the screen.
const SHOW_AFTER_MS = 1_000;

/** Shown while the page has not found its server yet. Reloading starts the connection over. */
export function EnvironmentConnecting() {
  const [deadline] = useState(() => Date.now() + SHOW_AFTER_MS);
  const shown = useDeadlinePassed(deadline);
  if (!shown) return null;
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-foreground max-md:text-bot-callout">{t("Connecting…")}</p>
      <Button size="pill" variant="secondary" onClick={() => window.location.reload()}>
        {t("Try again")}
      </Button>
    </main>
  );
}

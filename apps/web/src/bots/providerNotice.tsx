import type { ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { t } from "../i18n";

function OpenModelSettings() {
  const navigate = useNavigate();
  return (
    <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/settings/providers" })}>
      {t("Open settings")}
    </Button>
  );
}

/**
 * A bot whose model provider is down says so once, above the composer, with the way to fix it.
 * A provider that still answers (a warning) is not worth a notice in a bot chat.
 */
export function botProviderNotice(input: {
  readonly botName: string;
  readonly status: ServerProvider | null;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem | null {
  if (input.status?.status !== "error") return null;
  return {
    id: `bot-provider:${input.status.instanceId}`,
    variant: "error",
    icon: <CircleAlertIcon />,
    title: t("{bot} can’t reply: its model is not set up on this server.", {
      bot: input.botName,
    }),
    actions: <OpenModelSettings />,
    dismissLabel: t("Dismiss"),
    onDismiss: input.onDismiss,
  };
}

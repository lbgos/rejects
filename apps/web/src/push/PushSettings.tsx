import { Button } from "../components/ui/button";
import { SettingsRow } from "../components/settings/settingsLayout";
import { t } from "../i18n";
import { searchableSetting } from "../components/settings/settingsSearch";
import { usePush } from "./usePush";

export function PushSettings() {
  const push = usePush();
  return (
    <SettingsRow
      {...searchableSetting("bot-notifications")}
      data-ui-target="notifications"
      description={
        push.message ??
        push.blocker ??
        t("Push to this device when a bot messages or answers you, even with the app closed.")
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={push.busy || !push.environmentId || push.enabled === null}
          onClick={() => void (push.enabled ? push.disable() : push.enable())}
        >
          {push.busy ? t("Saving…") : push.enabled ? t("Turn off") : t("Turn on")}
        </Button>
      }
    />
  );
}

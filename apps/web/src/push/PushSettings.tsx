import { Switch } from "../components/ui/switch";
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
      description={t(
        "Push to this device when a bot messages or answers you, even with the app closed.",
      )}
      status={push.message ?? push.blocker ?? undefined}
      control={
        <Switch
          checked={push.enabled === true}
          disabled={push.busy || !push.environmentId || push.enabled === null}
          onCheckedChange={(enabled) => void (enabled ? push.enable() : push.disable())}
          aria-label={t("Bot notifications")}
        />
      }
    />
  );
}

import { BOTS_ENDPOINTS, type BotPreferences } from "@t3tools/contracts";
import { useState } from "react";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  browserLanguage,
  readUiLanguageChoice,
  setUiLanguageChoice,
  t,
  type UiLanguage,
  type UiLanguageChoice,
  type UiText,
} from "../i18n";
import { readLocalApi } from "../localApi";
import { usePrimaryEnvironmentId } from "../state/environments";
import { botRequest } from "./http";
import { useBotPreferences } from "./preferences";
import { useZdrState } from "./zdr";
import { messageTimeLabel } from "./presentation";

const LANGUAGE_NAME: Record<UiLanguage, string> = {
  en: "English",
  uk: "Українська",
  ru: "Русский",
};
const LANGUAGE_CHOICES: ReadonlyArray<UiLanguageChoice> = ["browser", "en", "uk", "ru"];

const languageLabel = (choice: UiLanguageChoice) =>
  choice === "browser"
    ? t("Browser ({language})", { language: LANGUAGE_NAME[browserLanguage] })
    : LANGUAGE_NAME[choice];

export function BotSettingsSection() {
  return (
    <SettingsSection id="bots" title={t("Bots")}>
      <LanguageSetting />
      <ExperienceSetting />
      <TimeZoneSetting />
      <ZdrSetting />
    </SettingsSection>
  );
}

function LanguageSetting() {
  const choice = readUiLanguageChoice();
  const environmentId = usePrimaryEnvironmentId();
  const [, savePreferences] = useBotPreferences(environmentId);
  return (
    <SettingsRow
      {...searchableSetting("ui-language")}
      description={t("Bots, You and these settings. Changing it reloads the page.")}
      control={
        <Select
          value={choice}
          onValueChange={(value) => {
            const picked = LANGUAGE_CHOICES.find((option) => option === value);
            if (picked === undefined || picked === choice) return;
            if (picked === "browser") return setUiLanguageChoice(picked);
            void savePreferences({ language: picked })
              .catch(() => undefined)
              .finally(() => setUiLanguageChoice(picked));
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={t("Language")}>
            <SelectValue>{languageLabel(choice)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {LANGUAGE_CHOICES.map((option) => (
              <SelectItem key={option} hideIndicator value={option}>
                {languageLabel(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const EXPERIENCE = {
  new: "New to them",
  experienced: "Know them",
} as const satisfies Record<NonNullable<BotPreferences["experience"]>, UiText>;

function ExperienceSetting() {
  const environmentId = usePrimaryEnvironmentId();
  const [preferences, savePreferences] = useBotPreferences(environmentId);
  const current = preferences?.experience;
  return (
    <SettingsRow
      {...searchableSetting("bots-experience")}
      description={t("The main bot explains more to someone new.")}
      control={
        <Select
          value={current ?? ""}
          onValueChange={(value) => {
            const picked = value === "new" || value === "experienced" ? value : undefined;
            if (picked && picked !== current) void savePreferences({ experience: picked });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("Experience with AI agents")}
          >
            <SelectValue>{current ? t(EXPERIENCE[current]) : t("Not set")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(["new", "experienced"] as const).map((option) => (
              <SelectItem key={option} hideIndicator value={option}>
                {t(EXPERIENCE[option])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const TIME_ZONES = Intl.supportedValuesOf("timeZone");

function TimeZoneSetting() {
  const environmentId = usePrimaryEnvironmentId();
  const [preferences, savePreferences] = useBotPreferences(environmentId);
  const current = preferences?.timeZone;
  const zones =
    current === undefined || TIME_ZONES.includes(current) ? TIME_ZONES : [current, ...TIME_ZONES];
  return (
    <SettingsRow
      {...searchableSetting("bots-time-zone")}
      description={t("Schedules, the nightly check and bots' clocks use it.")}
      control={
        <Select
          value={current ?? ""}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== "" && value !== current)
              void savePreferences({ timeZone: value }).catch(() => undefined);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={t("Time zone")}>
            <SelectValue>{current ?? t("Not set")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {zones.map((zone) => (
              <SelectItem key={zone} hideIndicator value={zone}>
                {zone}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ZdrSetting() {
  const environmentId = usePrimaryEnvironmentId();
  const [state, setState] = useZdrState(environmentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!environmentId || !state) return null;

  const models = state.models.map((model) => `${model.name} (${model.route})`).join(", ");
  const set = async (enabled: boolean) => {
    if (!enabled) {
      const confirmed = await (readLocalApi()?.dialogs.confirm(
        t(
          "Turn zero data retention off?\nBots can then call models and services that keep or log what they are sent.",
        ),
        { variant: "destructive", confirmLabel: t("Turn off") },
      ) ?? Promise.resolve(false));
      if (!confirmed) return;
    }
    setBusy(true);
    setError(null);
    try {
      setState(
        await botRequest(environmentId, BOTS_ENDPOINTS.setZdr, {
          enabled,
          ...(enabled ? {} : { confirmOff: true }),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Try again."));
    }
    setBusy(false);
  };
  const check = state.lastCheck;
  const lines = state.enabled
    ? [
        t(
          "On: bots call only {models}. Other models, cloud voice and work on linked machines are refused.",
          { models },
        ),
        ...state.models.flatMap((model) =>
          model.blocked === null
            ? []
            : [t("{model} is blocked: {reason}", { model: model.name, reason: model.blocked })],
        ),
        check === null
          ? null
          : check.ok
            ? t("Checked {time}: {summary}", {
                time: messageTimeLabel(Date.parse(check.at)),
                summary: check.summary,
              })
            : t("The last check failed {time}: {summary}", {
                time: messageTimeLabel(Date.parse(check.at)),
                summary: check.summary,
              }),
      ]
    : [t("Off: bots may call any model. On allows only {models}.", { models })];
  return (
    <SettingsRow
      {...searchableSetting("zero-data-retention")}
      description={[error, ...lines].filter(Boolean).join(" ")}
      control={
        <Switch
          checked={state.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => void set(enabled)}
          aria-label={t("Zero data retention")}
        />
      }
    />
  );
}

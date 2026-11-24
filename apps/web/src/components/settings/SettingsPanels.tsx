import { NotificationSettings } from "./NotificationSettings";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { Link } from "@tanstack/react-router";
import { IDLE_COMPACTION_MODES, globalIdleCompaction } from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type ResponseStreamingMode,
  ScreenReaderAnnouncements,
  ToolCallVisibility,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { AboutVersionTitle } from "./AboutVersionTitle";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { scopedIdleCompaction } from "./scopedSettings";
import { managedTelemetryOffMessage, usePrimaryManagedPolicy } from "../../state/managedPolicy";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BotSettingsSection } from "../../bots/BotSettings";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { nativeLanguageName, SYSTEM_LANGUAGE } from "@t3tools/client-runtime/locales";
import { SUPPORTED_LOCALES } from "../../i18n/locales";
import { BackgroundActivitySettingsRow } from "./BackgroundActivitySettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { StorageCleanupSections } from "./StorageSettings";

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
};

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
};

const TIMESTAMP_FORMAT_LABELS = {
  locale: msg("System default"),
  "12-hour": msg("12-hour"),
  "24-hour": msg("24-hour"),
};

function AboutVersionSection() {
  return (
    <SettingsRow
      id={searchableSetting("app-version").id}
      title={<AboutVersionTitle />}
      description="Current version of the application."
    />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!followSystem ? ["Follow system"] : []),
    ...(themeHalves !== null ? ["Theme mix"] : []),
    ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
      ? ["Contrast"]
      : []),
    ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
    ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
      ? ["Diff colors"]
      : []),
    ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),
    ...(settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay
      ? ["Effort display"]
      : []),
    ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
      ? ["Render math"]
      : []),
    ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
      ? ["Panel animations"]
      : []),
    ...(settings.environmentIdentificationMode !==
    DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
      ? ["Environment identification"]
      : []),
    ...(settings.language !== DEFAULT_UNIFIED_SETTINGS.language ? ["Language"] : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
      ? ["Time format"]
      : []),
    ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
      ? ["Thread notifications"]
      : []),
    ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
      ? ["In-app notifications"]
      : []),
    ...(settings.sidebarProjectGroupingMode !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
      ? ["Project Grouping"]
      : []),
    ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
      ? ["Project order"]
      : []),
    ...(settings.sidebarWorkingShelfEnabled !== DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
      ? ["Working section"]
      : []),
    ...(settings.sidebarAutoSettleAfterDays !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
      ? ["Auto-settle inactive threads"]
      : []),
    ...(settings.sidebarAutoSettleKeepPullRequests !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
      ? ["Keep threads with a PR"]
      : []),
    ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
      ? ["Auto-settle merged threads"]
      : []),
    ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
      ? ["Resume after usage limits"]
      : []),
    ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
      ? ["Snooze until limits reset"]
      : []),
    ...(!Equal.equals(settings.snoozePresets, DEFAULT_UNIFIED_SETTINGS.snoozePresets)
      ? ["Snooze options"]
      : []),
    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
    ...(settings.persistComposerContextStrip !==
    DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
      ? ["Composer context"]
      : []),
    ...getChangedTypographySettingLabels(settings),
    ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
      ? ["Default diff file state"]
      : []),
    ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
      ? ["Diff whitespace changes"]
      : []),
    ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? ["Diff layout"] : []),
    ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
      ? ["Open pull requests and changes panels proactively"]
      : []),
    ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
      ? ["Show skills in slash menu"]
      : []),
    ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
      ? ["Rich text composer"]
      : []),
    ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ["Send shortcut"] : []),
    ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
      ? ["Follow-up behavior"]
      : []),
    ...(settings.toolCallVisibility !== DEFAULT_UNIFIED_SETTINGS.toolCallVisibility
      ? ["Tool calls in chat"]
      : []),
    ...(settings.screenReaderAnnouncements !== DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements
      ? ["Screen reader announcements"]
      : []),
    ...(settings.screenReaderWindowTitle !== DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle
      ? ["Screen reader window title"]
      : []),
    ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
      ? ["Response streaming"]
      : []),
    ...(settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
      ? ["Provider update checks"]
      : []),
    ...(settings.continueThreadsAfterServerUpdate !==
    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
      ? ["Continue threads after restarts"]
      : []),
    ...(isBackgroundActivityDirty ? ["Background activity"] : []),
    ...(settings.keepAwakeWhileAgentsWork !== DEFAULT_UNIFIED_SETTINGS.keepAwakeWhileAgentsWork
      ? ["Keep awake while agents work"]
      : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? ["New thread mode"]
      : []),
    ...(settings.newWorktreesStartFromOrigin !==
    DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
      ? ["New worktrees start from remote"]
      : []),
    ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
      ? ["Add project base directory"]
      : []),
    ...(settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout
      ? ["Clone into host folders"]
      : []),
    ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
      ? ["Unpin confirmation"]
      : []),
    ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
      ? ["Archive confirmation"]
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
    ...(settings.threadTitleInstructions !== DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions
      ? ["Thread title instructions"]
      : []),
    ...getChangedBrowserSettingLabels(settings),
    ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
      ? ["Agent browser access"]
      : []),
  ];

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Reset only dirty theme keys so storage failures cannot block other settings; re-read after confirmation
    // for safe rollback.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {}
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t restore theme settings",
          description: "Try again.",
        }),
      );
    };
    // Restore the base preference before the mix because restoring the base clears the mix.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay,
      mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
      language: DEFAULT_UNIFIED_SETTINGS.language,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      toolCallVisibility: DEFAULT_UNIFIED_SETTINGS.toolCallVisibility,
      screenReaderAnnouncements: DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements,
      screenReaderWindowTitle: DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      snoozePresets: DEFAULT_UNIFIED_SETTINGS.snoozePresets,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      keepAwakeWhileAgentsWork: DEFAULT_UNIFIED_SETTINGS.keepAwakeWhileAgentsWork,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      threadTitleInstructions: DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
      browserCustomSearchUrl: DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    });
    onRestored?.();
  };

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

/** Row anchor props with the registry title in the active language. */
function useTranslatedSearchableSetting() {
  const m = useMessages();
  return (id: SettingsSearchItemId) => {
    const setting = searchableSetting(id);
    return { ...setting, title: m(setting.title) };
  };
}

export function GeneralSettingsPanel() {
  const gt = useGT();
  const m = useMessages();
  const setting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const languageValue = SUPPORTED_LOCALES.includes(settings.language)
    ? settings.language
    : SYSTEM_LANGUAGE;

  return (
    <SettingsPageContainer>
      <BotSettingsSection />
      <SettingsSection id="notifications" title={gt("Notifications")}>
        <NotificationSettings />
        <SettingsRow
          {...setting("in-app-notifications")}
          description="A toast in this app when another thread finishes, fails or needs you."
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label={gt("In-app notifications")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title={gt("Confirmations")}>
        <SettingsRow
          {...setting("unpin-confirmation")}
          description={<T>Ask before unpinning a thread from the pinned section.</T>}
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="unpin confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label={gt("Confirm thread unpinning")}
            />
          }
        />
        <SettingsRow
          {...setting("archive-confirmation")}
          description={
            <T>Require a second click on the inline archive action before a thread is archived.</T>
          }
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label={gt("Confirm thread archiving")}
            />
          }
        />
        <SettingsRow
          {...setting("delete-confirmation")}
          description={<T>Ask before deleting a thread and its chat history.</T>}
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label={gt("Confirm thread deletion")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="display" title={gt("Display")}>
        <SettingsRow
          {...setting("language")}
          description={<T>System default follows your browser or OS language.</T>}
          resetAction={
            settings.language !== DEFAULT_UNIFIED_SETTINGS.language ? (
              <SettingResetButton
                label="language"
                onClick={() =>
                  updateSettings({
                    language: DEFAULT_UNIFIED_SETTINGS.language,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={languageValue}
              onValueChange={(value) => {
                if (value) {
                  updateSettings({ language: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Language")}>
                <SelectValue>
                  {languageValue === SYSTEM_LANGUAGE
                    ? m(TIMESTAMP_FORMAT_LABELS.locale)
                    : nativeLanguageName(languageValue)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={SYSTEM_LANGUAGE}>
                  {m(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                {SUPPORTED_LOCALES.map((locale) => (
                  <SelectItem hideIndicator key={locale} value={locale}>
                    {nativeLanguageName(locale)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...setting("time-format")}
          description={<T>System default follows your browser or OS clock preference.</T>}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={gt("Timestamp format")}
              >
                <SelectValue>{m(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {m(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {m(TIMESTAMP_FORMAT_LABELS["12-hour"])}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {m(TIMESTAMP_FORMAT_LABELS["24-hour"])}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ChatSettingsPanel() {
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection id="composer" title="Composer">
        <SettingsRow
          {...searchableSetting("composer-rich-text")}
          description="Show formatted Markdown as you type."
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="rich text composer"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="Rich text composer"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("send-shortcut")}
          description="Choose when Enter sends a prompt or inserts a new line"
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label="send shortcut"
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value);
                if (option) updateSettings({ sendShortcut: option.value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label="Send shortcut"
              >
                <SelectValue>
                  {
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sendShortcutOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <AdvancedSettings targetIds={[searchableSetting("skills-in-slash-menu").id]}>
          <SettingsRow
            {...searchableSetting("skills-in-slash-menu")}
            description="Also include skills in the / command menu. Skills always appear when you type $."
            resetAction={
              settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
                <SettingResetButton
                  label="skills in slash menu"
                  onClick={() =>
                    updateSettings({
                      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showSkillsInSlashMenu}
                onCheckedChange={(checked) =>
                  updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
                }
                aria-label="Show skills in slash menu"
              />
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <SettingsSection id="follow-ups" title="Follow-ups">
        <SettingsRow
          {...searchableSetting("follow-up-behavior")}
          description={
            "Queue follow-ups while the agent runs or steer the current run. " +
            (settings.sendShortcut === "mod-enter-multiline"
              ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
              : `Press ${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`)
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="follow-up behavior"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Follow-up behavior">
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "Queue" : "Steer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">Queue</SelectItem>
                <SelectItem value="steer">Steer</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="activity" title="Activity">
        <ToolCallVisibilityRow />
        <ResponseStreamingRow />
        <PromptSuggestionsRow />
      </SettingsSection>

      <SettingsSection id="screen-reader" title="Screen reader">
        <ScreenReaderAnnouncementsRow />
        <ScreenReaderWindowTitleRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const TOOL_CALL_VISIBILITY_LABELS: Record<ToolCallVisibility, string> = {
  showAll: "Show all",
  hideSuccessful: "Hide successful",
  hideAll: "Hide all",
  zen: "Zen",
};

const isToolCallVisibility = Schema.is(ToolCallVisibility);

function ToolCallVisibilityRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("tool-call-visibility")}
      description="Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions, and errors always show."
      resetAction={
        settings.toolCallVisibility !== DEFAULT_UNIFIED_SETTINGS.toolCallVisibility ? (
          <SettingResetButton
            label="tool calls in chat"
            onClick={() =>
              updateSettings({ toolCallVisibility: DEFAULT_UNIFIED_SETTINGS.toolCallVisibility })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.toolCallVisibility}
          onValueChange={(value) => {
            if (isToolCallVisibility(value)) updateSettings({ toolCallVisibility: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Tool calls in chat">
            <SelectValue>{TOOL_CALL_VISIBILITY_LABELS[settings.toolCallVisibility]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ToolCallVisibility.literals.map((value) => (
              <SelectItem key={value} value={value}>
                {TOOL_CALL_VISIBILITY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const SCREEN_READER_ANNOUNCEMENTS_LABELS: Record<ScreenReaderAnnouncements, string> = {
  status: "Status only",
  messages: "Status and messages",
  everything: "Everything",
};

const isScreenReaderAnnouncements = Schema.is(ScreenReaderAnnouncements);

function ScreenReaderAnnouncementsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("screen-reader-announcements")}
      description="What a screen reader hears from the open thread: a turn starting, needing you, and ending. Status and messages adds what the agent writes before its last message. Everything adds each step."
      resetAction={
        settings.screenReaderAnnouncements !==
        DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements ? (
          <SettingResetButton
            label="screen reader announcements"
            onClick={() =>
              updateSettings({
                screenReaderAnnouncements: DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.screenReaderAnnouncements}
          onValueChange={(value) => {
            if (isScreenReaderAnnouncements(value)) {
              updateSettings({ screenReaderAnnouncements: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-48"
            aria-label="Screen reader announcements"
          >
            <SelectValue>
              {SCREEN_READER_ANNOUNCEMENTS_LABELS[settings.screenReaderAnnouncements]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ScreenReaderAnnouncements.literals.map((value) => (
              <SelectItem key={value} value={value}>
                {SCREEN_READER_ANNOUNCEMENTS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ScreenReaderWindowTitleRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("screen-reader-window-title")}
      description="Start the window title with the thread's status, like Needs approval, and its name, so screen readers read them first when you switch apps. Taskbars, shared screens, and time trackers see it too."
      resetAction={
        settings.screenReaderWindowTitle !== DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle ? (
          <SettingResetButton
            label="screen reader window title"
            onClick={() =>
              updateSettings({
                screenReaderWindowTitle: DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.screenReaderWindowTitle}
          onCheckedChange={(checked) => updateSettings({ screenReaderWindowTitle: checked })}
          aria-label="Screen reader window title"
        />
      }
    />
  );
}

export function CompactIdleThreadsRow() {
  return useOptionalSettingsScope() === null ? null : <ScopedCompactIdleThreadsRow />;
}

function ScopedCompactIdleThreadsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["idleCompaction", "compactIdleThreads"]}
      mixed={idleCompaction.mixed}
      {...searchableSetting("compact-idle-threads")}
      description="When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this."
      resetAction={
        globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
          <SettingResetButton
            label="compact idle threads"
            onClick={() =>
              updateSettings({ idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) })
            }
          />
        ) : null
      }
      control={
        <Select
          value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
          onValueChange={(value) => {
            const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
            if (mode) updateSettings({ idleCompaction: mode.value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Compact idle threads">
            <SelectValue>
              {(value: string | null) =>
                value === null
                  ? "Mixed"
                  : IDLE_COMPACTION_MODES.find((mode) => mode.value === value)?.label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {IDLE_COMPACTION_MODES.map((mode) => (
              <SelectItem
                hideIndicator
                key={mode.value}
                value={mode.value}
                // A server from before modes has only the on/off switch, so it cannot store "Never".
                disabled={mode.value === "off" && !idleCompaction.neverAvailable}
              >
                {mode.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function PromptSuggestionsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description="Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude chats update on restart."
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label="Suggest next prompt"
        />
      }
    />
  );
}

function ResponseStreamingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["responseStreamingMode"]}
      {...searchableSetting("response-streaming")}
      description={
        mixedResponseStreamingMode
          ? "The selected targets use different streaming modes."
          : RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode]
      }
      resetAction={
        settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
          <SettingResetButton
            label="response streaming"
            onClick={() =>
              updateSettings({
                responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
          onValueChange={(value) => {
            if (value === "turn" || value === "paragraph") {
              updateSettings({ responseStreamingMode: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Response streaming">
            <SelectValue>
              {(value: ResponseStreamingMode | null) =>
                value === null ? "Mixed" : RESPONSE_STREAMING_MODE_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="turn">
              {RESPONSE_STREAMING_MODE_LABELS.turn}
            </SelectItem>
            <SelectItem hideIndicator value="paragraph">
              {RESPONSE_STREAMING_MODE_LABELS.paragraph}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function MaintenanceSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;

  return (
    <SettingsPageContainer>
      <SettingsSection id="updates" title="Updates">
        <SettingsRow
          serverScoped
          settingKeys={["enableProviderUpdateChecks"]}
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableProviderUpdateChecks"]}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments."
          status={
            !hasServerTargets
              ? "All selected connected environments must support restart continuation."
              : undefined
          }
          resetAction={
            hasServerTargets &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="continue threads after restarts"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!hasServerTargets}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="Continue threads after restarts"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="background" title="Background activity">
        <BackgroundActivitySettingsRow />
        <SettingsRow
          serverScoped
          settingKeys={["keepAwakeWhileAgentsWork"]}
          {...searchableSetting("keep-awake-while-agents-work")}
          description="Stop the computer from going to sleep while agents are working, and let it sleep once they finish. Closing a laptop lid still puts it to sleep."
          resetAction={
            settings.keepAwakeWhileAgentsWork !==
            DEFAULT_UNIFIED_SETTINGS.keepAwakeWhileAgentsWork ? (
              <SettingResetButton
                label="keep awake while agents work"
                onClick={() =>
                  updateSettings({
                    keepAwakeWhileAgentsWork: DEFAULT_UNIFIED_SETTINGS.keepAwakeWhileAgentsWork,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["keepAwakeWhileAgentsWork"]}
              checked={settings.keepAwakeWhileAgentsWork}
              onCheckedChange={(checked) =>
                updateSettings({ keepAwakeWhileAgentsWork: Boolean(checked) })
              }
              aria-label="Keep awake while agents work"
            />
          }
        />
      </SettingsSection>

      <StorageCleanupSections />

      <SettingsSection id="diagnostics-section" title="Diagnostics">
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={
            isEnvironmentScope
              ? "Inspect processes, resource use, and logs on this environment."
              : "Inspect processes, resource use, and logs on one environment at a time."
          }
          control={
            <Button
              render={
                <Link to="/settings/diagnostics" search={{ machine: environmentId ?? undefined }} />
              }
              size="sm"
              variant="outline"
            >
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function AboutSettingsPanel() {
  const phone = useMediaQuery("max-md");
  const primaryPolicy = usePrimaryManagedPolicy();
  const telemetryOff = managedTelemetryOffMessage(primaryPolicy);
  return (
    <SettingsPageContainer>
      <SettingsSection id="about" title="App">
        {primaryPolicy ? (
          <SettingsRow
            title="Organization"
            description={`This environment is managed by ${primaryPolicy.organization}. Some settings and features follow its policy.`}
            control={
              primaryPolicy.supportUrl ? (
                <Button
                  render={
                    <a href={primaryPolicy.supportUrl} target="_blank" rel="noreferrer noopener" />
                  }
                  size="sm"
                  variant="outline"
                >
                  Get help
                </Button>
              ) : null
            }
          />
        ) : null}
        <AboutVersionSection />
      </SettingsSection>

      <SettingsSection id="legal" title="Legal">
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          {...(phone
            ? {
                title: (
                  <a
                    data-settings-row-link
                    href={PRIVACY_POLICY_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {searchableSetting("privacy-policy").title}
                    <ChevronRightIcon aria-hidden />
                  </a>
                ),
              }
            : {})}
          description={
            telemetryOff === undefined
              ? "How we handle your data, including the anonymous usage data rejects collects."
              : `How we handle your data. ${telemetryOff}`
          }
          control={
            phone ? undefined : (
              <Button
                render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
                size="sm"
                variant="outline"
              >
                View policy
              </Button>
            )
          }
        />
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          {...(phone
            ? {
                title: (
                  <Link data-settings-row-link to="/settings/open-source-licenses">
                    {searchableSetting("open-source-licenses").title}
                    <ChevronRightIcon aria-hidden />
                  </Link>
                ),
              }
            : {})}
          description="Notices for dependencies, assets, and optional tools used by rejects."
          control={
            phone ? undefined : (
              <Button
                render={<Link to="/settings/open-source-licenses" />}
                size="sm"
                variant="outline"
              >
                View licenses
              </Button>
            )
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

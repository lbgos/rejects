import {
  BOTS_ENDPOINTS,
  type EnvironmentId,
  type MemoryChange,
  type MemoryDreams,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import {
  ProviderModelPicker,
  RESTING_PROVIDER_ICON_CLASSNAME,
} from "../components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Switch } from "../components/ui/switch";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { plural, t, type UiText } from "../i18n";
import { cn } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";
import { EMPTY_NOTE, ROW_META, ROW_TEXT, SECTION_HEADER, SHEET_LIST } from "./panelStyles";
import { formatWakeIn, messageTimeLabel } from "./presentation";
import { notesChanged, readBots, refreshBots } from "./state";

const OP_LABEL: Record<MemoryChange["op"], UiText> = {
  confirm: "Kept",
  rewrite: "Corrected",
  merge: "Merged",
  stale: "Marked stale",
  contradicted: "Marked contradicted",
  delete: "Deleted",
  expire: "Expired",
  add: "Added",
  pin: "Pinned",
  unpin: "Unpinned",
};

const COUNT_TEXT: Record<MemoryChange["op"] | "refused", UiText> = {
  confirm: "{count} confirmed",
  rewrite: "{count} corrected",
  merge: "{count} merged",
  stale: "{count} marked stale",
  contradicted: "{count} marked contradicted",
  delete: "{count} deleted",
  expire: "{count} expired",
  add: "{count} added",
  pin: "{count} pinned",
  unpin: "{count} unpinned",
  refused: "{count} refused",
};

/** The last run's result in the UI language; runs from before the server kept counts show its English line. */
const runSummary = (lastRun: NonNullable<MemoryDreams["lastRun"]>) => {
  const { counts } = lastRun;
  if (counts === undefined) return lastRun.summary;
  const parts = Object.entries(COUNT_TEXT).flatMap(([key, text]) =>
    counts[key] === undefined ? [] : [t(text, { count: counts[key] })],
  );
  if (counts.skills !== undefined)
    parts.push(
      plural(counts.skills, {
        en: ["{count} skill written", "{count} skills written"],
        uk: ["записано навичок: {count}", "записано навичок: {count}", "записано навичок: {count}"],
        ru: ["записано навыков: {count}", "записано навыков: {count}", "записано навыков: {count}"],
      }),
    );
  return parts.length > 0 ? parts.join(", ") : t("No changes");
};

const ROW = "flex items-center gap-3 px-4 py-2.5 max-md:px-5 max-md:py-2.75";

function failed(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : t("Try again."),
    }),
  );
}

/** Notes change on the server after a run or an undo; every screen showing them reads them again. */
function refreshNotes(environmentId: EnvironmentId) {
  notesChanged(environmentId);
  void refreshBots(environmentId).catch(() => undefined);
}

export function NightlyCheck({ environmentId }: { environmentId: EnvironmentId }) {
  const [dreams, setDreams] = useState<MemoryDreams | null>(null);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const running = dreams?.running ?? false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the check's state on open, and every few seconds while a run is going
  useEffect(() => {
    if (!connected) return;
    let open = true;
    const read = () =>
      botRequest(environmentId, BOTS_ENDPOINTS.dreams, {})
        .then((next) => {
          if (!open) return;
          setDreams(next);
          if (running && !next.running) refreshNotes(environmentId);
        })
        .catch(() => undefined);
    void read();
    const timer = running ? window.setInterval(read, 3000) : undefined;
    return () => {
      open = false;
      window.clearInterval(timer);
    };
  }, [environmentId, connected, running]);

  const act = (request: Promise<MemoryDreams>, title: string) =>
    request.then(
      (next) => {
        setDreams(next);
        return true;
      },
      (error: unknown) => {
        failed(title, error);
        return false;
      },
    );
  const lastRun = dreams?.lastRun;
  const errors = lastRun?.errors ?? [];
  const status = running
    ? t("Checking now")
    : [
        dreams?.enabled && dreams.nextRunAt
          ? t("Next {time}", { time: formatWakeIn(dreams.nextRunAt) })
          : t("Off"),
        lastRun
          ? t("last {time}: {summary}", {
              time: messageTimeLabel(Date.parse(lastRun.at)),
              summary: runSummary(lastRun),
            })
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const bots = readBots(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const selection =
    dreams === null ? null : (dreams.modelSelection ?? dreams.fallbackModelSelection);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const setModel = (modelSelection: MemoryDreams["modelSelection"]) =>
    void act(
      botRequest(environmentId, BOTS_ENDPOINTS.setDreams, { modelSelection }),
      t("Could not change the check's model"),
    );
  const owner = (change: MemoryChange) =>
    change.threadId === undefined
      ? t("You")
      : (bots.find((bot) => bot.threadId === change.threadId)?.name ?? t("A removed bot"));

  return (
    <section>
      <h3 className={SECTION_HEADER}>{t("Nightly check")}</h3>
      <ul className={SHEET_LIST}>
        <li className={ROW}>
          <div className="min-w-0 flex-1">
            <div className={ROW_TEXT}>{t("Every night")}</div>
            <div className={cn("line-clamp-2", ROW_META)}>{dreams ? status : t("Loading…")}</div>
          </div>
          <Button
            variant="ghost"
            size="xs"
            disabled={!dreams || running}
            onClick={() =>
              void act(
                botRequest(environmentId, BOTS_ENDPOINTS.dreamNow, {}),
                t("Could not start the check"),
              )
            }
          >
            {t("Run now")}
          </Button>
          <Switch
            aria-label={t("Check notes every night")}
            checked={dreams?.enabled ?? false}
            disabled={!dreams}
            onCheckedChange={(enabled) =>
              void act(
                botRequest(environmentId, BOTS_ENDPOINTS.setDreams, { enabled }),
                t("Could not change the nightly check"),
              )
            }
          />
        </li>
        <li className={cn(ROW, "flex-wrap gap-y-2")}>
          <div className={cn("min-w-0 flex-1", ROW_TEXT)}>{t("Model")}</div>
          {dreams?.modelSelection ? (
            <Button variant="ghost" size="xs" onClick={() => setModel(null)}>
              {t("Reset")}
            </Button>
          ) : null}
          {selection ? (
            <div data-bot-model-field className="w-full min-w-0 md:w-auto">
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={running}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                activeProviderIconClassName={RESTING_PROVIDER_ICON_CLASSNAME}
                triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full max-md:w-full")}
                onInstanceModelChange={(instanceId, model) => setModel({ instanceId, model })}
              />
            </div>
          ) : null}
        </li>
        {errors.length > 0 ? (
          <li>
            {/* One line for the whole run; what failed is a tap away. */}
            <Collapsible>
              <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent max-md:px-5 max-md:py-2.75 max-md:hover:bg-transparent">
                <span
                  className={cn(
                    "min-w-0 flex-1",
                    ROW_META,
                    running ? "text-muted-foreground" : "text-destructive-foreground",
                  )}
                >
                  {running ? `${t("Last check")}: ` : null}
                  {plural(errors.length, {
                    en: ["{count} check did not finish", "{count} checks did not finish"],
                    uk: [
                      "{count} перевірка не завершилася",
                      "{count} перевірки не завершилися",
                      "{count} перевірок не завершилося",
                    ],
                    ru: [
                      "{count} проверка не завершилась",
                      "{count} проверки не завершились",
                      "{count} проверок не завершилось",
                    ],
                  })}
                </span>
                <span className={cn("shrink-0", ROW_META)}>{t("Details")}</span>
              </CollapsibleTrigger>
              <CollapsiblePanel animate={false}>
                <ul className={cn("space-y-1 px-4 pb-3 max-md:px-5", ROW_META)}>
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </CollapsiblePanel>
            </Collapsible>
          </li>
        ) : null}
        {dreams?.changes.map((change) => {
          const removed = change.after.length === 0;
          const shown = removed ? change.before : change.after;
          const was =
            change.op === "rewrite" || change.op === "merge"
              ? t("was {notes}", {
                  notes: change.before.map((note) => `“${note.text}”`).join(", "),
                })
              : null;
          return (
            <li key={change.id} className={ROW}>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "break-words",
                    ROW_TEXT,
                    removed && "text-muted-foreground line-through",
                  )}
                >
                  {shown.map((note) => note.text).join(" / ")}
                </div>
                <div className={cn("line-clamp-3 break-words", ROW_META)}>
                  {[
                    t(OP_LABEL[change.op]),
                    owner(change),
                    messageTimeLabel(Date.parse(change.at)),
                    change.reason,
                    was,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              {change.undone ? (
                <span className={ROW_META}>{t("Undone")}</span>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void act(
                      botRequest(environmentId, BOTS_ENDPOINTS.undoDream, { id: change.id }),
                      t("Could not undo the change"),
                    ).then((done) => {
                      if (done) refreshNotes(environmentId);
                    })
                  }
                >
                  {t("Undo")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {dreams && dreams.changes.length === 0 ? (
        <p className={EMPTY_NOTE}>{t("Merges repeats and marks outdated notes.")}</p>
      ) : null}
    </section>
  );
}

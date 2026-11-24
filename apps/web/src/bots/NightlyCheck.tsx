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
import {
  ACTION_ROW,
  EMPTY_NOTE,
  ROW_META,
  ROW_TEXT,
  SECTION_HEADER,
  SHEET_LIST,
} from "./panelStyles";
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

/** The page shows the latest few changes; the rest are one press away. */
const CHANGES_SHOWN = 3;

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
  const [allChanges, setAllChanges] = useState(false);
  const [openChange, setOpenChange] = useState<string | null>(null);
  const changes = dreams?.changes ?? [];
  const errors = lastRun?.errors ?? [];
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
            {dreams?.enabled && dreams.nextRunAt ? (
              <div className={ROW_META}>
                {t("Next {time}", { time: formatWakeIn(dreams.nextRunAt) })}
              </div>
            ) : null}
          </div>
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
        {lastRun ? (
          <li className={ROW}>
            {/* The outcome has the row's width; only the time shares the label's line. */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className={ROW_TEXT}>{t("Last check")}</span>
                <span className={cn("shrink-0", ROW_META)}>
                  {messageTimeLabel(Date.parse(lastRun.at))}
                </span>
              </div>
              <div className={cn("break-words", ROW_META)}>{runSummary(lastRun)}</div>
            </div>
          </li>
        ) : null}
        <li className={ROW}>
          <div className="min-w-0 flex-1">
            <div className={ROW_TEXT}>{t("Model")}</div>
            {/* Only a model that differs from the server's own can be reset to it. */}
            {dreams?.modelSelection &&
            (dreams.modelSelection.instanceId !== dreams.fallbackModelSelection.instanceId ||
              dreams.modelSelection.model !== dreams.fallbackModelSelection.model) ? (
              <button
                type="button"
                // Not ROW_META: its muted colour would win over the action colour.
                className="text-bot-footnote text-bot-action outline-none hover:underline max-md:text-bot-callout"
                onClick={() => setModel(null)}
              >
                {t("Use the default")}
              </button>
            ) : null}
          </div>
          {selection ? (
            <div data-bot-model-field className="min-w-0">
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
                triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full")}
                onInstanceModelChange={(instanceId, model) => setModel({ instanceId, model })}
              />
            </div>
          ) : null}
        </li>
        <li>
          <button
            type="button"
            disabled={!dreams || running}
            className={cn(ACTION_ROW, ROW_TEXT)}
            onClick={() =>
              void act(
                botRequest(environmentId, BOTS_ENDPOINTS.dreamNow, {}),
                t("Could not start the check"),
              )
            }
          >
            {running ? t("Checking now") : t("Run now")}
          </button>
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
                    // A check that is switched off or running again raises no alarm about the last one.
                    running || !dreams?.enabled
                      ? "text-muted-foreground"
                      : "text-destructive-foreground",
                  )}
                >
                  {running || !dreams?.enabled ? `${t("Last check")}: ` : null}
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
      </ul>
      {/* What the check changed is a list of its own, apart from the check's controls. */}
      {dreams && dreams.changes.length > 0 ? (
        <>
          <h3 className={SECTION_HEADER}>{t("Recent changes")}</h3>
          <ul className={SHEET_LIST}>
            {(allChanges ? changes : changes.slice(0, CHANGES_SHOWN)).map((change) => {
              const removed = change.after.length === 0;
              const shown = removed ? change.before : change.after;
              const before = change.op === "rewrite" || change.op === "merge" ? change.before : [];
              const hasDetail = Boolean(change.reason) || before.length > 0;
              const open = openChange === change.id;
              const summary = (
                <>
                  <div
                    className={cn(
                      "break-words",
                      ROW_TEXT,
                      removed && "text-muted-foreground line-through",
                    )}
                  >
                    {shown.map((note) => note.text).join(" / ")}
                  </div>
                  <div className={cn("truncate", ROW_META)}>
                    {[
                      t(OP_LABEL[change.op]),
                      owner(change),
                      messageTimeLabel(Date.parse(change.at)),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </>
              );
              return (
                <li key={change.id} data-memory-change className={ROW}>
                  <div className="min-w-0 flex-1">
                    {/* A change is its note and one line of facts; why, and what the note was, open
                        on a press. */}
                    {hasDetail ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        className="block w-full min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={() => setOpenChange(open ? null : change.id)}
                      >
                        {summary}
                      </button>
                    ) : (
                      summary
                    )}
                    {open ? (
                      <div className={cn("mt-1.5 space-y-1 break-words", ROW_META)}>
                        {change.reason ? <p>{change.reason}</p> : null}
                        {before.map((note) => (
                          <p key={note.text}>{t("Was: {note}", { note: `“${note.text}”` })}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {change.undone ? (
                    <span className={cn("shrink-0", ROW_META)}>{t("Undone")}</span>
                  ) : (
                    <button
                      type="button"
                      // Its label ends on the row's trailing edge, where "Undone" ends.
                      className={cn(
                        "-me-2 shrink-0 rounded-md px-2 py-1 text-bot-action outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:min-h-11",
                        ROW_TEXT,
                      )}
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
                    </button>
                  )}
                </li>
              );
            })}
            {changes.length > CHANGES_SHOWN ? (
              <li>
                <button
                  type="button"
                  className={cn(ACTION_ROW, ROW_TEXT)}
                  onClick={() => setAllChanges(!allChanges)}
                >
                  {allChanges ? t("Show fewer") : t("Show all {count}", { count: changes.length })}
                </button>
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
      {dreams && dreams.changes.length === 0 ? (
        <p className={EMPTY_NOTE}>{t("Merges repeats and marks outdated notes.")}</p>
      ) : null}
    </section>
  );
}

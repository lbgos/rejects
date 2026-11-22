import { BotBridgePanel } from "./BotBridgePanel";
import { BotScreenPanel } from "./BotScreenPanel";
import {
  type BotSummary,
  chargedTokens,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import {
  CheckIcon,
  ChevronLeftIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { plural, t, uiLocales, type UiText } from "../i18n";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { useThreadProjection } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadRouteRef } from "../threadRoutes";
import { saveNote, setNote } from "./actions";
import { NightlyCheck } from "./NightlyCheck";
import {
  EMPTY_NOTE,
  FACT_ROW,
  ROW_META,
  ROW_TEXT,
  SECTION_HEADER,
  SECTION_TITLE,
  SHEET_LIST,
} from "./panelStyles";
import { BotDialog } from "./BotDialog";
import { RecordingSteps, useBotRecordings } from "./BotRecordings";
import {
  botScheduleLabel,
  formatTokens,
  formatWakeIn,
  messageTimeLabel,
  noteMeta,
  statusWord,
} from "./presentation";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Input } from "../components/ui/input";
import { NOTES_PAGE, useNotes } from "./notes";
import { useBot } from "./state";
import {
  botPanelOn,
  closeBotDialog,
  closeBotPanel,
  openBotPanel,
  useBotUi,
  type BotPanel,
} from "./ui";
import { nextWakeAt, useScheduledTasks } from "./useBotTasks";
import { menuCollisionPadding } from "../safeArea";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(uiLocales, { hour: "2-digit", minute: "2-digit", hour12: false });

export function BotOverlays() {
  const target = useParams({ strict: false, select: resolveThreadRouteRef });
  const dialog = useBotUi((s) => s.dialog);
  // The sheet belongs to the open bot; navigating to another bot closes it.
  const panel = useBotUi((s) => botPanelOn(s.panel, target));
  return (
    <>
      {target && panel ? <BotSheet target={target} panel={panel} /> : null}
      {dialog ? <BotDialog request={dialog} onClose={closeBotDialog} /> : null}
    </>
  );
}

const PANEL_TITLE: Record<BotPanel, UiText> = {
  schedule: "Schedule",
  activity: "Activity",
  memory: "Memory",
  screen: "Screen",
  bridge: "Bridge",
};
const PANELS = Object.keys(PANEL_TITLE) as BotPanel[];

function BotSheet({ target, panel }: { target: ScopedThreadRef; panel: BotPanel }) {
  const phone = useMediaQuery("max-md");
  const bot = useBot(target.environmentId, target.threadId);
  if (!phone) return null;
  return (
    <Sheet open={bot !== undefined} onOpenChange={(open) => !open && closeBotPanel()}>
      <SheetPopup
        data-bot-surface
        data-bot-page
        showCloseButton={false}
        side="bottom"
        aria-label={bot ? `${bot.name}: ${t(PANEL_TITLE[panel])}` : t("Bot panel")}
      >
        <div className="mt-1 flex h-11 shrink-0 items-center px-2">
          <Button variant="ghost" className="max-w-[70%]" onClick={closeBotPanel}>
            <ChevronLeftIcon />
            <span className="truncate text-bot-body">{bot?.name ?? t("Back")}</span>
          </Button>
        </div>
        <h2 className="shrink-0 px-5 pt-1 pb-1 text-bot-title font-bold">
          {t(PANEL_TITLE[panel])}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto pb-safe">
          <BotPanelContent target={target} panel={panel} />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

export function BotSidePanel({ target }: { target: ScopedThreadRef }) {
  const phone = useMediaQuery("max-md");
  const open = useBotUi((s) => botPanelOn(s.panel, target));
  const bot = useBot(target.environmentId, target.threadId);
  if (phone || !open || !bot) return null;
  return (
    <aside
      data-bot-surface
      aria-label={`${bot.name}: ${t(PANEL_TITLE[open])}`}
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-s bg-background",
        open === "screen" ? "w-2xl" : "w-md",
      )}
    >
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b ps-3 pe-2">
        <ToggleGroup
          aria-label={t("Bot panel")}
          className="min-w-0 flex-1 *:flex-1"
          value={[open]}
          onValueChange={(values) => {
            const next = PANELS.find((id) => id === values[0]);
            if (next) openBotPanel(target, next);
          }}
        >
          {PANELS.map((id) => (
            <Toggle key={id} value={id}>
              {t(PANEL_TITLE[id])}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button size="icon-xs" variant="ghost" aria-label={t("Close")} onClick={closeBotPanel}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <BotPanelContent target={target} panel={open} />
      </div>
    </aside>
  );
}

function BotPanelContent({ target, panel }: { target: ScopedThreadRef; panel: BotPanel }) {
  return panel === "schedule" ? (
    <SchedulePanel target={target} />
  ) : panel === "activity" ? (
    <ActivityPanel target={target} />
  ) : panel === "memory" ? (
    <MemoryPanel target={target} />
  ) : panel === "bridge" ? (
    <BotBridgePanel target={target} />
  ) : (
    <BotScreenPanel target={target} />
  );
}

function SchedulePanel({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  const tasks = useScheduledTasks(target.environmentId).filter(
    (task) => task.threadId === target.threadId,
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: true,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: true });
  const next = nextWakeAt(tasks);
  return (
    <>
      {bot ? (
        <ul className={SHEET_LIST}>
          <li className={FACT_ROW}>
            <span className={ROW_TEXT}>{t("Tokens today")}</span>
            <span className={ROW_META}>
              {formatTokens(bot.tokensToday)} / {formatTokens(bot.dailyTokenCap)}
            </span>
          </li>
          {next ? (
            <li className={FACT_ROW}>
              <span className={ROW_TEXT}>{t("Next wake")}</span>
              <span className={ROW_META}>{formatWakeIn(next)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      <h3 className={SECTION_HEADER}>{t("Schedules")}</h3>
      {tasks.length === 0 ? (
        <p className={EMPTY_NOTE}>
          {bot
            ? t("No schedules. Ask {bot} to create one.", { bot: bot.name })
            : t("No schedules. Ask the bot to create one.")}
        </p>
      ) : (
        <ul className={SHEET_LIST}>
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 pe-4 max-md:pe-5">
              {/* The row opens its actions; the switch stays separate. */}
              <Menu>
                <MenuTrigger
                  aria-label={t("Actions for {name}", { name: task.title })}
                  render={
                    <button
                      type="button"
                      className="min-w-0 flex-1 py-2.5 ps-4 text-left outline-none hover:bg-accent max-md:ps-5 max-md:hover:bg-transparent"
                    />
                  }
                >
                  <div className={cn("truncate", ROW_TEXT)}>{task.title}</div>
                  <div className={cn("truncate", ROW_META)}>
                    {botScheduleLabel(task.schedule)} ·{" "}
                    {t("last {run}", {
                      run: task.lastRunAt
                        ? `${clock(Date.parse(task.lastRunAt))} ${statusWord(task.lastRunStatus)}`
                        : statusWord("never"),
                    })}
                    {task.nextRunAt
                      ? ` · ${t("next {time}", { time: formatWakeIn(task.nextRunAt) })}`
                      : null}
                  </div>
                </MenuTrigger>
                <MenuPopup data-bot-surface align="start" collisionPadding={menuCollisionPadding()}>
                  <MenuItem
                    onClick={() =>
                      void runNow({ environmentId: target.environmentId, input: { id: task.id } })
                    }
                  >
                    <PlayIcon />
                    {t("Run now")}
                  </MenuItem>
                  <MenuItem
                    render={
                      <Link
                        to="/settings/scheduled-tasks"
                        search={{ environmentId: target.environmentId, taskId: task.id }}
                      />
                    }
                  >
                    <PencilIcon />
                    {t("Edit")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
              <Switch
                aria-label={t("{name} enabled", { name: task.title })}
                checked={task.enabled}
                onCheckedChange={(enabled) =>
                  void setEnabled({
                    environmentId: target.environmentId,
                    input: { id: task.id, enabled },
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function MemoryPanel({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  if (!bot) return null;
  return (
    <>
      <NoteList
        environmentId={target.environmentId}
        bot={null}
        title={t("You")}
        scope={t("All bots")}
        addLabel={t("Add to You")}
        empty={t("Every bot gets these notes about you, such as your language or units.")}
      />
      <NoteList
        environmentId={target.environmentId}
        bot={bot}
        title={bot.name}
        scope={t("This bot")}
        addLabel={t("Add to {bot}", { bot: bot.name })}
        empty={t("{bot} saves preferences and corrections you give it here.", { bot: bot.name })}
      />
    </>
  );
}

export function YouNotes({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <>
      <NoteList
        environmentId={environmentId}
        bot={null}
        title={t("Notes")}
        scope={t("Removed")}
        addLabel={t("Add a note")}
      />
      <NightlyCheck environmentId={environmentId} />
    </>
  );
}

const SEARCH_FROM = 12;

/** A stale or contradicted note stays out of turns until the user edits it or keeps it as still true. */
function NoteList({
  environmentId,
  bot,
  title,
  scope,
  addLabel,
  empty,
}: {
  environmentId: EnvironmentId;
  bot: BotSummary | null;
  title: string;
  scope: string;
  addLabel: string;
  empty?: string;
}) {
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [retired, setRetired] = useState(false);
  const [limit, setLimit] = useState(NOTES_PAGE);
  const page = useNotes(environmentId, bot?.threadId ?? null, { query, retired, limit });
  // A saved edit shows until the list read after it arrives.
  const [saved, setSaved] = useState<{ page: typeof page; id: string; text: string } | null>(null);
  const notes = (page?.notes ?? []).map((note) =>
    saved && saved.page === page && saved.id === note.id ? { ...note, text: saved.text } : note,
  );
  const total = page?.total ?? 0;
  const commit = () => {
    if (!editing) return;
    setEditing(null);
    if (editing.id !== null) setSaved({ page, id: editing.id, text: editing.text });
    void saveNote(environmentId, bot, editing.id, editing.text);
  };
  const showRetired = (next: boolean) => {
    setRetired(next);
    setEditing(null);
    setLimit(NOTES_PAGE);
  };
  const field = (
    <MemoryField
      text={editing?.text ?? ""}
      label={editing?.id === null ? addLabel : t("Edit note")}
      onChange={(text) => setEditing((current) => (current ? { ...current, text } : current))}
      onCommit={commit}
      onCancel={() => setEditing(null)}
    />
  );
  const searching = query.trim() !== "";
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-1.5 max-md:ps-9 max-md:pe-5 max-md:pt-5">
        <h3 className={SECTION_TITLE}>{retired ? t("Removed") : title}</h3>
        <Button variant="ghost-muted" size="xs" onClick={() => showRetired(!retired)}>
          {retired ? t("Back to notes") : scope}
        </Button>
      </div>
      {total >= SEARCH_FROM || searching ? (
        <div className="px-4 pb-1.5">
          <Input
            type="search"
            size="compact"
            value={query}
            placeholder={t("Search notes")}
            aria-label={t("Search notes")}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(NOTES_PAGE);
            }}
          />
        </div>
      ) : null}
      {page !== null && notes.length === 0 && !editing && (searching || retired || empty) ? (
        <p className={EMPTY_NOTE}>
          {searching ? t("No notes match.") : retired ? t("No removed notes.") : empty}
        </p>
      ) : null}
      <ul className={SHEET_LIST}>
        {notes.map((note) => (
          <li key={note.id}>
            {editing?.id === note.id ? (
              field
            ) : (
              <div className="flex items-center gap-2 pe-4 max-md:pe-5">
                <button
                  type="button"
                  disabled={retired}
                  className="min-w-0 flex-1 py-2.5 ps-4 text-left outline-none not-disabled:hover:bg-accent max-md:py-2.75 max-md:ps-5 max-md:hover:bg-transparent"
                  onClick={() => setEditing({ id: note.id, text: note.text })}
                >
                  <div
                    className={cn(
                      "break-words",
                      ROW_TEXT,
                      (retired || note.status !== "fresh") && "text-muted-foreground",
                    )}
                  >
                    {note.text}
                  </div>
                  {noteMeta(note) ? (
                    <div className={cn("line-clamp-2 break-words", ROW_META)}>{noteMeta(note)}</div>
                  ) : null}
                </button>
                {retired ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void setNote(environmentId, bot, note.id, { retired: false })}
                  >
                    {t("Restore")}
                  </Button>
                ) : (
                  <>
                    {note.status === "fresh" ? null : (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => void saveNote(environmentId, bot, note.id, note.text)}
                      >
                        {t("Still true")}
                      </Button>
                    )}
                    <Button
                      variant={note.pinned ? "ghost" : "ghost-muted"}
                      size="icon-xs"
                      aria-pressed={note.pinned !== undefined}
                      aria-label={note.pinned ? t("Unpin") : t("Pin to every reply")}
                      title={note.pinned ? t("Unpin") : t("Pin to every reply")}
                      onClick={() =>
                        void setNote(environmentId, bot, note.id, { pinned: !note.pinned })
                      }
                    >
                      <PinIcon className={note.pinned ? "fill-current" : undefined} />
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
        {notes.length < total ? (
          <li>
            <button
              type="button"
              className={cn(
                "w-full px-4 py-2.5 text-left text-muted-foreground outline-none hover:bg-accent max-md:px-5 max-md:py-3 max-md:hover:bg-transparent",
                ROW_TEXT,
              )}
              onClick={() => setLimit((current) => current + NOTES_PAGE)}
            >
              {t("Show {count} more", { count: Math.min(NOTES_PAGE, total - notes.length) })}
            </button>
          </li>
        ) : null}
        {retired || searching ? null : (
          <li>
            {editing?.id === null ? (
              field
            ) : (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2.5 text-left text-muted-foreground outline-none hover:bg-accent max-md:px-5 max-md:py-3 max-md:hover:bg-transparent",
                  ROW_TEXT,
                )}
                onClick={() => setEditing({ id: null, text: "" })}
              >
                <PlusIcon aria-hidden className="size-4 shrink-0 max-md:size-5" />
                {addLabel}
              </button>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}

function MemoryField({
  text,
  label,
  onChange,
  onCommit,
  onCancel,
}: {
  text: string;
  label: string;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const cancelled = useRef(false);
  const phone = useMediaQuery("max-md");
  const field = {
    autoFocus: true,
    value: text,
    maxLength: 300,
    // The field grows with the note (rows is the fallback where field-sizing is unsupported).
    rows: Math.min(6, Math.max(1, Math.ceil(text.length / (phone ? 34 : 60)))),
    "aria-label": label,
    placeholder: label,
    enterKeyHint: "done",
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => {
      const end = event.currentTarget.value.length;
      event.currentTarget.setSelectionRange(end, end);
    },
    // Enter saves: a note is one paragraph.
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onCommit();
        return;
      }
      if (event.key !== "Escape") return;
      cancelled.current = true;
      onCancel();
    },
    onBlur: () => {
      if (!cancelled.current) onCommit();
    },
  } as const;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onCommit();
  };
  // Pressing Save would blur the field first, which saves too; the press keeps the focus.
  const keepFocus = (event: React.PointerEvent) => event.preventDefault();
  if (!phone) {
    return (
      <form className="flex items-start gap-2 px-4 py-2" onSubmit={submit}>
        <div className="min-w-0 flex-1">
          <Textarea {...field} />
        </div>
        <Button type="submit" size="sm" onPointerDown={keepFocus}>
          {t("Save")}
        </Button>
      </form>
    );
  }
  return (
    <form
      className="mx-3 my-0.5 flex items-end gap-2 rounded-2xl bg-bot-bubble py-2 ps-3.5 pe-1.5 ring-1 ring-foreground/20 ring-inset"
      onSubmit={submit}
    >
      <textarea
        {...field}
        className={cn(
          "field-sizing-content min-w-0 flex-1 resize-none self-center bg-transparent py-1 outline-none placeholder:text-muted-foreground",
          ROW_TEXT,
        )}
      />
      <Button type="submit" size="icon-pill" aria-label={t("Save note")} onPointerDown={keepFocus}>
        <CheckIcon />
      </Button>
    </form>
  );
}

function ActivityPanel({ target }: { target: ScopedThreadRef }) {
  const bot = useBot(target.environmentId, target.threadId);
  const dreams = bot?.dreams ?? [];
  const detail = useThreadProjection(target)?.projection;
  const recordings = useBotRecordings(
    target.environmentId,
    target.threadId,
    detail ? String(detail.runs.length) : null,
  );
  const elsewhere = recordings.filter((r) => r.threadId !== target.threadId);
  if (!detail || (detail.runs.length === 0 && dreams.length === 0))
    return <p className={EMPTY_NOTE}>{t("No runs yet.")}</p>;
  const runOfAttempt = new Map(detail.attempts.map((attempt) => [attempt.id, attempt.runId]));
  const steps = (recording: (typeof recordings)[number]) => (
    <RecordingSteps
      environmentId={target.environmentId}
      botThreadId={target.threadId}
      recording={recording}
    />
  );
  return (
    <>
      <ul className={SHEET_LIST}>
        {detail.runs
          .map((run) => {
            const message = detail.messages.find((m) => m.id === run.userMessageId);
            const items = detail.turnItems.filter((i) => i.runId === run.id);
            const tools = items.filter(
              (i) => i.type === "dynamic_tool" || i.type === "command_execution",
            );
            const notified = tools.some(
              (i) => i.type === "dynamic_tool" && i.toolName?.endsWith("notify_user"),
            );
            const recording = recordings.find(
              (r) => r.threadId === target.threadId && r.runId === run.id,
            );
            const tokens = detail.providerTurns
              .filter(
                (turn) =>
                  turn.runAttemptId !== null && runOfAttempt.get(turn.runAttemptId) === run.id,
              )
              .reduce(
                (sum, turn) => sum + chargedTokens(turn.turnTokenUsage ?? turn.tokenUsage ?? {}),
                0,
              );
            return (
              <li key={run.id}>
                <Collapsible>
                  {/* On a phone the title gets the line, with the time trailing and the meta below. */}
                  <CollapsibleTrigger className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left hover:bg-accent max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-2 max-md:gap-y-0.5 max-md:px-5 max-md:hover:bg-transparent">
                    <span
                      className={cn("shrink-0 max-md:col-start-2 max-md:row-start-1", ROW_META)}
                    >
                      {clock(DateTime.toEpochMillis(run.requestedAt))}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate max-md:col-start-1 max-md:row-start-1",
                        ROW_TEXT,
                      )}
                    >
                      {message?.text.slice(0, 80) ?? t("run")}
                    </span>
                    <span className={cn("shrink-0 max-md:col-span-2", ROW_META)}>
                      {plural(tools.length, {
                        en: ["{count} tool", "{count} tools"],
                        uk: ["{count} інструмент", "{count} інструменти", "{count} інструментів"],
                        ru: ["{count} инструмент", "{count} инструмента", "{count} инструментов"],
                      })}{" "}
                      · {formatTokens(tokens)} · {notified ? t("notified") : statusWord(run.status)}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel animate={false}>
                    <div className="space-y-1 px-4 pb-3 text-xs max-md:px-5 max-md:text-bot-footnote">
                      {items.map((item) => (
                        <div key={item.id}>
                          <span className="text-muted-foreground">
                            {item.title ||
                              (item.type === "dynamic_tool" ? item.toolName : item.type)}{" "}
                            · {statusWord(item.status)}
                          </span>
                          {item.type === "command_execution" ? (
                            <pre className="mt-0.5 max-h-40 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap">
                              {item.input}
                              {item.output ? `\n${item.output}` : ""}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                      {recording ? steps(recording) : null}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </li>
            );
          })
          .toReversed()}
      </ul>
      {dreams.length === 0 ? null : (
        <>
          <h3 className={SECTION_HEADER}>{t("Nightly check")}</h3>
          <ul className={SHEET_LIST}>
            {dreams.map((run) => {
              const tokens = chargedTokens({
                inputTokens: run.input,
                cachedInputTokens: run.cached,
                outputTokens: run.output,
              });
              // A scope with nothing to check made no call: no duration and no tokens to show.
              const spent = [
                run.durationMs > 0 ? formatDuration(run.durationMs) : null,
                tokens > 0 ? formatTokens(tokens) : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={`${run.at}#${run.result}`}
                  className="flex items-baseline gap-2 px-4 py-2.5 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-2 max-md:gap-y-0.5 max-md:px-5"
                >
                  <span className={cn("shrink-0 max-md:col-start-2 max-md:row-start-1", ROW_META)}>
                    {messageTimeLabel(Date.parse(run.at))}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate max-md:col-start-1 max-md:row-start-1",
                      ROW_TEXT,
                      run.outcome === "failed" && "text-destructive-foreground",
                    )}
                  >
                    {run.result}
                  </span>
                  {spent === "" ? null : (
                    <span className={cn("shrink-0 max-md:col-span-2", ROW_META)}>{spent}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {elsewhere.length === 0 ? null : (
        <>
          <h3 className={SECTION_HEADER}>{t("Wakes and workers")}</h3>
          <ul className={SHEET_LIST}>
            {elsewhere.map((recording) => (
              <li key={recording.id}>
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left hover:bg-accent max-md:px-5 max-md:hover:bg-transparent">
                    <span className={cn("shrink-0", ROW_META)}>
                      {clock(Date.parse(recording.startedAt))}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", ROW_TEXT)}>
                      {recording.steps[0]?.detail ?? recording.threadId}
                    </span>
                    <span className={cn("shrink-0", ROW_META)}>
                      {plural(recording.steps.length, {
                        en: ["{count} step", "{count} steps"],
                        uk: ["{count} крок", "{count} кроки", "{count} кроків"],
                        ru: ["{count} шаг", "{count} шага", "{count} шагов"],
                      })}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel animate={false}>
                    <div className="px-4 pb-3 text-xs max-md:px-5 max-md:text-bot-footnote">
                      {steps(recording)}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

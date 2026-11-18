import {
  AuthOrchestrationOperateScope,
  BOTS_ENDPOINTS,
  type BotScreen,
  type ComputerAction,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { t } from "../i18n";
import { useEnvironmentScope } from "../state/session";
import { botRequest } from "./http";
import { EMPTY_NOTE, FACT_ROW, ROW_META, ROW_TEXT, SHEET_LIST } from "./panelStyles";

const keyNames: Readonly<Record<string, string>> = {
  Enter: "Return",
  Backspace: "BackSpace",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "space",
  PageUp: "Prior",
  PageDown: "Next",
};

export function BotScreenPanel({ target }: { target: ScopedThreadRef }) {
  const { environmentId, threadId } = target;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [screen, setScreen] = useState<BotScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const screenRef = useRef<HTMLImageElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const inputQueue = useRef(Promise.resolve());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the open panel samples its remote screen; closing or hiding it cancels capture
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async () => {
      if (abort.signal.aborted) return;
      if (document.visibilityState === "visible") {
        try {
          const next = await botRequest(
            environmentId,
            BOTS_ENDPOINTS.screen,
            { threadId },
            abort.signal,
          );
          if (!abort.signal.aborted) {
            setScreen(next);
            setError(null);
          }
        } catch (cause) {
          if (!abort.signal.aborted)
            setError(cause instanceof Error ? cause.message : t("Screen unavailable."));
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(capture, 750);
    };
    void capture();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [environmentId, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- renews the user's short control lease while the screen is open and visible
  useEffect(() => {
    if (!screen?.controlling) return;
    const renew = setInterval(() => {
      if (document.visibilityState === "visible")
        void botRequest(environmentId, BOTS_ENDPOINTS.computerControl, {
          threadId,
          active: true,
        }).catch(() => undefined);
    }, 5000);
    return () => {
      clearInterval(renew);
      void botRequest(environmentId, BOTS_ENDPOINTS.computerControl, {
        threadId,
        active: false,
      }).catch(() => undefined);
    };
  }, [environmentId, threadId, screen?.controlling]);

  const perform = async (run: () => Promise<unknown>) => {
    setBusy(true);
    await run().then(
      () => setError(null),
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("Computer action failed.")),
    );
    setBusy(false);
  };
  const control = (active: boolean) =>
    perform(async () => {
      await botRequest(environmentId, BOTS_ENDPOINTS.computerControl, { threadId, active });
      setScreen((previous) => previous && { ...previous, controlling: active });
      if (active) screenRef.current?.focus();
    });
  const stop = (reset: boolean) =>
    perform(async () => {
      await botRequest(environmentId, BOTS_ENDPOINTS.computerStop, { threadId, reset });
      setScreen(
        (previous) =>
          previous && {
            ...previous,
            controlling: false,
            activity: null,
            ...(reset ? { image: null, url: null, title: null } : {}),
          },
      );
    });
  const input = (action: ComputerAction) => {
    if (!canOperate || !screen?.controlling) return;
    inputQueue.current = inputQueue.current.then(async () => {
      try {
        await botRequest(environmentId, BOTS_ENDPOINTS.computerInput, { threadId, input: action });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("Input failed."));
      }
    });
  };
  const position = (event: {
    clientX: number;
    clientY: number;
    currentTarget: HTMLImageElement;
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(1279, Math.floor(((event.clientX - bounds.left) / bounds.width) * 1280)),
      ),
      y: Math.max(
        0,
        Math.min(799, Math.floor(((event.clientY - bounds.top) / bounds.height) * 800)),
      ),
    };
  };
  const pointerUp = (event: PointerEvent<HTMLImageElement>) => {
    if (!pointer.current) return;
    const start = pointer.current;
    pointer.current = null;
    const end = position(event);
    if (Math.abs(end.x - start.x) + Math.abs(end.y - start.y) > 5)
      input({ action: "drag", ...start, toX: end.x, toY: end.y });
    else
      input({
        action: "click",
        ...end,
        button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      });
  };
  if (screen && !screen.available)
    return <p className="px-4 py-3 text-sm">{t("No bot computer on this server.")}</p>;
  const reset = async () => {
    const confirmed = await (readLocalApi()?.dialogs.confirm(
      t("Reset the bot's screen?\nIts tab closes and the page is lost."),
      { variant: "destructive", confirmLabel: t("Reset") },
    ) ?? Promise.resolve(false));
    if (confirmed) void stop(true);
  };
  const running = screen?.activity != null;
  const state = !screen
    ? t("Connecting…")
    : screen.controlling
      ? t("You control, bot paused")
      : running
        ? t("Running")
        : screen.image
          ? t("Idle")
          : t("Not open");
  const rows = [
    { label: t("Status"), value: state },
    ...(screen?.activity ? [{ label: t("Task"), value: screen.activity }] : []),
    ...(screen?.image && screen.url ? [{ label: t("Page"), value: screen.url }] : []),
  ];
  return (
    <div data-bot-screen>
      <ul className={SHEET_LIST}>
        {rows.map((row) => (
          <li key={row.label} className={FACT_ROW}>
            <span className={ROW_TEXT}>{row.label}</span>
            <span className={cn("min-w-0 truncate", ROW_META)}>{row.value}</span>
          </li>
        ))}
      </ul>
      {screen && canOperate ? (
        <div className="grid grid-cols-2 gap-2 px-4 py-3 max-md:px-5">
          {screen.controlling ? (
            <Button
              size="pill"
              className="col-span-2"
              disabled={busy}
              onClick={() => void control(false)}
            >
              {t("Hand back")}
            </Button>
          ) : (
            <>
              <Button
                size="pill"
                className={running || screen.image ? undefined : "col-span-2"}
                disabled={busy}
                onClick={() => void control(true)}
              >
                {t("Take control")}
              </Button>
              {running ? (
                <Button
                  size="pill"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void stop(false)}
                >
                  {t("Stop")}
                </Button>
              ) : screen.image ? (
                <Button
                  size="pill"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void reset()}
                >
                  {t("Reset")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {error ? <p className={cn(EMPTY_NOTE, "text-destructive")}>{error}</p> : null}
      {screen?.image ? (
        <img
          ref={screenRef}
          src={screen.image}
          alt={t("Live bot screen")}
          draggable={false}
          tabIndex={screen.controlling ? 0 : -1}
          className="block w-full touch-none border-y outline-none"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (!screen.controlling) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer.current = position(event);
          }}
          onPointerUp={pointerUp}
          onPointerCancel={() => {
            pointer.current = null;
          }}
          onWheel={(event) => {
            if (!screen.controlling) return;
            input({
              action: "scroll",
              ...position(event),
              direction: event.deltaY < 0 ? "up" : "down",
              amount: 3,
            });
          }}
          onKeyDown={(event) => {
            if (!screen.controlling || ["Control", "Alt", "Shift", "Meta"].includes(event.key))
              return;
            event.preventDefault();
            if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey)
              input({ action: "type", text: event.key });
            else
              input({
                action: "key",
                text: [
                  event.ctrlKey && "ctrl",
                  event.altKey && "alt",
                  event.shiftKey && "shift",
                  event.metaKey && "super",
                  keyNames[event.key] ?? event.key,
                ]
                  .filter(Boolean)
                  .join("+"),
              });
          }}
        />
      ) : null}
      {screen?.controlling ? (
        <form
          className="flex gap-2 px-4 py-3 max-md:px-5"
          onSubmit={(event) => {
            event.preventDefault();
            input({ action: "type", text });
            setText("");
          }}
        >
          <Input
            size="compact"
            aria-label={t("Type on screen")}
            placeholder={t("Type on screen")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button size="pill-sm" variant="secondary" type="submit" disabled={!text}>
            {t("Type")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

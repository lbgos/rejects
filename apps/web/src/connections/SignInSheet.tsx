import {
  CONNECTIONS_ENDPOINTS,
  type EnvironmentId,
  type SheetFocus,
  type SheetFrame,
  type SheetInput,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  KeyboardIcon,
  LockIcon,
  RotateCwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { observeResize } from "../lib/observeResize";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { toastManager } from "../components/ui/toast";
import { botRequest } from "../bots/http";
import { createInputQueue, inputFromBeforeInput } from "./sheetInput";
import { fieldAt, followFocus, KEYBOARD_HOLD_MS, type KeyboardFollow } from "./sheetKeyboard";
import { type FrameGeometry, framePoint, sameBox, type SheetBox, sheetBox } from "./sheetLayout";

/** The hidden field holds something for Backspace to delete: iOS sends none on an empty field. */
const SENTINEL = "​​";
/** The largest pixel ratio the vault renders for; beyond it the frames cost more than they show. */
const MAX_SCALE = 3;
const DRAG_CLOSE_PX = 110;

const readBox = (): SheetBox =>
  sheetBox(window.visualViewport, {
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  });

/**
 * iOS shrinks the visual viewport above the keyboard and can leave an offset behind once the keyboard goes,
 * so it is read again on every event that can change it and for a moment after.
 */
function useSheetBox(): SheetBox {
  const [box, setBox] = useState(readBox);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the browser's visual viewport, which only it can report
  useEffect(() => {
    let settle = 0;
    const read = () => setBox((current) => (sameBox(current, readBox()) ? current : readBox()));
    const settleAfterChange = () => {
      read();
      cancelAnimationFrame(settle);
      const until = performance.now() + 600;
      const tick = () => {
        read();
        if (performance.now() < until) settle = requestAnimationFrame(tick);
      };
      settle = requestAnimationFrame(tick);
    };
    const visual = window.visualViewport;
    const events: ReadonlyArray<readonly [EventTarget | null, string]> = [
      [visual, "resize"],
      [visual, "scroll"],
      [window, "resize"],
      [window, "orientationchange"],
      [window, "focusin"],
      [window, "focusout"],
      [window, "pageshow"],
      [document, "visibilitychange"],
    ];
    for (const [target, name] of events) target?.addEventListener(name, settleAfterChange);
    return () => {
      cancelAnimationFrame(settle);
      for (const [target, name] of events) target?.removeEventListener(name, settleAfterChange);
    };
  }, []);
  return box;
}

/** The page relayouts to the sheet's area at this screen's pixel ratio, so it shows 1:1. Bots act in the same profile later through their tools, never through this sheet. */
export function SignInSheet({
  environmentId,
  site,
  onClose,
}: {
  environmentId: EnvironmentId;
  site: string;
  onClose: (done: boolean) => void;
}) {
  const phone = useMediaQuery("max-md");
  const finePointer = useMediaQuery({ pointer: "fine" });
  const box = useSheetBox();
  const [frame, setFrame] = useState<SheetFrame | null>(null);
  // The newest picture with its own size: a poll that brings none must not give the old picture
  // the size of a newer page, which is what stretched it and threw taps off.
  const [shown, setShown] = useState<(FrameGeometry & { image: string }) | null>(null);
  const [typing, setTyping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ start: number; id: number; moved: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const sentViewport = useRef("");
  const follow = useRef<KeyboardFollow>({ tap: null, holdUntil: 0, editing: false });
  const pageFocus = useRef<SheetFocus | undefined>(undefined);
  const recheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const open = frame?.open === true;

  const followPage = useStableCallback(function followAgain() {
    const field = fieldRef.current;
    if (!field) return;
    clearTimeout(recheck.current);
    const { state, move } = followFocus(follow.current, pageFocus.current, Date.now(), {
      typing: document.activeElement === field,
      canOpen: finePointer,
    });
    follow.current = state;
    if (move === "open") field.focus({ preventScroll: true });
    else if (move === "close") field.blur();
    else if (move !== "none")
      recheck.current = setTimeout(followAgain, move.recheckAt - Date.now());
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- long-polls the vault's screencast while the sheet is mounted
  useEffect(() => {
    const controller = new AbortController();
    let seq = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const next = await botRequest(
            environmentId,
            CONNECTIONS_ENDPOINTS.sheetFrame,
            { site, after: seq },
            controller.signal,
          );
          if (!next.open) {
            setFrame(next);
            return;
          }
          seq = next.seq;
          setFrame(next);
          pageFocus.current = next.focus;
          followPage();
          if (next.image !== null)
            setShown({
              image: next.image,
              width: next.width,
              height: next.height,
              offsetTop: next.offsetTop,
            });
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(recheck.current);
    };
  }, [environmentId, site, followPage]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the page area, which only the DOM knows
  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const measure = () =>
      setPageSize((current) => {
        const width = Math.floor(element.clientWidth);
        const height = Math.floor(element.clientHeight);
        return current?.width === width && current.height === height ? current : { width, height };
      });
    measure();
    return observeResize(element, measure);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the vault the page area it should relayout to
  useEffect(() => {
    if (!open || pageSize === null || pageSize.width < 1 || pageSize.height < 1) return;
    const scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
    const key = `${pageSize.width}x${pageSize.height}@${scale}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The keyboard animates the area through many sizes: wait for the last. Without the size the
    // page stays at the wrong one, so a failed request is asked again.
    const send = (delay: number) => {
      timer = setTimeout(() => {
        if (sentViewport.current === key) return;
        sentViewport.current = key;
        botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetViewport, {
          site,
          width: pageSize.width,
          height: pageSize.height,
          scale,
        }).catch(() => {
          sentViewport.current = "";
          send(1000);
        });
      }, delay);
    };
    send(120);
    return () => clearTimeout(timer);
  }, [environmentId, site, open, pageSize]);

  const sendInput = useStableCallback((input: SheetInput) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetInput, { site, input }).catch(
      (error: unknown) =>
        toastManager.add({
          type: "error",
          title: error instanceof Error ? error.message : t("The page did not take that."),
        }),
    ),
  );
  const [push] = useState(() => createInputQueue(sendInput));
  // Enter or Tab may take the page to its next field; the keyboard stays up for it.
  const pushTyped = useStableCallback((input: SheetInput) => {
    if (input.type === "key" && (input.key === "Enter" || input.key === "Tab"))
      follow.current = { ...follow.current, holdUntil: Date.now() + KEYBOARD_HOLD_MS };
    push(input);
  });
  /** Inside the tap, so iOS raises the keyboard for a field; the page's focus read decides the rest. */
  const tap = (point: { x: number; y: number }) => {
    const id = Math.max(Date.now(), (follow.current.tap ?? 0) + 1);
    follow.current = { ...follow.current, tap: id, holdUntil: 0 };
    const field = fieldRef.current;
    if (field && fieldAt(pageFocus.current?.fields ?? [], point))
      field.focus({ preventScroll: true });
    push({ type: "tap", x: point.x, y: point.y, id });
  };

  // The hidden field takes the keyboard's input as it happens. Typed characters go straight to the
  // page and are kept nowhere here; the field itself never holds them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native beforeinput and key listeners on the hidden field
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const reset = () => {
      field.value = SENTINEL;
      field.setSelectionRange(SENTINEL.length, SENTINEL.length);
    };
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      event.preventDefault();
      const input = inputFromBeforeInput(event);
      if (input) pushTyped(input);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (event.data) push({ type: "text", text: event.data });
      reset();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" && event.key !== "Escape") return;
      event.preventDefault();
      pushTyped({ type: "key", key: event.key });
    };
    const onFocus = () => {
      reset();
      setTyping(true);
    };
    const onBlur = () => setTyping(false);
    field.addEventListener("beforeinput", onBeforeInput);
    field.addEventListener("compositionend", onCompositionEnd);
    field.addEventListener("keydown", onKeyDown);
    field.addEventListener("focus", onFocus);
    field.addEventListener("blur", onBlur);
    // A field focused on mount (a physical keyboard) was focused before these listeners existed.
    if (document.activeElement === field) onFocus();
    return () => {
      field.removeEventListener("beforeinput", onBeforeInput);
      field.removeEventListener("compositionend", onCompositionEnd);
      field.removeEventListener("keydown", onKeyDown);
      field.removeEventListener("focus", onFocus);
      field.removeEventListener("blur", onBlur);
    };
  }, [push, pushTyped]);

  const close = (done: boolean) => {
    setClosing(true);
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetClose, { site, done }).then(
      () => onClose(done),
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: error instanceof Error ? error.message : t("The sheet did not close cleanly."),
        });
        onClose(false);
      },
    );
  };

  const pagePoint = (element: HTMLElement, clientX: number, clientY: number) =>
    shown === null
      ? undefined
      : framePoint(element.getBoundingClientRect(), shown, { x: clientX, y: clientY });

  const pasteFromClipboard = () => {
    navigator.clipboard.readText().then(
      (text) => {
        if (text) push({ type: "text", text });
      },
      () => toastManager.add({ type: "error", title: t("The clipboard cannot be read.") }),
    );
  };

  const toggleKeyboard = () => {
    const field = fieldRef.current;
    if (!field) return;
    // Focus has to happen inside this tap for iOS to raise the keyboard.
    if (document.activeElement === field) field.blur();
    else field.focus({ preventScroll: true });
  };

  const host = frame?.url ? new URL(frame.url).host : site;
  return (
    <div
      role="dialog"
      aria-label={t("Sign in to {site}", { site })}
      // The keyboard's field keeps focus until the page says its own focus left a field. With a
      // physical keyboard a click anywhere in the sheet takes it, so keys never reach the composer.
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest("input, textarea, select"))
          return;
        event.preventDefault();
        if (finePointer) fieldRef.current?.focus({ preventScroll: true });
      }}
      data-connections
      className={cn(
        "fixed z-[60] overscroll-none bg-bot-scrim text-foreground",
        phone ? "overflow-hidden" : "inset-0 flex items-center justify-center p-6",
      )}
      style={
        phone ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined
      }
    >
      {/* Full height below the status bar on a phone, sitting on the keyboard when it is up. */}
      <div
        data-sign-in-sheet
        className={cn(
          "flex min-h-0 flex-col overflow-hidden bg-bot-bubble",
          phone
            ? "absolute inset-x-2 rounded-4xl"
            : "h-[min(52rem,100%)] w-full max-w-md flex-none rounded-2xl border",
          dragged === null && "transition-transform duration-150",
        )}
        style={
          phone
            ? {
                top: `calc(max(env(safe-area-inset-top) - ${box.top}px, 0px) + 0.5rem)`,
                bottom: box.keyboard ? "0.5rem" : "max(0.5rem, env(safe-area-inset-bottom))",
                transform: dragged ? `translateY(${dragged}px)` : undefined,
              }
            : undefined
        }
      >
        <div
          className="flex shrink-0 touch-none justify-center pt-2 pb-1 md:hidden"
          onPointerDown={(event) => {
            // Capture keeps the pull going when the finger leaves the handle; it is not required.
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {}
            drag.current = { start: event.clientY, id: event.pointerId, moved: 0 };
            setDragged(0);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current?.id !== event.pointerId) return;
            current.moved = Math.max(0, event.clientY - current.start);
            setDragged(current.moved);
          }}
          onPointerUp={(event) => {
            const moved = drag.current?.moved ?? 0;
            drag.current = null;
            setDragged(null);
            if (moved > DRAG_CLOSE_PX && !closing) close(false);
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {}
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragged(null);
          }}
        >
          <div aria-hidden className="h-1.25 w-9 rounded-full bg-foreground/25" />
        </div>
        <div className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
          <Button
            variant={phone ? "glass" : "ghost"}
            size={phone ? "icon-xl" : "icon-sm"}
            aria-label={t("Cancel")}
            disabled={closing}
            onClick={() => close(false)}
          >
            <XIcon />
          </Button>
          <span className="flex min-w-0 items-center justify-center gap-1.5 text-sm font-semibold max-md:text-bot-callout">
            <LockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{host}</span>
          </span>
          <Button
            size={phone ? "icon-pill" : "icon-sm"}
            aria-label={t("Done")}
            disabled={closing}
            onClick={() => close(true)}
          >
            <CheckIcon />
          </Button>
        </div>
        <div
          ref={pageRef}
          data-sign-in-page
          className="relative mx-2 min-h-0 flex-1 overflow-hidden rounded-3xl bg-white md:rounded-lg"
        >
          {shown ? (
            // The page was laid out for this area, so the picture is 1:1 with it. Until a newer
            // one arrives an older picture keeps its own shape (contain), never stretched.
            <img
              alt={frame?.title ?? t("Sign-in page")}
              src={shown.image}
              draggable={false}
              className="absolute inset-0 size-full max-w-none touch-none object-contain object-left-top select-none"
              onClick={(event) => {
                const point = pagePoint(event.currentTarget, event.clientX, event.clientY);
                if (point) tap(point);
              }}
              onWheel={(event) => {
                const point = pagePoint(event.currentTarget, event.clientX, event.clientY);
                if (point) push({ type: "scroll", dy: Math.round(event.deltaY * point.scale) });
              }}
              onTouchStart={(event) => {
                const point = event.touches[0];
                touch.current = point ? { x: point.clientX, y: point.clientY } : null;
              }}
              onTouchEnd={(event) => {
                const start = touch.current;
                const end = event.changedTouches[0];
                touch.current = null;
                if (!start || !end) return;
                event.preventDefault();
                const dy = start.y - end.clientY;
                const point = pagePoint(event.currentTarget, end.clientX, end.clientY);
                if (!point) return;
                if (Math.abs(dy) > 12) push({ type: "scroll", dy: Math.round(dy * point.scale) });
                else tap(point);
              }}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              {frame && !frame.open ? t("The page closed.") : t("Opening…")}
            </p>
          )}
        </div>
        <div
          data-sign-in-toolbar
          // A tap on a toolbar button must not take focus from the keyboard's field.
          onMouseDown={(event) => event.preventDefault()}
          className="relative flex h-13 shrink-0 items-center justify-around px-2 md:h-11 md:justify-center md:gap-1"
        >
          {/* Takes the keyboard's input; it sits in view so iOS does not scroll the page to it. */}
          <textarea
            ref={fieldRef}
            aria-label={t("Type into the page")}
            rows={1}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            // A physical keyboard types into the sheet from the start, not into the composer behind.
            autoFocus={finePointer}
            defaultValue={SENTINEL}
            className="pointer-events-none absolute bottom-0 left-0 size-px resize-none border-0 bg-transparent p-0 text-base opacity-0 outline-none"
          />
          <Button
            size={phone ? "icon-xl" : "icon-sm"}
            variant="ghost"
            aria-label={t("Back")}
            onClick={() => push({ type: "back" })}
          >
            <ChevronLeftIcon />
          </Button>
          {frame?.popup ? (
            <Button
              size={phone ? "icon-xl" : "icon-sm"}
              variant="ghost"
              aria-label={t("Close window")}
              onClick={() => push({ type: "closePopup" })}
            >
              <Undo2Icon />
            </Button>
          ) : (
            <Button
              size={phone ? "icon-xl" : "icon-sm"}
              variant="ghost"
              aria-label={t("Forward")}
              onClick={() => push({ type: "forward" })}
            >
              <ChevronRightIcon />
            </Button>
          )}
          <Button
            size={phone ? "icon-xl" : "icon-sm"}
            variant="ghost"
            aria-label={t("Reload")}
            onClick={() => push({ type: "reload" })}
          >
            <RotateCwIcon />
          </Button>
          <Button
            size={phone ? "icon-xl" : "icon-sm"}
            variant="ghost"
            aria-label={t("Paste")}
            onClick={pasteFromClipboard}
          >
            <ClipboardPasteIcon />
          </Button>
          <Button
            size={phone ? "icon-xl" : "icon-sm"}
            variant="ghost"
            aria-label={typing ? t("Hide keyboard") : t("Type into the page")}
            aria-pressed={typing}
            onClick={toggleKeyboard}
          >
            <KeyboardIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

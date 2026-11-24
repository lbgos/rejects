import type { MessageId } from "@t3tools/contracts";
import { ReplyIcon } from "lucide-react";
import { use, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { flushSync } from "react-dom";
import { cn } from "~/lib/utils";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { TimelineRowCtx } from "../components/chat/timelineRowContext";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerHandleContext } from "../composerHandleContext";
import { t } from "../i18n";
import { COMMIT_PX, rubberBand } from "./gestures";
import { BotMessageMenu, type BotMenuPick } from "./BotMessageMenu";
import { BotChromeContext, BotReactionsContext } from "./context";
import { setBotReply } from "./ui";
import { placeGesture, useHorizontalDrag } from "./useHorizontalDrag";
import { useLongPress } from "./useLongPress";
import { messageTimeLabel } from "./presentation";

function failure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : t("Try again."),
    }),
  );
}

/** The drag writes `style.transform` directly, so it never re-renders. */
export function BotGestures({
  from,
  messageId,
  text,
  at,
  children,
}: {
  from: "bot" | "user";
  messageId: MessageId;
  text: string;
  at: string;
  children: ReactNode;
}) {
  const { threadRef } = use(TimelineRowCtx);
  const chrome = use(BotChromeContext);
  const botReacted = use(BotReactionsContext);
  const reaction = from === "user" ? botReacted.get(messageId) : chrome?.reactions?.[messageId];
  const composer = useComposerHandleContext();
  const mover = useRef<HTMLDivElement>(null);
  const icon = useRef<HTMLDivElement>(null);
  const quotable = text.trim().length > 0;

  const reply = () => {
    if (!threadRef || !quotable) return;
    setBotReply({ threadId: threadRef.threadId, text });
    composer?.current?.focusAtEnd();
  };
  const place = (offset: number, settle: boolean) => {
    const el = mover.current;
    if (!el) return;
    placeGesture(el, offset ? `translateX(${offset}px)` : "", settle);
    if (icon.current) icon.current.style.opacity = String(Math.min(offset / COMMIT_PX, 1));
  };
  // On touch a hold opens the menu; "Select text" hands the bubble to native selection until it clears.
  const [selecting, setSelecting] = useState(false);
  const selectWatch = useRef<AbortController | null>(null);
  const selectText = () => {
    const el = mover.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    flushSync(() => setSelecting(true));
    // The message prose only: the bubble also holds its screen-reader heading and attachments.
    selection.selectAllChildren(el.querySelector("[data-thread-find-text]") ?? el);
    selectWatch.current?.abort();
    const watch = new AbortController();
    selectWatch.current = watch;
    document.addEventListener(
      "selectionchange",
      () => {
        const current = window.getSelection();
        if (
          current &&
          !current.isCollapsed &&
          mover.current &&
          current.containsNode(mover.current, true)
        )
          return;
        watch.abort();
        setSelecting(false);
      },
      { signal: watch.signal },
    );
  };
  const drag = useHorizontalDrag({
    start: () => from === "bot" && quotable && !selecting,
    move: (dx) => place(rubberBand(Math.max(dx, 0), 0, COMMIT_PX), false),
    end: (dx) => {
      if (dx >= COMMIT_PX) reply();
      place(0, true);
    },
    cancel: () => place(0, true),
  });
  const [menuFor, setMenuFor] = useState<HTMLElement | null>(null);
  // Focus returns to the bubble only when the keyboard opened its menu.
  const fromKeyboard = useRef(false);
  const closeMenu = () => {
    if (fromKeyboard.current) mover.current?.focus({ preventScroll: true });
    setMenuFor(null);
  };
  const pick = (picked: BotMenuPick) => {
    closeMenu();
    if (picked === "reply") reply();
    else if (picked === "select") selectText();
    else
      void writeTextToClipboard(text, "message").catch((error: unknown) =>
        failure(t("Could not copy the message"), error),
      );
  };
  const openMenu = (keyboard = false) => {
    fromKeyboard.current = keyboard;
    if (threadRef && mover.current) setMenuFor(mover.current);
  };
  const { consumeClick: consumeHold, ...press } = useLongPress(() => openMenu());
  const { consumeClick: consumeDrag, ...swipe } = drag;

  return (
    <div
      className={cn(
        "relative flex w-full min-w-0",
        from === "user" ? "justify-end" : "justify-start",
      )}
    >
      {from === "bot" ? (
        <div
          ref={icon}
          aria-hidden
          className="absolute start-1 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0"
        >
          <ReplyIcon className="size-5" />
        </div>
      ) : null}
      <div
        ref={mover}
        data-testid="bot-bubble"
        data-from={from}
        data-selecting={selecting || undefined}
        tabIndex={0}
        aria-label={from === "bot" ? t("Message") : t("Your message")}
        aria-haspopup="menu"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== "Enter") return;
          event.preventDefault();
          openMenu(true);
        }}
        className={cn(
          "relative min-w-0 rounded-3xl outline-none select-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          // `data-touch` covers a finger on a device whose primary pointer is fine (iPad with a trackpad).
          !selecting &&
            "[-webkit-touch-callout:none] pointer-coarse:select-none data-touch:select-none",
          from === "bot" ? "w-full touch-pan-y max-md:w-auto max-md:max-w-[88%]" : "max-w-[80%]",
        )}
        {...(selecting
          ? {}
          : {
              ...press,
              onTouchStart: (event: TouchEvent) => {
                event.currentTarget.toggleAttribute("data-touch", true);
                press.onTouchStart(event);
              },
              onTouchEnd: (event: TouchEvent) => {
                event.currentTarget.toggleAttribute("data-touch", false);
                press.onTouchEnd(event);
              },
              onTouchCancel: (event: TouchEvent) => {
                event.currentTarget.toggleAttribute("data-touch", false);
                press.onTouchCancel();
              },
            })}
        {...swipe}
        onClickCapture={(event) => {
          const held = consumeHold();
          const dragged = consumeDrag();
          if (!held && !dragged) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
        {reaction ? (
          <span
            role="img"
            aria-label={t("Reaction {emoji}", { emoji: reaction })}
            className={cn(
              "relative flex w-fit items-center rounded-full bg-bot-fill px-2 py-1 text-xl leading-none select-none ring-2 ring-background",
              // A reaction hangs on a bubble's edge. Bot prose has no bubble, so its reaction
              // takes its own row under the text.
              from === "user" ? "ms-auto me-2 -mt-3" : "mt-1.5",
            )}
          >
            {reaction}
          </span>
        ) : null}
      </div>
      {menuFor ? (
        <BotMessageMenu
          bubble={menuFor}
          from={from}
          quotable={quotable}
          time={messageTimeLabel(Date.parse(at))}
          excerpt={text.trim().split("\n", 1)[0]?.slice(0, 80) ?? ""}
          reaction={reaction}
          onReact={
            from === "bot" && chrome
              ? (emoji) => {
                  closeMenu();
                  chrome.react(messageId, emoji);
                }
              : undefined
          }
          onPick={pick}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

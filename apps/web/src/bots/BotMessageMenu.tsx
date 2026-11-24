import { BOT_REACTIONS, type BotReaction } from "@t3tools/contracts";
import { BrainIcon, CopyIcon, ReplyIcon, TextSelectIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
} from "../components/ui/menu";
import { t } from "../i18n";
import { menuCollisionPadding } from "../safeArea";

export type BotMenuPick = "reply" | "copy" | "select" | "thinking";

export function BotMessageMenu({
  bubble,
  from,
  quotable,
  time,
  excerpt,
  reaction,
  thinkingShown,
  onReact,
  onPick,
  onClose,
}: {
  readonly bubble: HTMLElement;
  readonly from: "bot" | "user";
  readonly quotable: boolean;
  readonly time: string;
  readonly excerpt: string;
  readonly reaction: string | undefined;
  /** Set on a reply whose turn shows no activity row: whether its thinking is open. */
  readonly thinkingShown: boolean | undefined;
  readonly onReact: ((emoji: BotReaction | null) => void) | undefined;
  readonly onPick: (pick: BotMenuPick) => void;
  readonly onClose: () => void;
}) {
  return (
    <Menu open onOpenChange={(open) => (open ? undefined : onClose())}>
      <MenuPopup
        data-bot-surface
        data-bot-sheet
        aria-label={t("Message actions")}
        anchor={bubble}
        align={from === "user" ? "end" : "start"}
        sideOffset={8}
        collisionPadding={menuCollisionPadding()}
      >
        {onReact ? (
          <>
            <div
              role="group"
              aria-label={t("React")}
              className="flex items-center gap-0.5 p-1 max-md:justify-between max-md:px-1.5"
            >
              {BOT_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={t("React {emoji}", { emoji })}
                  aria-pressed={reaction === emoji}
                  onClick={() => onReact(reaction === emoji ? null : emoji)}
                  className="flex size-9 cursor-pointer items-center justify-center rounded-full text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-accent max-md:size-11 max-md:text-2xl pointer-coarse:focus-visible:ring-0"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          {/* A phone's sheet may cover the message it acts on, so the label quotes it. */}
          <MenuGroupLabel>
            <span className="flex min-w-0 gap-1.5">
              <span className="shrink-0 tabular-nums">{time}</span>
              {excerpt ? <span className="min-w-0 truncate md:hidden">{excerpt}</span> : null}
            </span>
          </MenuGroupLabel>
          {quotable ? (
            <>
              <MenuItem onClick={() => onPick("reply")}>
                <ReplyIcon />
                {t("Reply")}
              </MenuItem>
              <MenuItem onClick={() => onPick("copy")}>
                <CopyIcon />
                {t("Copy")}
              </MenuItem>
              <MenuItem onClick={() => onPick("select")}>
                <TextSelectIcon />
                {t("Select text")}
              </MenuItem>
            </>
          ) : null}
          {thinkingShown === undefined ? null : (
            <MenuItem onClick={() => onPick("thinking")}>
              <BrainIcon />
              {thinkingShown ? t("Hide thinking") : t("Show thinking")}
            </MenuItem>
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

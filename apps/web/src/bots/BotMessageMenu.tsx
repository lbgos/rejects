import { BOT_REACTIONS, type BotReaction } from "@t3tools/contracts";
import { CopyIcon, ReplyIcon, TextSelectIcon } from "lucide-react";
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

export type BotMenuPick = "reply" | "copy" | "select";

export function BotMessageMenu({
  bubble,
  from,
  quotable,
  time,
  reaction,
  onReact,
  onPick,
  onClose,
}: {
  readonly bubble: HTMLElement;
  readonly from: "bot" | "user";
  readonly quotable: boolean;
  readonly time: string;
  readonly reaction: string | undefined;
  readonly onReact: ((emoji: BotReaction | null) => void) | undefined;
  readonly onPick: (pick: BotMenuPick) => void;
  readonly onClose: () => void;
}) {
  return (
    <Menu open onOpenChange={(open) => (open ? undefined : onClose())}>
      <MenuPopup
        data-bot-surface
        aria-label={t("Message actions")}
        anchor={bubble}
        align={from === "user" ? "end" : "start"}
        sideOffset={8}
        collisionPadding={menuCollisionPadding()}
      >
        {onReact ? (
          <>
            <div role="group" aria-label={t("React")} className="flex items-center gap-0.5 p-1">
              {BOT_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={t("React {emoji}", { emoji })}
                  aria-pressed={reaction === emoji}
                  onClick={() => onReact(reaction === emoji ? null : emoji)}
                  className="flex size-9 cursor-pointer items-center justify-center rounded-full text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-accent"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>
            <span className="tabular-nums">{time}</span>
          </MenuGroupLabel>
        </MenuGroup>
        {quotable ? (
          <>
            <MenuSeparator />
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
      </MenuPopup>
    </Menu>
  );
}

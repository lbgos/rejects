import type { ThreadId } from "@t3tools/contracts";
import { ReplyIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { t } from "../i18n";
import { setBotReply, useBotUi } from "./ui";

export function BotReplyChip({ threadId }: { threadId: ThreadId | null }) {
  const text = useBotUi((s) => (s.reply?.threadId === threadId ? s.reply.text : null));
  if (text === null) return null;
  return (
    <div
      data-testid="bot-reply-chip"
      className="flex min-h-11 min-w-0 items-center gap-2 ps-4 pe-1 text-sm text-muted-foreground max-md:ps-14.5 max-md:text-bot-callout"
    >
      {/* On a phone the quote starts at the field's text column; the + button owns the gutter. */}
      <ReplyIcon aria-hidden className="size-4 shrink-0 max-md:hidden" />
      <span className="min-w-0 flex-1 truncate">{text.replace(/\s+/g, " ").trim()}</span>
      <Button
        size="icon-xl"
        variant="ghost"
        aria-label={t("Cancel reply")}
        onClick={() => setBotReply(null)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

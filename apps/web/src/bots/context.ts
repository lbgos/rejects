import type { BotReaction, BotReactions, MessageId, ModelSelection } from "@t3tools/contracts";
import { createContext, type ReactNode } from "react";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";

export const BotThreadContext = createContext(false);

export interface BotChrome {
  /** The bot's name; auto-titling can rewrite the thread title after the first message. */
  readonly title: string;
  /** What the empty composer says: whom the message goes to, or that the bot is paused. */
  readonly placeholder: string;
  readonly header: ReactNode;
  readonly banner: ComposerBannerStackItem | null;
  readonly emptyState: ReactNode;
  readonly timelineEnd: ReactNode;
  readonly modelSelection: ModelSelection;
  readonly selectModel: (modelSelection: ModelSelection) => void;
  readonly sendDisabledReason: string | null;
  readonly historyFrom: string | undefined;
  readonly reactions: BotReactions | undefined;
  readonly react: (messageId: MessageId, emoji: BotReaction | null) => void;
}
export const BotChromeContext = createContext<BotChrome | null>(null);

export const BotReactionsContext = createContext<ReadonlyMap<string, string>>(new Map());

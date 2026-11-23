import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  ClockIcon,
  MessageSquareDotIcon,
  PauseIcon,
  PlayIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  Trash2Icon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

export const BOT_ACTION_ICONS: Record<string, LucideIcon> = {
  sliders: SlidersHorizontalIcon,
  pause: PauseIcon,
  play: PlayIcon,
  clock: ClockIcon,
  check: CheckIcon,
  "message-badge": MessageSquareDotIcon,
  trash: Trash2Icon,
  bell: BellIcon,
  "bell-off": BellOffIcon,
  share: Share2Icon,
  zap: ZapIcon,
};

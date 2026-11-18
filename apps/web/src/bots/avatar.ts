import type { BotRecord } from "@t3tools/contracts";
import {
  BotIcon,
  CircleCheckIcon,
  EyeIcon,
  GraduationCapIcon,
  InboxIcon,
  LayoutGridIcon,
  MusicIcon,
  NewspaperIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";

export const BOT_GLYPHS = {
  search: SearchIcon,
  manager: LayoutGridIcon,
  terminal: TerminalIcon,
  server: ServerIcon,
  music: MusicIcon,
  steward: CircleCheckIcon,
  news: NewspaperIcon,
  inbox: InboxIcon,
  study: GraduationCapIcon,
  watch: EyeIcon,
  bot: BotIcon,
};
export type BotGlyph = keyof typeof BOT_GLYPHS;

const NAME_GLYPHS: ReadonlyArray<readonly [RegExp, BotGlyph]> = [
  [/research|search|look ?up/, "search"],
  [/manager|admin/, "manager"],
  [/agent|code|coder/, "terminal"],
  [/home ?lab|server|host|infra|ops/, "server"],
  [/music|song|album/, "music"],
  [/steward|tidy|janitor/, "steward"],
  [/brief|digest|news/, "news"],
  [/inbox|mail|slack/, "inbox"],
  [/study|learn|quiz|tutor/, "study"],
  [/watch|monitor/, "watch"],
];

export function botGlyph(name: string, kind?: BotRecord["kind"]): BotGlyph {
  if (kind === "music") return "music";
  const lower = name.trim().toLowerCase();
  return NAME_GLYPHS.find(([pattern]) => pattern.test(lower))?.[1] ?? "bot";
}

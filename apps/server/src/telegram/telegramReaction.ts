/** The emoji Telegram lets a bot react with (Bot API `ReactionTypeEmoji`), without variation selectors. */
const ALLOWED = new Set(
  "👍👎❤🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳🌚🌭💯🤣⚡🍌🏆💔🤨😐🍓🍾💋🖕😈😴😭🤓👻👀🎃🙈😇😨🤝✍🤗🫡🎅🎄☃💅🤪🗿🆒💘🙉🦄😘💊🙊😎👾🤷😡",
);

const NEAREST: Readonly<Record<string, string>> = {
  "✅": "👌",
  "☑": "👌",
  "✔": "👌",
  "😂": "🤣",
  "😆": "🤣",
  "‼": "⚡",
  "❗": "⚡",
  "❓": "🤔",
  "❔": "🤔",
  "⏰": "🫡",
  "⏳": "🫡",
  "⌛": "🫡",
  "🔔": "🫡",
  "📅": "🫡",
  "🗓": "🫡",
  "🧾": "✍",
  "📝": "✍",
  "🖊": "✍",
  "🔎": "👀",
  "🔍": "👀",
  "🧐": "👀",
  "🙂": "😁",
  "😊": "😁",
  "😄": "😁",
  "💪": "👏",
  "🚀": "🔥",
  "💥": "🔥",
  "😅": "😁",
  "😬": "😨",
  "🥲": "😢",
};

export const telegramReaction = (emoji: string) => {
  const bare = emoji.replaceAll("️", "");
  return ALLOWED.has(bare) ? bare : (NEAREST[bare] ?? "👍");
};

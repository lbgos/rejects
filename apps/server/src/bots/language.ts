import type { OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export type ChatLanguage = "en" | "ru" | "uk";

export const languageName: Record<ChatLanguage, string> = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
};

type Message = Pick<
  OrchestrationV2ConversationMessage,
  "role" | "text" | "createdBy" | "scheduledTaskId" | "createdAt"
>;

const LETTER = /\p{L}/u;
// A slash command such as "/compact", the stand-in for files sent without text and file or
// thread references ("[notes.md](t3-context://…)") are English the user did not write.
const SLASH_COMMAND = /^\s*\/[\w-]+(?=\s|$)/u;
const typedText = (text: string) =>
  replaceComposerContextReferences(text, () => "")
    .replace(SLASH_COMMAND, "")
    .replace(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, "");
const CYRILLIC = /\p{Script=Cyrillic}/u;
const CYRILLIC_WORD = /[\p{Script=Cyrillic}'ʼ’]+/gu;
const UKRAINIAN_LETTERS = /[іїєґ]|\p{Script=Cyrillic}['ʼ’]\p{Script=Cyrillic}/u;
const RUSSIAN_LETTERS = /[ыэъё]/u;
const UKRAINIAN_WORDS = new Set(
  "й що це але як чи щоб або вже ще де хто коли дуже треба зараз можна немає ласка дякую".split(
    " ",
  ),
);
const RUSSIAN_WORDS = new Set(
  "и что это но как или чтобы уже где кто когда очень надо сейчас можно нет да он она они мне тебе меня тебя пожалуйста спасибо привет хорошо только назови".split(
    " ",
  ),
);

const cyrillicLanguage = (text: string): "ru" | "uk" | undefined => {
  let lean = 0;
  for (const word of text.toLowerCase().match(CYRILLIC_WORD) ?? []) {
    if (UKRAINIAN_LETTERS.test(word) || UKRAINIAN_WORDS.has(word)) lean += 1;
    else if (RUSSIAN_LETTERS.test(word) || RUSSIAN_WORDS.has(word)) lean -= 1;
  }
  return lean > 0 ? "uk" : lean < 0 ? "ru" : undefined;
};

// The instance's choice from the first run; one server serves one instance. BotStore sets it.
let defaultLanguage: ChatLanguage = "en";
export const setDefaultChatLanguage = (language: ChatLanguage) => {
  defaultLanguage = language;
};

export const chatLanguage = (
  messages: ReadonlyArray<Message>,
  fallback: ChatLanguage = defaultLanguage,
): ChatLanguage => {
  const typed = messages
    .filter((m) => m.role === "user" && m.createdBy === "user" && m.scheduledTaskId === undefined)
    .map((m) => ({ text: typedText(m.text), createdAt: m.createdAt }))
    .filter((m) => LETTER.test(m.text))
    .toSorted((a, b) => DateTime.Order(b.createdAt, a.createdAt));
  if (typed[0] === undefined) return fallback;
  if (!CYRILLIC.test(typed[0].text)) return "en";
  for (const message of typed) {
    const lean = CYRILLIC.test(message.text) ? cyrillicLanguage(message.text) : undefined;
    if (lean !== undefined) return lean;
  }
  return fallback === "uk" ? "uk" : "ru";
};

export const chatLanguageOf = <E>(
  threads: {
    getThreadRecords(
      threadId: ThreadId,
      fields: ReadonlyArray<"messages">,
      filter: {
        readonly messageRoles: ReadonlyArray<"user">;
        readonly turnItemTypes: ReadonlyArray<never>;
      },
    ): Effect.Effect<{ readonly messages: ReadonlyArray<Message> }, E>;
  },
  botThreadId: ThreadId,
) =>
  threads
    .getThreadRecords(botThreadId, ["messages"], { messageRoles: ["user"], turnItemTypes: [] })
    .pipe(
      Effect.map((records) => chatLanguage(records.messages)),
      Effect.orElseSucceed(() => defaultLanguage),
    );

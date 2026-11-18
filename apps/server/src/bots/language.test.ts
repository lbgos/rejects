import { assert, it } from "@effect/vitest";
import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { chatLanguage, chatLanguageOf, setDefaultChatLanguage } from "./language.ts";

const typed = (minute: number, text: string) => ({
  role: "user" as const,
  text,
  createdBy: "user" as const,
  createdAt: DateTime.makeUnsafe(minute * 60_000),
});

it.each([
  { name: "an empty chat", messages: [], expected: "en" },
  { name: "an empty chat with Ukrainian chosen", messages: [], fallback: "uk", expected: "uk" },
  {
    name: "an English message with Ukrainian chosen",
    messages: [typed(1, "status?")],
    fallback: "uk",
    expected: "en",
  },
  {
    name: "a reply that leans neither way with Ukrainian chosen",
    messages: [typed(1, "ок")],
    fallback: "uk",
    expected: "uk",
  },
  { name: "a Russian message", messages: [typed(1, "чё там по хостам?")], expected: "ru" },
  {
    name: "Russian with Latin names",
    messages: [typed(1, "скачай justice waters of nazareth ep, flac")],
    expected: "ru",
  },
  {
    name: "the latest message, wherever it sits",
    messages: [typed(2, "status?"), typed(1, "чё там по хостам?")],
    expected: "en",
  },
  {
    name: "a reply without letters, which keeps the earlier language",
    messages: [typed(1, "скачай in rainbows"), typed(2, "1"), typed(3, "👍")],
    expected: "ru",
  },
  {
    name: "a Ukrainian message",
    messages: [typed(1, "Назви два кольори й скажи, що ти вмієш.")],
    expected: "uk",
  },
  {
    name: "a mostly Ukrainian message with a Russian clause",
    messages: [typed(1, "Я пишу по-русски, але назви кольори українською: два кольори, коротко.")],
    expected: "uk",
  },
  {
    name: "a mostly Russian message with a Ukrainian thank-you",
    messages: [typed(1, "Назови, пожалуйста, два цвета и скажи, что ты умеешь. Дякую!")],
    expected: "ru",
  },
  {
    name: "a reply that leans neither way, which keeps the earlier Cyrillic language",
    messages: [typed(1, "що там з бекапами?"), typed(2, "status?"), typed(3, "ок")],
    expected: "uk",
  },
  {
    name: "a slash command or files without text, which keep the earlier language",
    messages: [
      typed(1, "глянь файл"),
      typed(2, "/compact"),
      typed(3, ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
      typed(4, "[100 - CT Jellyfin.md](t3-context://v1/file/file_bad4903e)"),
    ],
    expected: "ru",
  },
  {
    name: "a slash command's own words",
    messages: [typed(1, "/compact оставь заметки")],
    expected: "ru",
  },
  {
    name: "server and wake messages, which the user did not type",
    messages: [
      typed(1, "напомни про снапшоты"),
      { ...typed(2, "[Wake: watch] Run the watch."), createdBy: "agent" as const },
      { ...typed(3, "Run the watch."), scheduledTaskId: ScheduledTaskId.make("watch") },
      { ...typed(4, "Saved."), role: "assistant" as const },
    ],
    expected: "ru",
  },
] as const)("chatLanguage: $name", (row) => {
  assert.equal(chatLanguage(row.messages, "fallback" in row ? row.fallback : "en"), row.expected);
});

it.effect("a chat with nothing typed answers in the owner's language", () =>
  Effect.gen(function* () {
    setDefaultChatLanguage("ru");
    yield* Effect.addFinalizer(() => Effect.sync(() => setDefaultChatLanguage("en")));
    assert.equal(chatLanguage([]), "ru");
    const unreadable = {
      getThreadRecords: () => Effect.fail("down" as const),
    };
    assert.equal(yield* chatLanguageOf(unreadable, ThreadId.make("bot")).pipe(Effect.orDie), "ru");
  }),
);

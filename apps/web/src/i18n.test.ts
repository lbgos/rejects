import { expect, it } from "vite-plus/test";
import { pluralIn } from "./i18n";
import { RU } from "./i18n.ru";
import { UK } from "./i18n.uk";

const bots = {
  en: ["{count} bot", "{count} bots"],
  uk: ["{count} бот", "{count} боти", "{count} ботів"],
  ru: ["{count} бот", "{count} бота", "{count} ботов"],
} as const;

it.each([
  ["en", 1, "1 bot"],
  ["en", 5, "5 bots"],
  ["uk", 1, "1 бот"],
  ["uk", 3, "3 боти"],
  ["uk", 11, "11 ботів"],
  ["ru", 1, "1 бот"],
  ["ru", 2, "2 бота"],
  ["ru", 5, "5 ботов"],
  ["ru", 21, "21 бот"],
] as const)("%s, %i: %s", (language, count, text) => {
  expect(pluralIn(language, count, bots)).toBe(text);
});

it("Russian has every Ukrainian key, with the same placeholders", () => {
  expect(Object.keys(RU).sort()).toEqual(Object.keys(UK).sort());
  for (const [key, uk] of Object.entries(UK)) {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    expect(placeholders(RU[key as keyof typeof RU]), key).toEqual(placeholders(uk));
  }
});

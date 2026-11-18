import { RU } from "./i18n.ru";
import { UK } from "./i18n.uk";

/** The English text is the key, so a `t()` call without a Ukrainian or Russian entry fails typecheck. */
export type UiLanguage = "en" | "uk" | "ru";
export type UiLanguageChoice = UiLanguage | "browser";
export type UiText = keyof typeof UK;

const STORAGE_KEY = "t3code:ui-language";

export function readUiLanguageChoice(): UiLanguageChoice {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === "en" || stored === "uk" || stored === "ru" ? stored : "browser";
  } catch {
    return "browser";
  }
}

function browserUiLanguage(languages: ReadonlyArray<string>): UiLanguage {
  for (const tag of languages) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "uk" || base === "en" || base === "ru") return base;
  }
  return "en";
}

export const browserLanguage = browserUiLanguage(
  globalThis.navigator?.languages ??
    (globalThis.navigator?.language ? [globalThis.navigator.language] : []),
);

const choice = readUiLanguageChoice();
export const uiLanguage: UiLanguage = choice === "browser" ? browserLanguage : choice;

export function setUiLanguageChoice(choice: UiLanguageChoice) {
  try {
    if (choice === "browser") globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, choice);
  } catch {
    // Without storage the choice lasts until the reload below; the browser's language returns.
  }
  globalThis.location?.reload();
}

export const uiLocales: ReadonlyArray<string> = uiLanguage === "en" ? [] : [uiLanguage];

export function t(text: UiText, values?: Readonly<Record<string, string | number>>): string {
  const template: string = uiLanguage === "uk" ? UK[text] : uiLanguage === "ru" ? RU[text] : text;
  return values === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : match,
      );
}

type SlavicForms = readonly [one: string, few: string, many: string];
interface PluralForms {
  readonly en: readonly [one: string, other: string];
  readonly uk: SlavicForms;
  readonly ru: SlavicForms;
}

export function pluralIn(language: UiLanguage, count: number, forms: PluralForms): string {
  const number = count.toLocaleString(language === "en" ? [] : [language]);
  if (language === "en") return forms.en[count === 1 ? 0 : 1].replace("{count}", number);
  const rule = new Intl.PluralRules(language).select(count);
  const [one, few, many] = forms[language];
  return (rule === "one" ? one : rule === "few" ? few : many).replace("{count}", number);
}

export const plural = (count: number, forms: PluralForms) => pluralIn(uiLanguage, count, forms);

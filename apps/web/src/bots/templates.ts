import { BOT_TEMPLATES as TEMPLATES, type BotTemplateId } from "@t3tools/contracts";
import { uiLanguage } from "../i18n";

/** The persona stays English, as the model reads it. */
export const BOT_TEMPLATES = TEMPLATES.filter((template) => template.id !== "main").map(
  (template) => {
    const text = template.text[uiLanguage];
    return {
      id: template.id,
      name: text.name,
      description: text.purpose,
      persona: template.persona,
      starters: text.examples,
      tools: template.tools,
    };
  },
);

export type { BotTemplateId };

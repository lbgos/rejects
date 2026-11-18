import {
  BOT_OWN_SKILLS_MAX,
  botTemplate,
  BotOwnSkill,
  SETUP_TEMPLATE_IDS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import SKILL_GUIDELINES from "./skillGuidelines.json" with { type: "json" };
import skills from "./skills.json" with { type: "json" };

export type BotSkill = (typeof skills)[number];
export { SKILL_GUIDELINES };

const appendix: Readonly<Record<string, () => string>> = {
  "skill-creator": () => SKILL_GUIDELINES,
  "bot-setup": () =>
    `Templates, by id:${SETUP_TEMPLATE_IDS.map((id) => {
      const { text } = botTemplate(id);
      return `\n- ${id} ("${text.en.name}", "${text.uk.name}", "${text.ru.name}"): ${text.en.purpose}`;
    }).join("")}`,
};

type Failure = { readonly ok: false; readonly error: string };

const builtInBody = (name: string) => {
  const body = skills.find((skill) => skill.name === name)?.body;
  const extra = appendix[name]?.();
  return body !== undefined && extra ? `${body}\n\n${extra}` : body;
};

export const skillsFor = (has: (tool: string) => boolean): ReadonlyArray<BotSkill> =>
  skills.filter((skill) => skill.tools.every(has));

export const skillIndex = (available: ReadonlyArray<Pick<BotSkill, "name" | "description">>) =>
  available.length === 0
    ? ""
    : `Skills: when a line applies, call read_skill with that name first and follow what it returns.${available
        .map((skill) => `\n- ${skill.description}, use skill ${skill.name}.`)
        .join("")}`;

const named = (name: string) => name.trim().toLowerCase();
const isOwnSkill = Schema.is(BotOwnSkill);

export const readSkill = (
  name: string,
  has: (tool: string) => boolean,
  own: ReadonlyArray<BotOwnSkill> = [],
): { readonly ok: true; readonly body: string } | Failure => {
  const available = [...skillsFor(has), ...own];
  const skill = available.find((entry) => entry.name === named(name));
  if (!skill)
    return {
      ok: false,
      error: `No skill "${name}". Yours: ${available.map((entry) => entry.name).join(", ") || "none"}.`,
    };
  return { ok: true, body: builtInBody(skill.name) ?? skill.body };
};

/** Bots copy the em dash from their own text into replies, so a written skill carries none. */
const withoutEmDash = (text: string) => text.replace(/\s*—\s*/g, ": ").trim();

export const writeOwnSkill = (
  own: ReadonlyArray<BotOwnSkill>,
  input: { readonly name: string; readonly description: string; readonly body: string },
  at: string,
): { readonly ok: true; readonly skills: ReadonlyArray<BotOwnSkill> } | Failure => {
  const name = named(input.name);
  const description = withoutEmDash(input.description);
  if (skills.some((skill) => skill.name === name))
    return { ok: false, error: `"${name}" is a built-in skill. Pick another name.` };
  if (!/^when\b/i.test(description))
    return { ok: false, error: 'Start the description with "When", such as "When asked for ...".' };
  const skill = { name, description, body: withoutEmDash(input.body), updatedAt: at };
  // The nightly check's output is unchecked; the store refuses to save a skill over the limits.
  if (!isOwnSkill(skill))
    return {
      ok: false,
      error:
        "Keep the name to 40 lowercase letters, digits and dashes, the description to 160 characters and the body to 4000.",
    };
  const index = own.findIndex((entry) => entry.name === name);
  if (index >= 0) return { ok: true, skills: own.map((entry, i) => (i === index ? skill : entry)) };
  if (own.length >= BOT_OWN_SKILLS_MAX)
    return {
      ok: false,
      error: `You have ${BOT_OWN_SKILLS_MAX} skills. Rewrite one or delete one with delete_skill.`,
    };
  return { ok: true, skills: [...own, skill] };
};

export const deleteOwnSkill = (
  own: ReadonlyArray<BotOwnSkill>,
  name: string,
): { readonly ok: true; readonly skills: ReadonlyArray<BotOwnSkill> } | Failure =>
  own.some((entry) => entry.name === named(name))
    ? { ok: true, skills: own.filter((entry) => entry.name !== named(name)) }
    : { ok: false, error: `You have no skill "${name}".` };

/**
 * Inline `code` spans in a skill body that none of `evidence` (the tool calls a skill was learned
 * from) contains: commands the bot would be writing down without having run them.
 */
export const unverifiedCommands = (body: string, evidence: ReadonlyArray<string>) => {
  const seen = evidence.join("\n");
  return [...body.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((command) => command.length > 0 && !seen.includes(command));
};

export function writeSkillRefusal(input: {
  readonly body: string;
  readonly calls: ReadonlyArray<string>;
  readonly earlierWrites: number;
  readonly existingBody?: string | undefined;
}): string | undefined {
  const readRules = input.calls.some(
    (call) => call.startsWith("read_skill") && call.includes('"skill-creator"'),
  );
  if (!readRules && input.earlierWrites === 0)
    return `Not saved yet. Follow these rules, then call write_skill again:\n\n${builtInBody("skill-creator") ?? ""}`;
  const unverified = unverifiedCommands(input.body, [...input.calls, input.existingBody ?? ""]);
  if (unverified.length > 0)
    return `Not saved: write only commands you ran this turn. Not run: ${unverified.join(", ")}.`;
  return undefined;
}

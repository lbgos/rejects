#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Vendors the owner's bot skills (`<skills repo>/bots/<name>/SKILL.md`) into
// apps/server/src/bots/skills.json, and the rules for skills bots write (`bots/GUIDELINES.md`)
// into skillGuidelines.json. Usage: node scripts/sync-bot-skills.ts <skills repo>/bots
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/sync-bot-skills.ts <skills repo>/bots");
const targetDir = NodePath.join(import.meta.dirname, "../apps/server/src/bots");
const target = NodePath.join(targetDir, "skills.json");
const guidelinesTarget = NodePath.join(targetDir, "skillGuidelines.json");

const skills = NodeFS.readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted()
  .map((dir) => {
    const text = NodeFS.readFileSync(NodePath.join(source, dir, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`${dir}: SKILL.md needs a --- frontmatter block.`);
    const fields = Object.fromEntries(
      match[1]!.split("\n").map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
    const skill = {
      name: fields.name ?? "",
      description: fields.description ?? "",
      tools: (fields.tools ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean),
      body: match[2]!.trim(),
    };
    if (skill.name !== dir) throw new Error(`${dir}: name must be "${dir}".`);
    if (!skill.description.startsWith("When"))
      throw new Error(`${dir}: description must start with "When".`);
    if (skill.tools.length === 0) throw new Error(`${dir}: tools must name at least one tool.`);
    if (text.includes("—")) throw new Error(`${dir}: no em dash in bot skills.`);
    return skill;
  });

const guidelines = NodeFS.readFileSync(NodePath.join(source, "GUIDELINES.md"), "utf8").trim();
if (guidelines.includes("—")) throw new Error("GUIDELINES.md: no em dash in bot skills.");

NodeFS.writeFileSync(target, `${JSON.stringify(skills, null, 2)}\n`);
NodeFS.writeFileSync(guidelinesTarget, `${JSON.stringify(guidelines)}\n`);
console.log(
  `${skills.length} skills and guidelines -> ${NodePath.relative(process.cwd(), targetDir)}`,
);

import { describe, expect, it } from "@effect/vitest";
import type { BotOwnSkill, MemoryNote } from "@t3tools/contracts";
import {
  applySkillDream,
  type SkillDreamOutput,
  type SkillDreamRun,
  skillDreamPrompt,
} from "./skillDreams.ts";
import { SKILL_GUIDELINES } from "./skills.ts";

const NOW = "2026-11-12T03:30:00.000Z";
const CALLS = ["shell bash homelab/check.sh backups", 'notify_user {"text":"node2 failed"}'];
const LATER = "2026-11-13T09:00:00.000Z";
const run = (ordinal: number, at = NOW): SkillDreamRun => ({
  id: `run:thread:c20c38e7-f6c1-49d9-a37d-fcca588baa99:ordinal:${ordinal}`,
  at,
  request: "backup report",
  calls: CALLS,
});
const note = (id: string, by: string): MemoryNote => ({
  id,
  text: "Backup report: run homelab/check.sh backups.",
  status: "fresh",
  source: { by, at: NOW },
});
const proposal = (fields: Partial<SkillDreamOutput["skills"][number]> = {}) => ({
  name: "backup-report",
  description: "When asked for the backup report",
  body: "1. Run `bash homelab/check.sh backups`.\n2. Send failures with `notify_user`.",
  runs: ["r1", "r2"],
  noteIds: [],
  ...fields,
});
const dream = (
  skills: SkillDreamOutput["skills"],
  input: { own?: ReadonlyArray<BotOwnSkill>; runs?: ReadonlyArray<SkillDreamRun> } = {},
) =>
  applySkillDream({
    own: input.own ?? [],
    output: { skills },
    runs: input.runs ?? [run(3), run(4)],
    notes: [note("n-bot", "Homelab"), note("n-user", "user")],
    now: NOW,
  });

describe("skillDreamPrompt", () => {
  it("gives the model the owner's guidelines for every skill it writes", () => {
    const prompt = skillDreamPrompt({ bot: "Homelab", runs: [run(3)], skills: [], notes: [] });
    expect(prompt).toContain(`<guidelines>\n${SKILL_GUIDELINES}\n</guidelines>`);
    expect(prompt).toContain("[r1] 2026-11-12 03:30 user: backup report");
    expect(prompt).not.toContain(run(3).id);
  });
});

describe("applySkillDream", () => {
  it("writes a repeated procedure and moves the bot's note, never the user's", () => {
    const result = dream([proposal({ noteIds: ["n-bot", "n-user"] })]);
    expect(result.written).toEqual([{ name: "backup-report", created: true }]);
    expect(result.skills.map((s) => s.name)).toEqual(["backup-report"]);
    expect(result.movedNotes).toEqual([{ id: "n-bot", skill: "backup-report" }]);
  });

  it.each([
    ["one run", proposal({ runs: ["r1"] }), "backup-report: not repeated"],
    ["unknown runs", proposal({ runs: ["r9", "r8"] }), "backup-report: not repeated"],
    [
      "a step never run",
      proposal({ body: "1. Run `pvesh get /nodes`." }),
      "backup-report: steps never run (pvesh get /nodes)",
    ],
    [
      "a body the bot store cannot save",
      proposal({ body: `1. ${"Check the backups. ".repeat(220)}` }),
      "backup-report: Keep the name to 40 lowercase letters, digits and dashes, the description to 160 characters and the body to 4000.",
    ],
  ])("refuses %s", (_, skill, reason) => {
    const result = dream([skill]);
    expect(result.written).toEqual([]);
    expect(result.refused).toEqual([reason]);
  });

  it("cuts an over-long description at a word boundary and keeps the rest of the batch", () => {
    // From a real night: 163 characters against the 160 the store saves.
    const long =
      "When the user asks about a model, paper, technique, architecture or benchmark, or sends a link to one, and wants to know what it is, how it works or how good it is";
    const result = dream([
      proposal({ name: "tech-lookup", description: long }),
      proposal({ body: `1. ${"Check the backups. ".repeat(220)}` }),
    ]);
    expect(result.written).toEqual([{ name: "tech-lookup", created: true }]);
    expect(result.skills[0]?.description).toBe(
      "When the user asks about a model, paper, technique, architecture or benchmark, or sends a link to one, and wants to know what it is, how it works or how good it",
    );
    expect(result.refused).toHaveLength(1);
  });

  it("accepts one run backed by a bot note, or an update of an existing skill", () => {
    expect(dream([proposal({ runs: ["r1"], noteIds: ["n-bot"] })]).written).toHaveLength(1);
    const own = dream([proposal()]).skills;
    const update = dream([proposal({ runs: ["r1"], body: `${proposal().body}\n3. Stop.` })], {
      own,
      runs: [run(5, LATER)],
    });
    expect(update.written).toEqual([{ name: "backup-report", created: false }]);
    expect(update.skills[0]?.body).toMatch(/3\. Stop\.$/);
  });

  it.each([
    [
      "the same content with other whitespace",
      { runs: ["r1"], body: proposal().body.replace(". ", ".  ") },
      [run(5, LATER)],
    ],
    ["the runs it was learned from", { body: `${proposal().body}\n3. Stop.` }, [run(3), run(4)]],
  ])("leaves an existing skill alone for %s", (_, fields, runs) => {
    const own = dream([proposal()]).skills;
    const again = dream([proposal(fields)], { own, runs });
    expect(again.written).toEqual([]);
    expect(again.skills).toBe(own);
  });
});

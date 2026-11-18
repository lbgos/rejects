import { describe, expect, it } from "@effect/vitest";
import { BOT_OWN_SKILLS_MAX, ThreadId } from "@t3tools/contracts";
import { botToolNames } from "../mcp/BotTools.ts";
import { botInstructions } from "./instructions.ts";
import {
  deleteOwnSkill,
  readSkill,
  SKILL_GUIDELINES,
  skillIndex,
  skillsFor,
  unverifiedCommands,
  writeOwnSkill,
  writeSkillRefusal,
} from "./skills.ts";

const holding =
  (...tools: ReadonlyArray<string>) =>
  (tool: string) =>
    tools.includes(tool);

const AT = "2026-11-11T10:00:00.000Z";
const report = {
  name: "backup-report",
  description: "When asked for the weekly backup report",
  body: "1. Check node1 and node2.",
};
const written = (input = report) => {
  const result = writeOwnSkill([], input, AT);
  if (!result.ok) throw new Error(result.error);
  return result.skills;
};

describe("bot skills", () => {
  it("offers a built-in skill only to a bot holding every tool it needs", () => {
    expect(skillsFor(holding("music_search", "music_download")).map((s) => s.name)).toEqual([]);
    expect(
      skillsFor(holding("music_search", "music_download", "music_status")).map((s) => s.name),
    ).toEqual(["music"]);
  });

  it("names only tools some bot holds, so every built-in skill reaches a bot", () => {
    const held = new Set(
      [
        botToolNames(),
        botToolNames({ main: true }),
        botToolNames({ skills: ["music"] }),
        botToolNames({ readsAccounts: true, mail: true }),
        botToolNames({ bridge: "operate" }),
        botToolNames({ modelTemplate: "lead" }),
      ].flatMap((tools) => [...tools]),
    );
    const all = skillsFor(() => true);
    expect(skillsFor((tool) => held.has(tool))).toEqual(all);
    expect(
      skillsFor((tool) => botToolNames({ sealed: false }).has(tool)).map((s) => s.name),
    ).toContain("video");
  });

  it("indexes one trigger line per skill, and nothing without skills", () => {
    expect(skillIndex([])).toBe("");
    expect(skillIndex(skillsFor(holding("propose_bots", "bot_create"))).split("\n")).toEqual([
      "Skills: when a line applies, call read_skill with that name first and follow what it returns.",
      expect.stringMatching(/^- When .+, use skill bot-setup\.$/),
    ]);
  });

  it("reads built-in skills the tools allow and the bot's own, with templates on bot-setup", () => {
    const main = holding("propose_bots", "bot_create");
    const setup = readSkill(" Bot-Setup ", main);
    expect(setup.ok && setup.body).toMatch(/propose_bots[\s\S]*Templates, by id:\n- \w/);
    expect(readSkill("backup-report", main, written())).toEqual({ ok: true, body: report.body });
    expect(readSkill("music", main, written())).toEqual({
      ok: false,
      error: 'No skill "music". Yours: bot-setup, backup-report.',
    });
  });

  it("writes a skill, rewrites it by name and deletes it", () => {
    const own = written({ ...report, body: "1. Old — step." });
    expect(own).toEqual([{ ...report, body: "1. Old: step.", updatedAt: AT }]);
    const rewritten = writeOwnSkill(own, { ...report, name: "Backup-Report" }, AT);
    expect(rewritten.ok && rewritten.skills).toEqual([{ ...report, updatedAt: AT }]);
    expect(deleteOwnSkill(own, "backup-report")).toEqual({ ok: true, skills: [] });
    expect(deleteOwnSkill(own, "other").ok).toBe(false);
  });

  it("refuses built-in names, triggers without When, and a full set", () => {
    expect(writeOwnSkill([], { ...report, name: "music" }, AT).ok).toBe(false);
    expect(writeOwnSkill([], { ...report, description: "Backup report" }, AT).ok).toBe(false);
    const full = Array.from({ length: BOT_OWN_SKILLS_MAX }, (_, i) => ({
      ...report,
      name: `s${i}`,
      updatedAt: AT,
    }));
    expect(writeOwnSkill(full, report, AT).ok).toBe(false);
    expect(writeOwnSkill(full, { ...report, name: "s3" }, AT).ok).toBe(true);
  });

  it("names the backticked commands a body uses that the evidence never ran", () => {
    const body =
      "1. Run `bash homelab/check.sh backups`.\n2. Call `notify_user`.\n3. Run `pvesh get /nodes`.";
    expect(
      unverifiedCommands(body, [
        "shell bash homelab/check.sh backups",
        'notify_user {"text":"ok"}',
      ]),
    ).toEqual(["pvesh get /nodes"]);
    expect(unverifiedCommands("1. Check the hosts.", [])).toEqual([]);
  });

  it("returns skill-creator's rules on a run's first write, then checks the commands", () => {
    const body = "1. Run `bash homelab/check.sh backups`.";
    const ran = ["shell bash homelab/check.sh backups"];
    const rules = writeSkillRefusal({ body, calls: ran, earlierWrites: 0 });
    expect(rules).toMatch(/^Not saved yet\. Follow these rules[\s\S]*write_skill refuses/);
    expect(rules?.endsWith(SKILL_GUIDELINES)).toBe(true);
    const creator = readSkill("skill-creator", holding("write_skill", "delete_skill"));
    expect(creator.ok && creator.body.endsWith(`\n\n${SKILL_GUIDELINES}`)).toBe(true);
    const read = [...ran, 'read_skill {"name":"skill-creator"}'];
    expect(writeSkillRefusal({ body, calls: read, earlierWrites: 0 })).toBeUndefined();
    expect(writeSkillRefusal({ body, calls: ran, earlierWrites: 1 })).toBeUndefined();
    expect(
      writeSkillRefusal({ body, calls: [], earlierWrites: 1, existingBody: body }),
    ).toBeUndefined();
    expect(writeSkillRefusal({ body, calls: [], earlierWrites: 1 })).toBe(
      "Not saved: write only commands you ran this turn. Not run: bash homelab/check.sh backups.",
    );
  });

  it("puts the index in a bot's instructions from its tools and its own skills", () => {
    const instructions = (bot: Partial<Parameters<typeof botInstructions>[0]["bot"]>) =>
      botInstructions({
        bot: { name: "Homelab", persona: "Watches hosts.", dailyTokenCap: 1, ...bot },
        roster: [],
        messagesPerHour: 6,
        timeZone: "UTC",
      });
    expect(instructions({ tools: ["notify_user"] })).not.toContain("read_skill");
    expect(instructions({ tools: ["notify_user", "react"] })).not.toContain("offer_replies");
    expect(instructions({ tools: ["notify_user", "offer_replies"] })).toContain("offer_replies");
    expect(instructions({})).toContain("offer_replies");
    const unlinked = botInstructions({
      bot: { name: "Main", persona: "Front door.", dailyTokenCap: 1 },
      roster: [],
      messagesPerHour: 6,
      timeZone: "UTC",
      main: true,
      telegramLinked: false,
    });
    expect(unlinked).not.toContain("send_telegram");
    expect(unlinked).not.toContain("Telegram");
    // Main names the thread tools only while it holds them: a sealed Main has none.
    const main = (sealed: boolean) =>
      botInstructions({
        bot: { name: "Main", persona: "Front door.", dailyTokenCap: 1 },
        roster: [],
        messagesPerHour: 6,
        timeZone: "UTC",
        main: true,
        sealed,
      });
    expect(main(false)).toContain("t3_thread_send the task in the user's words");
    expect(main(false)).toContain("call hand_off with that bot and the request");
    expect(main(true)).not.toContain("t3_thread_");
    // Another unsealed bot reads its peers' chats, whatever its tool list; a sealed one cannot.
    const peer = (sealed: boolean, tools = ["notify_user", "web_search"]) =>
      botInstructions({
        bot: { name: "Deep", persona: "Thinks.", dailyTokenCap: 1, tools },
        roster: [{ name: "Research", persona: "Finds.", threadId: ThreadId.make("research") }],
        messagesPerHour: 6,
        timeZone: "UTC",
        sealed,
      });
    expect(peer(false)).toContain("t3_thread_read its chat");
    expect(peer(false)).toContain("t3_thread_send the question to its chat");
    // A run that read another bot cannot send, so the line says to ask first.
    expect(peer(false)).toContain("before you read any bot's chat");
    expect(peer(false)).not.toContain("the user taps the button to open that chat");
    expect(peer(false)).toContain("- Research (thread research)");
    expect(peer(true)).not.toContain("t3_thread_");
    expect(peer(false, ["notify_user", "computer_shell"])).not.toContain("t3_thread_");
    expect(instructions({ tools: ["notify_user"], skills: ["music"] })).toMatch(
      /\n- When .+, use skill music\.$/,
    );
    const own = instructions({ ownSkills: written() });
    expect(own).toContain("use skill skill-creator.");
    expect(own).toMatch(/\n- When asked for the weekly backup report, use skill backup-report\.$/);
  });
});

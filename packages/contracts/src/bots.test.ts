import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  botTemplateModels,
  chargedTokens,
  editNote,
  isReactionEcho,
  isSingleEmoji,
  type MemoryNote,
  setReaction,
  ShowUiInput,
  UI_TARGETS,
} from "./bots.ts";

it("counts cache reads at a tenth of fresh input", () => {
  assert.equal(
    chargedTokens({ inputTokens: 40_000, cachedInputTokens: 39_000, outputTokens: 100 }),
    1_000 + 3_900 + 100,
  );
  assert.equal(chargedTokens({ outputTokens: 7 }), 7);
});

it("treats emoji and short acknowledgements as a reaction's echo, and nothing with content", () => {
  for (const echo of [
    "👍",
    "❤️ ",
    "Ок.",
    "Понял",
    "Гаразд!",
    "Рад помочь 🙂",
    "Не за что",
    "Ok, got it.",
    "Готово 👍",
    "Reaction sent.",
    "(👍)",
    "*Done*",
    "No text.",
  ])
    assert.isTrue(isReactionEcho(echo), echo);
  for (const reply of [
    "",
    "Ок?",
    "Понял, напомню завтра",
    "Не понял",
    "Сумма: 49",
    "Пожалуйста, обращайся, если что-то ещё понадобится",
  ])
    assert.isFalse(isReactionEcho(reply), reply);
});

it("show_ui takes only a registry target and a short tip", () => {
  const valid = Schema.is(ShowUiInput);
  for (const target of UI_TARGETS) assert.isTrue(valid({ target, text: "Tap here" }), target);
  for (const input of [
    { target: "[data-chat-composer-dictation]", text: "Tap here" },
    { target: "Dictation", text: "Tap here" },
    { target: "dictation", text: "" },
    { target: "dictation", text: "x".repeat(201) },
  ])
    assert.isFalse(valid(input), JSON.stringify(input).slice(0, 60));
});

it("sets, moves to newest, clears and bounds reactions", () => {
  const two = setReaction(setReaction(undefined, "a", "👍"), "b", "❤️");
  assert.deepEqual(Object.entries(setReaction(two, "a", "😂")), [
    ["b", "❤️"],
    ["a", "😂"],
  ]);
  assert.deepEqual(setReaction(two, "a", null), { b: "❤️" });
  let many = setReaction(undefined, "m0", "👍");
  for (let i = 1; i <= 200; i++) many = setReaction(many, `m${i}`, "👍");
  assert.equal(Object.keys(many).length, 200);
  assert.equal(many.m0, undefined);
  assert.equal(many.m200, "👍");
});

describe("editNote", () => {
  const at = "2026-11-07T10:00:00.000Z";
  const stale: MemoryNote = {
    id: "n1",
    text: "Visits Lviv this week.",
    status: "stale",
    reason: "The week is over.",
    source: { by: "Travel", at },
  };
  const later = "2026-11-08T09:00:00.000Z";

  it("adds the user's note and skips a repeat", () => {
    const added = editNote([stale], null, "Prefers  short answers.", later);
    assert.deepEqual(added.at(-1), {
      id: added.at(-1)!.id,
      text: "Prefers short answers.",
      status: "fresh",
      source: { by: "user", at: later },
    });
    assert.strictEqual(editNote(added, null, "prefers short answers.", later), added);
  });

  it("marks a note fresh when saved unchanged, keeping its source", () => {
    assert.deepEqual(editNote([stale], "n1", "Visits Lviv this week.", later), [
      {
        id: "n1",
        text: "Visits Lviv this week.",
        status: "fresh",
        source: stale.source,
        checkedAt: later,
      },
    ]);
  });

  it("drops an end date that has passed when the user confirms or edits the note", () => {
    const ended = { ...stale, until: "2026-11-07" };
    assert.notProperty(editNote([ended], "n1", ended.text, later)[0], "until");
    assert.notProperty(editNote([ended], "n1", "Lives in Lviv.", later)[0], "until");
    const ahead = { ...stale, until: "2026-12-01" };
    assert.propertyVal(editNote([ahead], "n1", ahead.text, later)[0], "until", "2026-12-01");
  });

  it("makes an edited note the user's and forgets an emptied one", () => {
    assert.deepEqual(editNote([stale], "n1", "Lives in Lviv.", later), [
      { id: "n1", text: "Lives in Lviv.", status: "fresh", source: { by: "user", at: later } },
    ]);
    assert.deepEqual(editNote([stale], "n1", "  ", later), []);
    const fresh = editNote([stale], "n1", "Lives in Lviv.", later);
    assert.strictEqual(editNote(fresh, "n1", "Lives in Lviv.", later), fresh);
  });
});

describe("isSingleEmoji", () => {
  it("accepts one emoji with its selectors and joiners, nothing else", () => {
    for (const emoji of ["👀", "✍️", "❤️", "🫡", "👍🏽", "👨‍💻"])
      assert.isTrue(isSingleEmoji(emoji), emoji);
    for (const text of ["", "ok", "👀 ok", "👀👀", "👀👀x", "1"])
      assert.isFalse(isSingleEmoji(text), text);
  });
});

it("a template keeps the options of the models the bot already runs", () => {
  const source = (id: string, slug: string) => ({
    instanceId: ProviderInstanceId.make(id),
    driver: "claudeAgent",
    enabled: true,
    models: [{ slug, isCustom: true }],
  });
  const providers = [
    source("claudeAgent", "claude-opus-5-5"),
    source("claudeDeepseek", "deepseek-v4.1-flash"),
  ];
  const opus = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  const worker = {
    instanceId: ProviderInstanceId.make("claudeDeepseek"),
    model: "deepseek-v4.1-flash",
  };
  assert.deepEqual(botTemplateModels("lead", providers, { modelSelection: opus }), {
    modelSelection: opus,
    workerModel: worker,
  });
  assert.deepEqual(botTemplateModels("lead", providers), {
    modelSelection: { instanceId: opus.instanceId, model: opus.model },
    workerModel: worker,
  });
});

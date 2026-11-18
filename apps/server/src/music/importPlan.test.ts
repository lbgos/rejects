import { assert, it } from "@effect/vitest";
import { importPlan, type InspectedFile } from "./importPlan.ts";

const stream = { rate: 44_100, bits: 16, channels: 2, seconds: 200 };
const tagged = (n: number, title: string, extra: Record<string, string> = {}): InspectedFile => ({
  name: `${String(n).padStart(2, "0")} ${title}.flac`,
  size: 30_000_000,
  flac: stream,
  tags: {
    artist: "Nine Inch Nails",
    album: "The Slip",
    date: "2008-05-05",
    tracknumber: `${n}/10`,
    title,
    ...extra,
  },
});

it("names tagged FLAC as <Album Artist>/<Year> - <Album>/NN - Title", () => {
  const plan = importPlan(
    [tagged(2, "1,000,000"), tagged(1, "999,999"), tagged(10, "Demon Seed")],
    {
      artist: "NIN",
      album: "Slip",
    },
  );
  assert.strictEqual(plan.target, "Nine Inch Nails/2008 - The Slip");
  assert.deepStrictEqual(plan.files, [
    { from: "01 999,999.flac", to: "01 - 999,999.flac" },
    { from: "02 1,000,000.flac", to: "02 - 1,000,000.flac" },
    { from: "10 Demon Seed.flac", to: "10 - Demon Seed.flac" },
  ]);
  assert.deepStrictEqual(plan.summary, {
    artist: "Nine Inch Nails",
    album: "The Slip",
    year: 2008,
    tracks: 3,
    format: "FLAC 16/44",
  });
});

it("falls back to the hint and file names, and keeps every name a single safe segment", () => {
  const plain = (name: string): InspectedFile => ({ name, size: 1, flac: stream, tags: {} });
  const plan = importPlan(
    [
      plain("03. Why'd You Only Call Me When You're High?.flac"),
      plain("1 - Do I Wanna Know.flac"),
      plain("Intro.flac"),
    ],
    { artist: "AC/DC", album: "../../etc", year: 1980 },
  );
  assert.strictEqual(plan.target, "AC_DC/1980 - _.._etc");
  assert.deepStrictEqual(
    plan.files.map((file) => file.to),
    [
      "01 - Do I Wanna Know.flac",
      "03 - Why'd You Only Call Me When You're High_.flac",
      "Intro.flac",
    ],
  );
  for (const segment of plan.target.split("/")) assert.notInclude(["", ".", ".."], segment);
});

it("numbers discs on multi-disc sets and files compilations under Various Artists", () => {
  const plan = importPlan(
    [
      tagged(1, "Two", { discnumber: "2", artist: "B" }),
      tagged(1, "One", { discnumber: "1/2", artist: "A" }),
    ],
    { artist: "x", album: "y" },
  );
  assert.strictEqual(plan.target, "Various Artists/2008 - The Slip");
  assert.deepStrictEqual(
    plan.files.map((file) => file.to),
    ["1-01 - One.flac", "2-01 - Two.flac"],
  );
});

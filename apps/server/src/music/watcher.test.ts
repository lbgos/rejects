import { assert, it } from "@effect/vitest";
import { jobStep, STALL_MS, transferState, type Job, type Source } from "./watcher.ts";

const source = (username: string): Source => ({
  username,
  directory: `music\\${username}\\Album`,
  files: [
    { filename: `music\\${username}\\Album\\01.flac`, size: 100 },
    { filename: `music\\${username}\\Album\\02.flac`, size: 100 },
  ],
});
const job = (overrides: Partial<Job> = {}): Job => ({
  id: "j1",
  botThreadId: "bot",
  title: "Modjo – Modjo",
  hint: { artist: "Modjo", album: "Modjo", year: 2001 },
  status: "downloading",
  attempt: 1,
  current: source("first"),
  fallbacks: [source("second"), source("third")],
  startedAt: 0,
  progressAt: 0,
  bytes: 0,
  ...overrides,
});
const seen = (states: ReadonlyArray<[string, number]>, from = job().current) => ({
  files: states.map(([state, bytes], i) => ({
    filename: from.files[i]!.filename,
    state: transferState(state),
    bytes,
  })),
});

it.each([
  {
    name: "imports once every file succeeded",
    before: job(),
    observed: seen([
      ["Completed, Succeeded", 100],
      ["Completed, Succeeded", 100],
    ]),
    now: 1_000,
    status: "importing",
    action: "import",
  },
  {
    name: "retries the next-best folder when a file fails on the first try",
    before: job(),
    observed: seen([
      ["Completed, Succeeded", 100],
      ["Completed, Rejected", 0],
    ]),
    now: 1_000,
    status: "downloading",
    action: "retry",
    current: "second",
  },
  {
    name: "gives up when the retry fails too",
    before: job({ attempt: 2, current: source("second"), fallbacks: [source("third")] }),
    observed: seen([["Completed, Errored", 0]], source("second")),
    now: 1_000,
    status: "failed",
    action: "fail",
  },
  {
    name: "gives up on the first failure when no other folder fits",
    before: job({ fallbacks: [] }),
    observed: seen([["Completed, TimedOut", 0]]),
    now: 1_000,
    status: "failed",
    action: "fail",
  },
  {
    name: "counts bytes as progress",
    before: job({ bytes: 50 }),
    observed: seen([
      ["InProgress", 80],
      ["Queued, Remotely", 0],
    ]),
    now: STALL_MS + 1,
    status: "downloading",
    action: "none",
    progressAt: STALL_MS + 1,
  },
  {
    name: "retries a download that made no progress for the stall window",
    before: job({ bytes: 80, progressAt: 0 }),
    observed: seen([
      ["InProgress", 80],
      ["Queued, Remotely", 0],
    ]),
    now: STALL_MS + 1,
    status: "downloading",
    action: "retry",
    current: "second",
  },
  {
    name: "waits while a queue is short of the stall window",
    before: job(),
    observed: { files: [] },
    now: STALL_MS - 1,
    status: "downloading",
    action: "none",
  },
])("$name", ({ before, observed, now, status, action, ...expected }) => {
  const step = jobStep(before, observed, now);
  assert.strictEqual(step.job.status, status);
  assert.strictEqual(step.action.type, action);
  if ("current" in expected) {
    assert.strictEqual(step.job.current.username, expected.current);
    assert.strictEqual(step.job.attempt, 2);
    assert.strictEqual(step.job.bytes, 0);
    assert.strictEqual(step.job.progressAt, now);
    assert.deepStrictEqual(
      step.job.fallbacks.map((fallback) => fallback.username),
      ["third"],
    );
  }
  if ("progressAt" in expected) assert.strictEqual(step.job.progressAt, expected.progressAt);
});

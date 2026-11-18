import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { fakeTimers, render } from "../../test/render";
import { refreshBots, setViewingBot, useBot, useBots, useReadOnOpen } from "./state";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("study");
const mocks = vi.hoisted(() => ({
  connected: false,
  reads: [] as unknown[],
  lists: 0,
  listPayloads: [] as Array<{
    viewing?: string;
    left?: string;
    client?: string;
    timeZone?: string;
  }>,
}));

vi.mock("../state/session", () => ({
  usePreparedConnection: () => (mocks.connected ? Option.some({}) : Option.none()),
  readPreparedConnection: () => (mocks.connected ? {} : null),
}));
vi.mock("./http", () => ({
  botRequest: async (_environmentId: unknown, endpoint: { path: string }, payload: unknown) => {
    if (!mocks.connected) throw new Error("Not connected to the environment.");
    if (endpoint.path === "/api/bots/read") mocks.reads.push(payload);
    if (endpoint.path === "/api/bots/list") {
      mocks.lists++;
      mocks.listPayloads.push(payload as (typeof mocks.listPayloads)[number]);
    }
    return endpoint.path === "/api/bots/list"
      ? [
          {
            name: "Study",
            persona: "Quiz me",
            dailyTokenCap: 100,
            modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "flash" },
            threadId,
            projectId: ProjectId.make("bots"),
            createdAt: "2026-11-05T00:00:00Z",
            unread: mocks.reads.length === 0,
            lastNotification: "3 questions ready",
            notifiedAt: "2026-11-05T17:00:48.216Z",
            tokensToday: 0,
            usage: [],
            stopped: false,
            resumesAt: null,
          },
        ]
      : {};
  },
}));

function setup() {
  mocks.connected = false;
  mocks.reads = [];
  mocks.lists = 0;
  mocks.listPayloads = [];
}

function OpenBot() {
  useReadOnOpen(environmentId, useBot(environmentId, threadId));
  return null;
}

it("reads a persisted unread bot once the connection is ready", async () => {
  setup();
  mocks.connected = true;
  await refreshBots(environmentId);
  mocks.connected = false;
  await using screen = await render(<OpenBot />);
  mocks.connected = true;
  await screen.rerender(<OpenBot />);
  await vi.waitFor(() =>
    expect(mocks.reads).toEqual([{ threadId, notifiedAt: "2026-11-05T17:00:48.216Z" }]),
  );
});

function Reader() {
  useBots(environmentId);
  return null;
}

function Readers({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => <Reader key={index} />);
}

it("polls the bot list once per interval however many components read it", async () => {
  setup();
  mocks.connected = true;
  using _timers = fakeTimers();
  // No routes are involved, and the router would schedule its own work on the fake clock.
  await using screen = await render(<Readers count={1} />, { router: false });
  await vi.advanceTimersByTimeAsync(2500);
  await screen.rerender(<Readers count={2} />);
  await vi.advanceTimersByTimeAsync(100);
  mocks.lists = 0;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.lists).toBe(2);
});

it("reports the open bot chat as viewed only within two minutes of input", async () => {
  setup();
  mocks.connected = true;
  using now = vi.spyOn(Date, "now").mockReturnValue(0);
  setViewingBot(threadId);
  try {
    await refreshBots(environmentId);
    now.mockReturnValue(120_000);
    await refreshBots(environmentId);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    await refreshBots(environmentId);
  } finally {
    setViewingBot(undefined);
  }
  const [first, idle, back] = mocks.listPayloads;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect([first, idle, back]).toEqual([
    { viewing: threadId, client: first?.client, timeZone },
    { left: threadId, client: first?.client, timeZone },
    { viewing: threadId, client: first?.client, timeZone },
  ]);
  expect(first?.client).toBeTruthy();
});

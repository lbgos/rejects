import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotBridgeRequest,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { decideProposal, useBridgeState } from "./BotBridgePanel";

const environmentId = EnvironmentId.make("env");
const mocks = vi.hoisted(() => ({ connected: false, denied: false }));

vi.mock("../state/session", () => ({
  usePreparedConnection: () => (mocks.connected ? Option.some({}) : Option.none()),
}));
vi.mock("./http", () => ({
  botRequest: async (_environmentId: unknown, endpoint: { readonly path: string }) => {
    if (!mocks.connected) throw new Error("Not connected to the environment.");
    if (endpoint.path.endsWith("/decide")) {
      mocks.denied = true;
      return { ...request, status: "denied" };
    }
    return {
      environments: [],
      grants: [],
      requests: [{ ...request, status: mocks.denied ? "denied" : "pending" }],
      audit: [],
    };
  },
}));

const request: BotBridgeRequest = {
  id: "r1",
  botThreadId: ThreadId.make("agents"),
  proposal: {
    kind: "start",
    environmentId: EnvironmentId.make("main"),
    projectId: ProjectId.make("scratch"),
    title: "Bridge check",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-5-5",
    },
    prompt: "Reply with pong.",
  },
  status: "pending",
  createdAt: "2026-11-05T21:37:27.000Z",
  decidedAt: null,
  threadId: null,
  runId: null,
  error: null,
};

function setup() {
  mocks.connected = false;
  mocks.denied = false;
}

function Pending() {
  const state = useBridgeState(environmentId, "");
  const pending = state?.requests.filter((r) => r.status === "pending").length;
  return <p>{pending === undefined ? "no state" : `${pending} pending`}</p>;
}

it("loads the bridge state once the connection is ready", async () => {
  setup();
  await using screen = await render(<Pending />);
  mocks.connected = true;
  await screen.rerender(<Pending />);
  await expect.element(screen.getByText("1 pending")).toBeVisible();
});

it("refetches in every view after a decision made in another", async () => {
  setup();
  mocks.connected = true;
  await using screen = await render(<Pending />);
  await expect.element(screen.getByText("1 pending")).toBeVisible();
  await decideProposal(environmentId, request, false);
  await expect.element(screen.getByText("0 pending")).toBeVisible();
});

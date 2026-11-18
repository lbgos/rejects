import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { serverEnvironment } from "~/state/server";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import type { UpdateEverythingRun } from "./updateEverything.logic";
import { retryFailedUpdateRunServers, setUpdateEverythingRun } from "./updateEverythingRun";

describe("retryFailedUpdateRunServers", () => {
  it("settles a failed server that already restarted on the target and retries only the others", () => {
    const targetVersion = "9.9.9";
    const serverVersions = new Map([
      [EnvironmentId.make("already-updated"), targetVersion],
      [EnvironmentId.make("behind"), "9.9.8"],
    ]);
    using _config = vi
      .spyOn(serverEnvironment, "configValueAtom")
      .mockImplementation((environmentId) =>
        Atom.make({
          environment: { serverVersion: serverVersions.get(environmentId!) },
        } as unknown as ServerConfig),
      );
    const rejection = "Remote updates must select a newer server version.";
    const failedMachine = (environmentId: EnvironmentId) => ({
      environmentId,
      label: environmentId,
      updatesProviders: false,
      server: {
        environmentId,
        serverLabel: environmentId,
        selfUpdate: "boot-service" as const,
        targetVersion,
      },
      handedOffVersion: null,
      startedAt: 0,
      result: "failed" as const,
      failure: rejection,
      providerFailure: null,
    });
    setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [...serverVersions.keys()].map(failedMachine),
    }));
    const update = vi.fn(
      (_target: ServerUpdateTarget) => new Promise<ServerUpdateOutcome>(() => {}),
    );

    retryFailedUpdateRunServers(update);

    let run: UpdateEverythingRun | null = null;
    setUpdateEverythingRun((current) => {
      run = current;
      return null;
    });
    expect(update.mock.calls.map(([target]) => target.environmentId)).toEqual(["behind"]);
    expect(
      (run as UpdateEverythingRun | null)?.machines.map(({ environmentId, result, server }) => ({
        environmentId,
        result,
        retryable: server !== null,
      })),
    ).toEqual([
      { environmentId: "already-updated", result: "done", retryable: false },
      { environmentId: "behind", result: null, retryable: true },
    ]);
  });
});

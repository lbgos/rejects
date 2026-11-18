import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as LabShell from "../../../lab/LabShell.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { LabToolkit } from "./tools.ts";

const invalid = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));

export const layer = Access.toLayer(LabToolkit, {
  lab_shell: Access.actsAsCaller(({ host, command, docker, mode, why }) =>
    Effect.gen(function* () {
      const lab = yield* LabShell.LabShell;
      const scope = yield* Invocation.McpInvocationContext;
      const input = docker ?? command;
      if (input === undefined || (docker !== undefined && command !== undefined))
        return yield* invalid("Give command or docker, not both.");
      if (mode === "read") return yield* lab.read(scope, host, input);
      if (typeof input !== "string") return yield* invalid("docker is read only.");
      return yield* lab.propose(scope, host, input, why);
    }),
  ),
});

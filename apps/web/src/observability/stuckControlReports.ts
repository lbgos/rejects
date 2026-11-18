import {
  AuthOrchestrationOperateScope,
  STUCK_CONTROL_ENDPOINT,
  type StuckControlReport,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { botRequest } from "../bots/http";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentSession, sessionHasScope } from "../state/session";

/** The primary environment once it is connected and this client may operate it. */
const reportTargetAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  if (Option.isNone(get(environmentSession.preparedConnectionValueAtom(environmentId)))) {
    return null;
  }
  const session = get(environmentSession.sessionStateAtom(environmentId));
  return sessionHasScope(session, AuthOrchestrationOperateScope) ? environmentId : null;
}).pipe(Atom.withLabel("stuck-control-report-target"));

const pending: StuckControlReport[] = [];
let unsubscribe: (() => void) | null = null;

function flush() {
  const environmentId = appAtomRegistry.get(reportTargetAtom);
  if (environmentId === null) return;
  unsubscribe?.();
  unsubscribe = null;
  for (const report of pending.splice(0)) {
    void botRequest(environmentId, STUCK_CONTROL_ENDPOINT, report).catch(() => undefined);
  }
}

/** Sends now, or once the primary environment is ready; a report made at boot usually waits. */
export function sendStuckControlReport(report: StuckControlReport): void {
  pending.push(report);
  flush();
  if (pending.length > 0) unsubscribe ??= appAtomRegistry.subscribe(reportTargetAtom, flush);
}

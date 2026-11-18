import { LAB_ENDPOINTS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { route } from "../bots/http.ts";
import * as LabShell from "./LabShell.ts";

/** The change cards: read by the chat, decided by the user's own session. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const lab = yield* LabShell.LabShell;
    return Layer.mergeAll(
      route(LAB_ENDPOINTS.state, () => lab.state),
      route(LAB_ENDPOINTS.decide, ({ id, approve }) => lab.decide(id, approve)),
    );
  }),
);

/**
 * Clients report controls that were tapped three times with no effect. Each report is one line in
 * the feedback inbox; it becomes a ticket when a restart followed it or when a second session
 * reports the same fingerprint the same day. `T3CODE_STUCK_CONTROL_PUSH=1` also pushes tickets.
 */
import type { OrchestratorMcpFailure, StuckControlReport } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Push from "../push/WebPush.ts";
import { feedbackInbox } from "./BotFeedback.ts";
import * as Store from "./BotStore.ts";

const encodeEntry = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      time: Schema.String,
      from: Schema.String,
      text: Schema.String,
      ticket: Schema.Boolean,
      report: Schema.Struct({
        control: Schema.String,
        route: Schema.String,
        version: Schema.String,
        sessions: Schema.Number,
        confirmed: Schema.Boolean,
        standalone: Schema.Boolean,
        client: Schema.String,
        ring: Schema.Array(Schema.String),
      }),
    }),
  ),
);

interface Seen {
  readonly sessions: ReadonlySet<string>;
  readonly ticket: boolean;
}

export class StuckControls extends Context.Service<
  StuckControls,
  {
    /** `ticket` is true when this report wrote the day's ticket for its fingerprint. */
    readonly report: (
      report: StuckControlReport,
    ) => Effect.Effect<{ readonly ticket: boolean }, OrchestratorMcpFailure>;
  }
>()("t3/bots/StuckControls") {}

const make = Effect.gen(function* () {
  const append = yield* feedbackInbox;
  const push = yield* Push.WebPush;
  const bots = yield* Store.BotStore;
  const pushTickets = (yield* HostProcess.Environment).T3CODE_STUCK_CONTROL_PUSH === "1";
  // Fingerprint -> what today brought. Only today's keys are kept.
  const seen = yield* Ref.make(new Map<string, Seen>());

  const notifyOwner = Effect.fn("StuckControls.notifyOwner")(function* (text: string) {
    const main = yield* bots.mainBot;
    if (!main) return;
    yield* push.send({
      title: "Stuck control",
      body: text,
      threadId: main,
      unreadCount: (yield* bots.list).filter((bot) => bot.unread).length,
    });
  });

  return StuckControls.of({
    report: Effect.fn("StuckControls.report")(function* (report) {
      const time = DateTime.formatIso(yield* DateTime.now);
      const day = time.slice(0, 10);
      const key = `${day}|${report.control}|${report.route}|${report.version}`;
      const decision = yield* Ref.modify(seen, (map) => {
        const prior = map.get(key);
        if (prior?.ticket || (prior?.sessions.has(report.session) && !report.confirmed)) {
          return [undefined, map] as const;
        }
        const sessions = new Set(prior?.sessions).add(report.session);
        const ticket = report.confirmed || sessions.size >= 2;
        const next = new Map([...map].filter(([k]) => k.startsWith(day)));
        next.set(key, { sessions, ticket });
        return [{ ticket, sessions: sessions.size }, next] as const;
      });
      if (!decision) return { ticket: false };

      const why = report.confirmed ? "restart" : `${decision.sessions} sessions`;
      const text = `Stuck control ${report.control} on ${report.route} (${report.version}): ${
        decision.ticket ? `ticket, ${why}` : "seen once"
      }`;
      yield* append(
        encodeEntry({
          time,
          from: "app",
          text,
          ticket: decision.ticket,
          report: {
            control: report.control,
            route: report.route,
            version: report.version,
            sessions: decision.sessions,
            confirmed: report.confirmed,
            standalone: report.standalone,
            client: report.client,
            ring: report.ring,
          },
        }),
      );
      if (decision.ticket && pushTickets) {
        yield* notifyOwner(text).pipe(Effect.ignore({ log: true }));
      }
      return { ticket: decision.ticket };
    }),
  });
});

export const layer = Layer.effect(StuckControls, make);

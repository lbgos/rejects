/**
 * Secrets are redacted before they get here. Nothing is captured while a bot is idle.
 * Recordings go after `RETENTION_DAYS`, and at once when the account or secret a run used is revoked.
 */
import { type BotRecording, BotRecordingStep, type BotSecret, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** A runaway run stops adding steps here; its tools keep working. */
const MAX_STEPS = 300;
const LISTED = 50;
const ID = /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,200}$/;

const Meta = Schema.Struct({
  botThreadId: ThreadId,
  threadId: ThreadId,
  runId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  startedAtMs: Schema.Number,
  sites: Schema.Array(Schema.String),
  secrets: Schema.Array(Schema.String),
  steps: Schema.Array(BotRecordingStep),
});
type Meta = typeof Meta.Type;
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
const encodeMeta = Schema.encodeSync(Schema.fromJsonString(Meta));

export interface RecordedStep {
  readonly botThreadId: ThreadId;
  readonly threadId: ThreadId;
  readonly runId: string | null;
  readonly action: string;
  /** Already redacted. */
  readonly detail: string;
  readonly status: BotRecordingStep["status"];
  readonly image?: Uint8Array | undefined;
  readonly site?: string | undefined;
  readonly secret?: string | undefined;
}

export class BotRecordings extends Context.Service<
  BotRecordings,
  {
    /** Adds one step to its run's recording. Never fails: a lost step must not fail the tool. */
    readonly record: (step: RecordedStep) => Effect.Effect<void>;
    readonly list: (botThreadId: ThreadId) => Effect.Effect<ReadonlyArray<BotRecording>>;
    readonly image: (
      botThreadId: ThreadId,
      id: string,
      step: number,
    ) => Effect.Effect<string | null>;
    readonly forget: (
      used:
        | { readonly site: string }
        | { readonly secret: Pick<BotSecret, "botThreadId" | "name"> },
    ) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<number>;
  }
>()("t3/bots/BotRecordings") {}

const slug = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 200) || "-";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.join(config.stateDir, "bot-recordings");
  const lock = yield* Semaphore.make(1);

  const metaFile = (id: string) => path.join(root, id, "meta.json");
  const readMeta = (id: string) =>
    fs.readFileString(metaFile(id)).pipe(
      Effect.map(decodeMeta),
      Effect.orElseSucceed(() => Option.none<Meta>()),
    );
  const ids = fs.readDirectory(root).pipe(
    Effect.map((names) => names.filter((name) => ID.test(name))),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const remove = (id: string) => fs.remove(path.join(root, id), { recursive: true, force: true });

  const record: BotRecordings["Service"]["record"] = (step) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const id = `${slug(step.threadId)}.${slug(step.runId ?? "run")}`;
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const current = Option.getOrUndefined(yield* readMeta(id));
          if (current && current.steps.length >= MAX_STEPS) return;
          const index = current?.steps.length ?? 0;
          yield* fs.makeDirectory(path.join(root, id), { recursive: true, mode: 0o700 });
          if (step.image) yield* fs.writeFile(path.join(root, id, `${index}.jpg`), step.image);
          const meta: Meta = {
            botThreadId: step.botThreadId,
            threadId: step.threadId,
            runId: step.runId,
            startedAt: current?.startedAt ?? DateTime.formatIso(now),
            startedAtMs: current?.startedAtMs ?? nowMs,
            sites: [...new Set([...(current?.sites ?? []), ...(step.site ? [step.site] : [])])],
            secrets: [
              ...new Set([...(current?.secrets ?? []), ...(step.secret ? [step.secret] : [])]),
            ],
            steps: [
              ...(current?.steps ?? []),
              {
                at: DateTime.formatIso(now),
                action: step.action,
                detail: step.detail.slice(0, 500),
                status: step.status,
                image: step.image !== undefined,
              },
            ],
          };
          yield* fs.writeFileString(metaFile(id), encodeMeta(meta));
        }),
      )
      .pipe(Effect.ignore({ log: true }), Effect.withSpan("BotRecordings.record"));

  const metas = Effect.gen(function* () {
    const all: Array<{ readonly id: string; readonly meta: Meta }> = [];
    for (const id of yield* ids) {
      const meta = yield* readMeta(id);
      if (Option.isSome(meta)) all.push({ id, meta: meta.value });
    }
    return all;
  });

  const forget: BotRecordings["Service"]["forget"] = (used) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          for (const { id, meta } of yield* metas)
            if (
              "site" in used
                ? meta.sites.includes(used.site)
                : meta.botThreadId === used.secret.botThreadId &&
                  meta.secrets.includes(used.secret.name)
            )
              yield* remove(id);
        }),
      )
      .pipe(Effect.ignore({ log: true }), Effect.withSpan("BotRecordings.forget"));

  const sweep = lock
    .withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let removed = 0;
        for (const id of yield* ids) {
          const meta = yield* readMeta(id);
          // A recording without readable metadata is kept until its files are old, then goes too.
          const started = Option.isSome(meta)
            ? meta.value.startedAtMs
            : Option.getOrUndefined(
                (yield* fs.stat(path.join(root, id)).pipe(Effect.option)).pipe(
                  Option.flatMap((info) => info.mtime),
                ),
              )?.getTime();
          if (started === undefined || now - started <= RETENTION_MS) continue;
          yield* remove(id);
          removed += 1;
        }
        return removed;
      }),
    )
    .pipe(
      Effect.orElseSucceed(() => 0),
      Effect.withSpan("BotRecordings.sweep"),
    );

  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("6 hours"),
    Effect.repeat(Schedule.spaced("6 hours")),
    Effect.forkScoped,
  );

  return BotRecordings.of({
    record,
    list: Effect.fn("BotRecordings.list")(function* (botThreadId) {
      return (yield* metas)
        .filter(({ meta }) => meta.botThreadId === botThreadId)
        .toSorted((a, b) => b.meta.startedAtMs - a.meta.startedAtMs)
        .slice(0, LISTED)
        .map(({ id, meta }) => ({
          id,
          threadId: meta.threadId,
          runId: meta.runId,
          startedAt: meta.startedAt,
          steps: meta.steps,
        }));
    }),
    image: Effect.fn("BotRecordings.image")(function* (botThreadId, id, step) {
      if (!ID.test(id) || !Number.isInteger(step) || step < 0) return null;
      const meta = yield* readMeta(id);
      if (Option.isNone(meta) || meta.value.botThreadId !== botThreadId) return null;
      const bytes = yield* fs
        .readFile(path.join(root, id, `${step}.jpg`))
        .pipe(Effect.orElseSucceed(() => undefined));
      return bytes ? `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` : null;
    }),
    forget,
    sweep,
  });
});

export const layer = Layer.effect(BotRecordings, make);

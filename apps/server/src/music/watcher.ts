import type { AlbumHint } from "./importPlan.ts";

export interface Source {
  readonly username: string;
  readonly directory: string;
  readonly files: ReadonlyArray<{ readonly filename: string; readonly size: number }>;
}
export interface Job {
  readonly id: string;
  readonly botThreadId: string;
  readonly title: string;
  readonly hint: AlbumHint;
  readonly status: "downloading" | "importing" | "done" | "failed";
  readonly attempt: number;
  readonly current: Source;
  readonly fallbacks: ReadonlyArray<Source>;
  readonly startedAt: number;
  readonly progressAt: number;
  readonly bytes: number;
  readonly result?: string | undefined;
  readonly endedAt?: number | undefined;
}
type TransferState = "queued" | "active" | "succeeded" | "failed";
export interface Observed {
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly state: TransferState;
    readonly bytes: number;
  }>;
}
type JobAction =
  | { readonly type: "none" }
  | { readonly type: "import" }
  | { readonly type: "retry"; readonly failed: Source; readonly reason: string }
  | { readonly type: "fail"; readonly failed: Source; readonly reason: string };

const MAX_ATTEMPTS = 2;
/** No new bytes for this long, queued remotely included, counts as a failure. */
export const STALL_MS = 15 * 60_000;

export const transferState = (state: string): TransferState =>
  state.includes("Succeeded")
    ? "succeeded"
    : state.includes("Completed")
      ? "failed"
      : state.includes("InProgress") || state.includes("Initializing")
        ? "active"
        : "queued";

export const jobStep = (
  job: Job,
  observed: Observed,
  now: number,
): { readonly job: Job; readonly action: JobAction } => {
  if (job.status !== "downloading") return { job, action: { type: "none" } };
  const byName = new Map(observed.files.map((file) => [file.filename, file]));
  const files = job.current.files.map((file) => byName.get(file.filename));
  if (files.every((file) => file?.state === "succeeded"))
    return { job: { ...job, status: "importing" }, action: { type: "import" } };
  const failed = files.filter((file) => file?.state === "failed").length;
  const bytes = files.reduce((sum, file) => sum + (file?.bytes ?? 0), 0);
  if (failed === 0 && bytes > job.bytes)
    return { job: { ...job, bytes, progressAt: now }, action: { type: "none" } };
  if (failed === 0 && now - job.progressAt <= STALL_MS) return { job, action: { type: "none" } };
  const reason =
    failed > 0
      ? `${failed} of ${job.current.files.length} files failed from ${job.current.username}`
      : `no progress from ${job.current.username} for ${STALL_MS / 60_000} minutes`;
  const [next, ...rest] = job.fallbacks;
  if (next !== undefined && job.attempt < MAX_ATTEMPTS)
    return {
      job: {
        ...job,
        attempt: job.attempt + 1,
        current: next,
        fallbacks: rest,
        bytes: 0,
        progressAt: now,
      },
      action: { type: "retry", failed: job.current, reason },
    };
  return {
    job: { ...job, status: "failed", result: reason, endedAt: now },
    action: { type: "fail", failed: job.current, reason },
  };
};

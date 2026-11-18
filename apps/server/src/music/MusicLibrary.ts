/** Credentials stay with this server: the slskd key in the secret store, the SSH key named in `<stateDir>/music.json`. */
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { runSshCommand } from "@t3tools/ssh/command";
import { CommandId, MessageId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { contact } from "../contact.ts";
import { wakeMessage } from "../bots/instructions.ts";
import { chatLanguageOf } from "../bots/language.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { importPlan, type AlbumHint, type InspectedFile } from "./importPlan.ts";
import { FORBIDDEN, extensionOf, isAudio, rankFolders, type RankedFolder } from "./ranking.ts";
import { jobStep, transferState, type Job, type Observed, type Source } from "./watcher.ts";

const API_KEY_SECRET = "music-slskd-api-key";
const POLL = "15 seconds";
const SEARCH_MS = 15_000;
const CANDIDATES_SHOWN = 8;
const FALLBACKS = 3;
const SEARCHES_KEPT = 20;
const ENDED_KEPT = 30;
/** Navidrome's file watcher usually lists an import within seconds. */
const NAVIDROME_CHECKS = 18;

const Settings = Schema.Struct({
  slskdUrl: Schema.String,
  importHost: Schema.String,
  importUser: Schema.String,
  identityFile: Schema.String,
});

const HintSchema = Schema.Struct({
  artist: Schema.String,
  album: Schema.String,
  year: Schema.optional(Schema.Number),
});
const SourceSchema = Schema.Struct({
  username: Schema.String,
  directory: Schema.String,
  files: Schema.Array(Schema.Struct({ filename: Schema.String, size: Schema.Number })),
});
const JobSchema = Schema.Struct({
  id: Schema.String,
  botThreadId: Schema.String,
  title: Schema.String,
  hint: HintSchema,
  status: Schema.Literals(["downloading", "importing", "done", "failed"]),
  attempt: Schema.Number,
  current: SourceSchema,
  fallbacks: Schema.Array(SourceSchema),
  startedAt: Schema.Number,
  progressAt: Schema.Number,
  bytes: Schema.Number,
  result: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.Number),
});
const Candidate = Schema.Struct({
  id: Schema.String,
  source: SourceSchema,
  tracks: Schema.Number,
  format: Schema.String,
  lossless: Schema.Boolean,
  complete: Schema.Boolean,
});
const State = Schema.Struct({
  searches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      botThreadId: Schema.String,
      at: Schema.Number,
      hint: HintSchema,
      candidates: Schema.Array(Candidate),
    }),
  ),
  jobs: Schema.Array(JobSchema),
});
type State = typeof State.Type;
type Candidate = typeof Candidate.Type;

const SlskdFile = Schema.Struct({
  filename: Schema.String,
  size: Schema.Number,
  bitDepth: Schema.optional(Schema.Number),
  sampleRate: Schema.optional(Schema.Number),
  bitRate: Schema.optional(Schema.Number),
  isLocked: Schema.optional(Schema.Boolean),
});
const SearchState = Schema.Struct({ isComplete: Schema.Boolean });
const SearchResponses = Schema.Array(
  Schema.Struct({
    username: Schema.String,
    files: Schema.Array(SlskdFile),
    hasFreeUploadSlot: Schema.Boolean,
    queueLength: Schema.Number,
    uploadSpeed: Schema.Number,
  }),
);
const Listing = Schema.Array(
  Schema.Struct({ name: Schema.String, files: Schema.Array(SlskdFile) }),
);
const Transfers = Schema.Array(
  Schema.Struct({
    username: Schema.String,
    directories: Schema.Array(
      Schema.Struct({
        files: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            filename: Schema.String,
            state: Schema.String,
            bytesTransferred: Schema.Number,
          }),
        ),
      }),
    ),
  }),
);
type Transfers = typeof Transfers.Type;

const Releases = Schema.Struct({
  releases: Schema.Array(
    Schema.Struct({
      score: Schema.Number,
      title: Schema.String,
      date: Schema.optional(Schema.String),
      "artist-credit": Schema.optional(
        Schema.Array(
          Schema.Struct({ name: Schema.String, joinphrase: Schema.optional(Schema.String) }),
        ),
      ),
      media: Schema.optional(
        Schema.Array(
          Schema.Struct({
            format: Schema.optional(Schema.NullOr(Schema.String)),
            "track-count": Schema.Number,
          }),
        ),
      ),
    }),
  ),
});

const Inspected = Schema.Struct({
  dir: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      flac: Schema.NullOr(
        Schema.Struct({
          rate: Schema.Number,
          bits: Schema.Number,
          channels: Schema.Number,
          seconds: Schema.Number,
        }),
      ),
      tags: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
const Moved = Schema.Struct({ moved: Schema.Number, target: Schema.String });
const Listed = Schema.Struct({ tracks: Schema.Number });
const Refusal = Schema.Struct({ error: Schema.String });
const isRefusal = Schema.is(Refusal);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });
class ImportRefused extends Schema.TaggedError<ImportRefused>()("ImportRefused", {
  message: Schema.String,
}) {}

const parseQuery = (query: string): AlbumHint => {
  const cleaned = query.replace(/[,;]?\s*\b(flac|lossless|mp3)\b\s*$/iu, "").trim();
  const match = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
  return match
    ? { artist: match[1]!.trim(), album: match[2]!.trim() }
    : { artist: "", album: cleaned };
};
/** Soulseek terms: letters and digits only (a leading "-" would exclude a term), plus "flac". */
const soulseekText = (hint: AlbumHint) =>
  `${hint.artist} ${hint.album} flac`
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
const leaf = (remote: string) => remote.slice(remote.lastIndexOf("\\") + 1);
const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export class MusicLibrary extends Context.Service<
  MusicLibrary,
  {
    readonly search: (
      botThreadId: ThreadId,
      query: string,
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly download: (
      botThreadId: ThreadId,
      candidateId: string,
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly status: (botThreadId: ThreadId) => Effect.Effect<string, OrchestratorMcpFailure>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/music/MusicLibrary") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const mbAgent = `rejects-music/1.0 ( ${(yield* contact).replace(/^mailto:/, "")} )`;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const threads = yield* Threads.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  // MusicBrainz allows one request per second per IP and answers 503 above it.
  const brainzLock = yield* Semaphore.make(1);
  const stateFile = path.join(config.stateDir, "music-state.json");
  const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
  let state: State = yield* fs.readFileString(stateFile).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))),
    Effect.orElseSucceed((): State => ({ searches: [], jobs: [] })),
  );
  const mutate = (change: (current: State) => State) =>
    lock.withPermit(
      Effect.suspend(() => {
        const next = change(state);
        return encodeState(next).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: stateFile, contents }),
          ),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.tap(() => Effect.sync(() => (state = next))),
          Effect.mapError(() => failure("Could not save the music state.")),
        );
      }),
    );
  const putJob = (job: Job) =>
    mutate((current) => ({
      ...current,
      jobs: current.jobs.map((j) => (j.id === job.id ? job : j)),
    }));

  const settings = fs.readFileString(path.join(config.stateDir, "music.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Settings))),
    Effect.mapError(() => failure("Music is not set up on this server (music.json).")),
  );
  const apiKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(undefined), onSome: Effect.succeed })),
    Effect.mapError(() => failure("Music is not set up on this server (slskd API key).")),
  );

  const slskdRequest = Effect.fn("MusicLibrary.slskdRequest")(function* (
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: unknown,
  ) {
    const { slskdUrl } = yield* settings;
    const url = new URL(
      `api/v0/${route}`,
      slskdUrl.endsWith("/") ? slskdUrl : `${slskdUrl}/`,
    ).toString();
    const base =
      method === "GET"
        ? HttpClientRequest.get(url)
        : method === "DELETE"
          ? HttpClientRequest.delete(url)
          : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body ?? {}));
    const response = yield* http
      .execute(base.pipe(HttpClientRequest.setHeader("X-API-Key", yield* apiKey)))
      .pipe(Effect.timeout("60 seconds"));
    if (response.status >= 300)
      return yield* failure(
        `Soulseek client answered ${response.status}: ${(yield* response.text).slice(0, 200)}`,
      );
    return response;
  }, Effect.mapError(asFailure));
  const slskd = <A>(
    schema: Schema.Codec<A>,
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ) =>
    slskdRequest(method, route, body).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) =>
        isMcpFailure(error) ? error : failure("The Soulseek client is unavailable."),
      ),
    );

  const importer = Effect.fn("MusicLibrary.importer")(function* <A>(
    schema: Schema.Codec<A>,
    command: "inspect" | "import" | "discard" | "library",
    request: unknown,
  ) {
    const target = yield* settings;
    const result = yield* runSshCommand(
      {
        alias: target.importHost,
        hostname: target.importHost,
        username: target.importUser,
        port: null,
      },
      {
        batchMode: "yes",
        preHostArgs: [
          "-i",
          target.identityFile,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=yes",
        ],
        remoteCommandArgs: [command],
        // @effect-diagnostics-next-line globalJsonInEffect:off - music-import validates every field itself.
        stdin: JSON.stringify(request),
        timeoutMs: 120_000,
      },
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => failure("The music library host did not answer.")),
    );
    const json = yield* decodeJson(result.stdout.trim()).pipe(
      Effect.mapError(() => failure("The music library host sent an invalid reply.")),
    );
    if (isRefusal(json)) return yield* new ImportRefused({ message: json.error });
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(() => failure("The music library host sent an invalid reply.")),
    );
  });

  const musicBrainz = Effect.fn("MusicLibrary.musicBrainz")(function* (hint: AlbumHint) {
    const quote = (text: string) => `"${text.replace(/["\\]/gu, "\\$&")}"`;
    const query = [
      `release:${quote(hint.album)}`,
      hint.artist ? `artist:${quote(hint.artist)}` : undefined,
      "status:official",
    ]
      .filter(Boolean)
      .join(" AND ");
    const request = HttpClientRequest.get(
      `https://musicbrainz.org/ws/2/release?fmt=json&limit=25&query=${encodeURIComponent(query)}`,
    ).pipe(HttpClientRequest.setHeader("User-Agent", mbAgent));
    const { releases } = yield* http
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Releases)),
        Effect.timeout("20 seconds"),
        Effect.ensuring(Effect.sleep("1100 millis")),
        brainzLock.withPermit,
        Effect.retry({ times: 1 }),
      );
    const matched = releases.filter((release) => release.score >= 90);
    const top = matched[0];
    if (!top) return undefined;
    const editions = new Map<number, number>();
    for (const release of matched) {
      const tracks = (release.media ?? [])
        .filter((medium) => !/video|blu-ray|vhs/iu.test(medium.format ?? ""))
        .reduce((sum, medium) => sum + medium["track-count"], 0);
      if (tracks > 0) editions.set(tracks, (editions.get(tracks) ?? 0) + 1);
    }
    const years = matched.flatMap((release) => {
      const year = Number(release.date?.slice(0, 4));
      return Number.isFinite(year) && year > 0 ? [year] : [];
    });
    const credit = top["artist-credit"]?.map((c) => `${c.name}${c.joinphrase ?? ""}`).join("");
    return {
      hint: {
        artist: credit || hint.artist,
        album: top.title,
        ...(years.length > 0 ? { year: Math.min(...years) } : {}),
      } satisfies AlbumHint,
      editions: [...editions]
        .sort((a, b) => b[1] - a[1])
        .map(([tracks, releases]) => ({ tracks, releases })),
    };
  });

  const toCandidate = (searchId: string, folder: RankedFolder, index: number): Candidate => ({
    id: `${searchId}-${index + 1}`,
    source: { username: folder.username, directory: folder.directory, files: folder.files },
    tracks: folder.tracks,
    format: folder.format,
    lossless: folder.lossless,
    complete: folder.complete,
  });

  const search = Effect.fn("MusicLibrary.search")(function* (botThreadId: ThreadId, query: string) {
    const parsed = parseQuery(query);
    const resolved = yield* musicBrainz(parsed).pipe(
      Effect.tapError((error) => Effect.logWarning("MusicBrainz lookup failed", { query, error })),
      Effect.orElseSucceed(() => undefined),
    );
    const hint = resolved?.hint ?? parsed;
    const searchId = (yield* crypto.uuidV4().pipe(Effect.orDie)).slice(0, 6);
    const uuid = yield* crypto.uuidV4().pipe(Effect.orDie);
    yield* slskd(Schema.Unknown, "POST", "searches", {
      id: uuid,
      searchText: soulseekText(parsed.artist ? parsed : hint),
      searchTimeout: SEARCH_MS,
      responseLimit: 200,
      filterResponses: true,
      minimumResponseFileCount: 1,
    });
    yield* slskd(SearchState, "GET", `searches/${uuid}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s.isComplete,
        times: 25,
      }),
    );
    const responses = yield* slskd(SearchResponses, "GET", `searches/${uuid}/responses`);
    const ranked = rankFolders(
      responses,
      (resolved?.editions ?? []).map((edition) => edition.tracks),
    );
    const candidates = ranked
      .slice(0, CANDIDATES_SHOWN + FALLBACKS * 2)
      .map((folder, i) => toCandidate(searchId, folder, i));
    const now = yield* Clock.currentTimeMillis;
    yield* mutate((current) => ({
      ...current,
      searches: [
        ...current.searches,
        { id: searchId, botThreadId, at: now, hint, candidates },
      ].slice(-SEARCHES_KEPT),
    }));
    // @effect-diagnostics-next-line globalJsonInEffect:off - a compact tool reply for the model.
    return JSON.stringify({
      album: resolved
        ? { ...resolved.hint, editions: resolved.editions.slice(0, 4) }
        : { ...parsed, musicbrainz: "not found" },
      folders: ranked.length,
      candidates: ranked.slice(0, CANDIDATES_SHOWN).map((folder, i) => ({
        id: candidates[i]!.id,
        folder: folder.directory.split("\\").slice(-2).join("\\"),
        tracks: folder.tracks,
        format: folder.format,
        complete: folder.complete,
        sizeMB: megabytes(folder.bytes),
        freeSlot: folder.freeSlot,
        queue: folder.queue,
        speedMBs: Math.round(folder.speed / 100_000) / 10,
      })),
    });
  }, Effect.mapError(asFailure));

  const folderFiles = Effect.fn("MusicLibrary.folderFiles")(function* (source: Source) {
    const listing = yield* slskd(
      Listing,
      "POST",
      `users/${encodeURIComponent(source.username)}/directory`,
      {
        directory: source.directory,
      },
    ).pipe(Effect.option);
    if (Option.isNone(listing)) return source.files;
    const files = listing.value.flatMap((dir) => dir.files);
    const forbidden = files.find((file) => FORBIDDEN.has(extensionOf(file.filename)));
    if (forbidden)
      return yield* failure(
        `That folder holds ${forbidden.filename}; it is skipped. Pick another.`,
      );
    const audio = files
      .filter((file) => isAudio(file.filename))
      .map((file) => ({
        filename: `${source.directory}\\${leaf(file.filename)}`,
        size: file.size,
      }));
    return audio.length > 0 ? audio : source.files;
  });

  const enqueue = Effect.fn("MusicLibrary.enqueue")(function* (source: Source) {
    const files = yield* folderFiles(source);
    yield* slskdRequest(
      "POST",
      `transfers/downloads/${encodeURIComponent(source.username)}`,
      files,
    );
    return { ...source, files } satisfies Source;
  });

  const download = Effect.fn("MusicLibrary.download")(function* (
    botThreadId: ThreadId,
    candidateId: string,
  ) {
    const found = state.searches.find(
      (s) => s.botThreadId === botThreadId && s.candidates.some((c) => c.id === candidateId),
    );
    const chosen = found?.candidates.find((c) => c.id === candidateId);
    if (!found || !chosen) return yield* failure("Unknown candidate id. Run music_search again.");
    const current = yield* enqueue(chosen.source);
    const fallbacks = found.candidates
      .filter(
        (c) =>
          c.id !== chosen.id &&
          c.source.username !== chosen.source.username &&
          c.tracks === chosen.tracks &&
          c.lossless === chosen.lossless,
      )
      .slice(0, FALLBACKS)
      .map((c) => c.source);
    const now = yield* Clock.currentTimeMillis;
    const job: Job = {
      id: (yield* crypto.uuidV4().pipe(Effect.orDie)).slice(0, 8),
      botThreadId,
      title: `${found.hint.artist} – ${found.hint.album}`,
      hint: found.hint,
      status: "downloading",
      attempt: 1,
      current,
      fallbacks,
      startedAt: now,
      progressAt: now,
      bytes: 0,
    };
    yield* mutate((s) => ({ ...s, jobs: [...s.jobs, job] }));
    // @effect-diagnostics-next-line globalJsonInEffect:off - a compact tool reply for the model.
    return JSON.stringify({
      job: job.id,
      title: job.title,
      queued: current.files.length,
      format: chosen.format,
      next: "You are woken when it is in the library or has failed. End your turn after telling the user.",
    });
  }, Effect.mapError(asFailure));

  const observe = (transfers: Transfers, source: Source): Observed => ({
    files: transfers
      .filter((user) => user.username === source.username)
      .flatMap((user) => user.directories.flatMap((dir) => dir.files))
      .map((file) => ({
        filename: file.filename,
        state: transferState(file.state),
        bytes: file.bytesTransferred,
      })),
  });

  const clear = Effect.fn("MusicLibrary.clear")(function* (
    source: Source,
    transfers: Transfers,
    discard: boolean,
  ) {
    const names = new Set(source.files.map((file) => file.filename));
    const ids = transfers
      .filter((user) => user.username === source.username)
      .flatMap((user) => user.directories.flatMap((dir) => dir.files))
      .filter((file) => names.has(file.filename))
      .map((file) => file.id);
    yield* Effect.forEach(
      ids,
      (id) =>
        slskdRequest(
          "DELETE",
          `transfers/downloads/${encodeURIComponent(source.username)}/${id}?remove=true`,
        ).pipe(Effect.ignore),
      { discard: true },
    );
    if (discard)
      yield* importer(Schema.Unknown, "discard", { dir: leaf(source.directory) }).pipe(
        Effect.ignore,
      );
  });

  const wake = (job: Job, text: string) =>
    chatLanguageOf(threads, ThreadId.make(job.botThreadId)).pipe(
      Effect.flatMap((language) =>
        threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`music:${job.id}:${job.status}`),
          messageId: MessageId.make(`music:${job.id}:${job.status}`),
          threadId: ThreadId.make(job.botThreadId),
          text: wakeMessage("music", text, language),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      ),
      Effect.asVoid,
      Effect.ignore({ log: true }),
    );

  const end = Effect.fn("MusicLibrary.end")(function* (
    job: Job,
    status: "done" | "failed",
    result: string,
  ) {
    const ended: Job = { ...job, status, result, endedAt: yield* Clock.currentTimeMillis };
    yield* putJob(ended);
    yield* mutate((s) => {
      const finished = s.jobs.filter((j) => j.status === "done" || j.status === "failed");
      const drop = new Set(
        finished.slice(0, Math.max(0, finished.length - ENDED_KEPT)).map((j) => j.id),
      );
      return { ...s, jobs: s.jobs.filter((j) => !drop.has(j.id)) };
    });
    yield* wake(
      ended,
      status === "done"
        ? `${result}\nPost this line as your reply and send the same line with notify_user.`
        : `Download failed: ${job.title}. ${result}. Folders tried: ${job.attempt}.\nTell the user in one line with notify_user and offer to search again.`,
    );
  });

  const importJob = Effect.fn("MusicLibrary.importJob")(function* (job: Job, transfers: Transfers) {
    const inspected = yield* importer(Inspected, "inspect", {
      dir: leaf(job.current.directory),
      files: job.current.files.map((file) => ({ name: leaf(file.filename), size: file.size })),
    });
    if (inspected.files.length < job.current.files.length)
      return yield* new ImportRefused({
        message: `only ${inspected.files.length} of ${job.current.files.length} files arrived`,
      });
    const plan = importPlan(inspected.files satisfies ReadonlyArray<InspectedFile>, job.hint);
    yield* importer(Moved, "import", {
      dir: inspected.dir,
      target: plan.target,
      files: plan.files,
    });
    yield* clear(job.current, transfers, false);
    const listed = yield* importer(Listed, "library", { target: plan.target }).pipe(
      Effect.map((reply) => reply.tracks),
      Effect.orElseSucceed(() => 0),
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (tracks) => tracks >= plan.files.length,
        times: NAVIDROME_CHECKS - 1,
      }),
    );
    const { artist, album, format, tracks } = plan.summary;
    const inLibrary = listed >= tracks;
    yield* end(
      job,
      "done",
      {
        en: `Downloaded: ${artist} – ${album} (${format}, ${tracks} tracks)${
          inLibrary ? ", in Navidrome" : `, not in Navidrome yet (${plan.target})`
        }`,
        ru: `Скачано: ${artist} – ${album} (${format}, треков: ${tracks})${
          inLibrary ? ", в Navidrome" : `, в Navidrome пока нет (${plan.target})`
        }`,
        uk: `Завантажено: ${artist} – ${album} (${format}, треків: ${tracks})${
          inLibrary ? ", у Navidrome" : `, у Navidrome поки немає (${plan.target})`
        }`,
      }[yield* chatLanguageOf(threads, ThreadId.make(job.botThreadId))],
    );
  });

  const advance = Effect.fn("MusicLibrary.advance")(function* (job: Job, transfers: Transfers) {
    const step =
      job.status === "importing"
        ? { job, action: { type: "import" as const } }
        : jobStep(job, observe(transfers, job.current), yield* Clock.currentTimeMillis);
    if (step.job !== job) yield* putJob(step.job);
    const action = step.action;
    if (action.type === "import")
      // A refusal there (missing files, already in the library) ends the job; a dropped
      // connection leaves it importing for the next tick.
      return yield* importJob(step.job, transfers).pipe(
        Effect.catchTags({
          ImportRefused: (refused) => end(step.job, "failed", refused.message),
        }),
      );
    if (action.type === "retry")
      return yield* clear(action.failed, transfers, true).pipe(
        Effect.andThen(enqueue(step.job.current)),
        Effect.flatMap((current) => putJob({ ...step.job, current })),
        Effect.catch((error) => end(step.job, "failed", error.message)),
      );
    if (action.type === "fail") {
      yield* clear(action.failed, transfers, true);
      yield* end(step.job, "failed", action.reason);
    }
  });

  const tick = Effect.fn("MusicLibrary.tick")(function* () {
    const active = state.jobs.filter(
      (job) => job.status === "downloading" || job.status === "importing",
    );
    if (active.length === 0) return;
    const transfers = yield* slskd(Transfers, "GET", "transfers/downloads");
    yield* Effect.forEach(
      active,
      (job) =>
        advance(job, transfers).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("music job step failed", { job: job.id, cause }),
          ),
        ),
      { discard: true },
    );
  });

  const status = Effect.fn("MusicLibrary.status")(function* (botThreadId: ThreadId) {
    const mine = state.jobs.filter((job) => job.botThreadId === botThreadId);
    const transfers = mine.some((job) => job.status === "downloading")
      ? yield* slskd(Transfers, "GET", "transfers/downloads")
      : [];
    const iso = (ms: number | undefined) =>
      ms === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(ms));
    // @effect-diagnostics-next-line globalJsonInEffect:off - a compact tool reply for the model.
    return JSON.stringify({
      active: mine
        .filter((job) => job.status === "downloading" || job.status === "importing")
        .map((job) => {
          const files = observe(transfers, job.current).files;
          const total = job.current.files.reduce((sum, file) => sum + file.size, 0);
          const done = files.filter((file) => file.state === "succeeded").length;
          const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
          return {
            job: job.id,
            title: job.title,
            status: job.status,
            attempt: job.attempt,
            files: `${done}/${job.current.files.length}`,
            percent: total > 0 ? Math.round((bytes / total) * 100) : 0,
            from: job.current.username,
            started: iso(job.startedAt),
          };
        }),
      finished: mine
        .filter((job) => job.status === "done" || job.status === "failed")
        .slice(-10)
        .map((job) => ({
          title: job.title,
          status: job.status,
          result: job.result,
          ended: iso(job.endedAt),
        })),
    });
  }, Effect.mapError(asFailure));

  return MusicLibrary.of({
    search,
    download,
    status,
    start: Effect.fn("MusicLibrary.start")(function* () {
      yield* forkParked(
        tick().pipe(
          Effect.catchCause((cause) => Effect.logWarning("music watcher tick failed", { cause })),
          Effect.andThen(Effect.sleep(POLL)),
          Effect.forever,
        ),
      );
    }),
  });
});

const isImportRefused = Schema.is(ImportRefused);
const asFailure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : isImportRefused(error)
      ? failure(error.message)
      : failure("The Soulseek client is unavailable.");

export const layer = Layer.effect(MusicLibrary, make);

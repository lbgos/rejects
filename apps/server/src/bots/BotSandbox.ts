// @effect-diagnostics nodeBuiltinImport:off - a loopback listener tests the sandbox's network rule; staged files hash as streams.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { type ChatAttachment, ThreadId } from "@t3tools/contracts";
import {
  AgentSandbox,
  AgentScope,
  AgentScopeThreadId,
  type AgentSandboxShape,
  type AgentScopeShape,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import {
  buildBotProviderEnvironment,
  buildBotToolEnvironment,
} from "@t3tools/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { safeFileName } from "./attachments.ts";
import {
  BotModelProxy,
  claudeUpstream,
  layer as modelProxyLayer,
  sandboxClaudeSettings,
} from "./BotModelProxy.ts";
import { BotStore } from "./BotStore.ts";
import { slugFor } from "./computer.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  botCgroupProcs,
  brokenBwrapReason,
  bwrapArgs,
  enterCgroup,
  fingerprint,
  hostPathOf,
  installRoot,
  isSharedEntry,
  isWithin,
  loadedGrants,
  loadedNetworkFile,
  LOCAL_NETWORK_ENV,
  MEDIA_SLUG,
  mediaLayout,
  LOOPBACK_PROBE,
  missingBwrapReason,
  netRuleMissingReason,
  networkAllowFile,
  providerDirs,
  refusalCommand,
  sandboxAbsence,
  sandboxCgroupProcs,
  SandboxSettings,
  sandboxedDriverReason,
  shQuote,
} from "./sandbox.ts";

export interface SandboxCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * `absent`: switched off, or this machine lacks bwrap or the network rule's cgroup. Bots then run
 * on the host with their provider's own tools off. `broken`: set up but failing, so bots refuse.
 */
export type SandboxState =
  | { readonly kind: "ready" }
  | { readonly kind: "off" }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "broken"; readonly reason: string };

export interface BrowserSandbox {
  readonly executable: string;
  readonly profile: string;
}

/**
 * Each run sees the system read-only, its own workspace and home read-write, and the shared provider config read-only without credentials.
 * The server's state, the vault, other bots and provider keys are absent; model calls go through the server's model route.
 */
export class BotSandbox extends Context.Service<
  BotSandbox,
  {
    /** Read per call; a live provider session in the other mode restarts at its next turn. */
    readonly enabled: Effect.Effect<boolean>;
    /** Why a sandbox that is on and set up on this machine cannot run; undefined otherwise. */
    readonly unavailable: Effect.Effect<string | undefined>;
    /** Whether this machine has the sandbox, so `identity` is the bot's slug; `doctor` and the first run show it. */
    readonly state: Effect.Effect<SandboxState>;
    /** The bot's sandbox, while it is on and this machine has one. Bots without one run with their provider's tools off. */
    readonly identity: (threadId: string) => Effect.Effect<string | undefined>;
    readonly sessionIdentity: (threadId: string) => Effect.Effect<string | undefined>;
    readonly provider: (
      threadId: string,
      command: string,
      env: NodeJS.ProcessEnv | undefined,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<SandboxCommand | undefined>;
    readonly hostPath: (
      threadId: string,
      path: string,
      env: NodeJS.ProcessEnv,
    ) => Effect.Effect<string | undefined>;
    /**
     * The existing host file behind a path the bot names from inside its sandbox, such as a link
     * in its reply. Only its home, work dir and attachments view map; undefined otherwise.
     */
    readonly filePath: (threadId: string, path: string) => Effect.Effect<string | undefined>;
    /** Files of other chats stay out. */
    readonly stageAttachments: (
      threadId: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ) => Effect.Effect<ReadonlyMap<string, string>>;
    readonly shell: (botThreadId: string) => Effect.Effect<SandboxCommand | string>;
    readonly browser: (
      botThreadId: string,
      chromium: string,
    ) => Effect.Effect<BrowserSandbox | string>;
    readonly publishNetwork: Effect.Effect<void>;
    /** The bwrap prefix, ending in `--`, for yt-dlp and ffmpeg (see `mediaLayout`), or why there is none. */
    readonly media: (
      workDir: string,
      binaries: ReadonlyArray<{ readonly source: string; readonly name: string }>,
    ) => Effect.Effect<SandboxCommand | string>;
  }
>()("t3/bots/BotSandbox") {}

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxSettings));
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(UnknownFromJsonString);

type Probed<A> = A | { readonly reason: string };

const INTERPRETERS = new Set(["node", "bun", "deno"]);
const SANDBOX_INTERNAL_ENVIRONMENT = { T3_BOT_SANDBOX: "1" } as const;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* BotStore;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const modelProxy = yield* BotModelProxy;
  const toolEnvironment = {
    ...buildBotToolEnvironment(hostEnvironment),
    ...SANDBOX_INTERNAL_ENVIRONMENT,
  };
  const file = path.join(config.stateDir, "bot-sandbox.json");
  const root = path.join(config.stateDir, "sandbox");
  const workspaces = path.join(config.stateDir, "bots");

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.orElseSucceed(() => null),
    );

  const DEFAULT_SETTINGS = { enabled: true, network: "restricted" } as const;
  const settings = fs.readFileString(file).pipe(
    Effect.flatMap(decodeSettings),
    Effect.map((value) => ({ enabled: value.enabled, network: value.network ?? "restricted" })),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(DEFAULT_SETTINGS) : Effect.fail(error),
    }),
    // An unreadable or invalid switch keeps the sandbox on and its network restricted.
    Effect.catch((cause) =>
      Effect.logWarning("bot-sandbox.json is invalid; the sandbox stays on", { cause }).pipe(
        Effect.as(DEFAULT_SETTINGS),
      ),
    ),
  );
  const enabled = Effect.map(settings, (value) => value.enabled);

  // A working bwrap stays working; a missing or broken one is checked again on the next run.
  let bwrap: string | undefined;
  const probeBwrap: Effect.Effect<Probed<{ readonly bwrap: string }>> = Effect.gen(function* () {
    if (bwrap !== undefined) return { bwrap };
    const resolved = yield* resolve("bwrap", hostEnvironment);
    if (resolved === null) return { reason: missingBwrapReason() };
    const result = yield* runner
      .run({
        command: resolved,
        args: [
          "--unshare-all",
          "--unshare-cgroup",
          "--share-net",
          "--die-with-parent",
          "--ro-bind",
          "/",
          "/",
          "true",
        ],
        timeout: "10 seconds",
      })
      .pipe(Effect.option);
    if (result._tag === "Some" && result.value.code === 0) {
      bwrap = resolved;
      return { bwrap };
    }
    const detail =
      result._tag === "None"
        ? "it did not start"
        : result.value.stderr.trim().split("\n")[0] || `exit code ${String(result.value.code)}`;
    return { reason: brokenBwrapReason(detail) };
  });

  const loopbackListener = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

  // nftables is root's, so the rule is tested by use, at every launch: a process in the sandbox
  // cgroup must fail to reach a loopback port. A reload or unit restart can drop the rule.
  const cgroupPaths = fs.readFileString("/proc/self/cgroup").pipe(
    Effect.map((self) => {
      const procs = sandboxCgroupProcs(self);
      return procs === undefined ? undefined : { procs, loaded: loadedNetworkFile(self) };
    }),
    Effect.orElseSucceed(() => undefined),
  );
  const probeNetwork: Effect.Effect<
    Probed<{ readonly procs: string; readonly loaded: string | undefined }>
  > = Effect.gen(function* () {
    const paths = yield* cgroupPaths;
    if (paths === undefined)
      return { reason: netRuleMissingReason("this server is not in a cgroup v2 hierarchy") };
    const { procs, loaded } = paths;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const port = yield* loopbackListener;
        const probe = enterCgroup(procs, process.execPath, ["-e", LOOPBACK_PROBE, String(port)]);
        return yield* runner
          .run({ command: probe.command, args: probe.args, timeout: "10 seconds" })
          .pipe(Effect.option);
      }),
    );
    if (result._tag === "None" || (result.value.code !== 0 && result.value.code !== 1))
      return { reason: netRuleMissingReason(`${procs} cannot be entered`) };
    if (result.value.code === 0)
      return { reason: netRuleMissingReason("a sandboxed process reached this server's loopback") };
    return { procs, loaded };
  });

  // Static facts of the machine, cheap enough for every call: what makes the sandbox absent, not broken.
  // With the switch off, the bot computer still uses bwrap, without the network rule.
  const missing: Effect.Effect<string | undefined> = Effect.gen(function* () {
    const paths = yield* cgroupPaths;
    const current = yield* settings;
    return sandboxAbsence({
      platform,
      bwrap: bwrap !== undefined || (yield* resolve("bwrap", hostEnvironment)) !== null,
      networkOpen: !current.enabled || current.network === "open",
      networkSetUp:
        paths !== undefined &&
        (yield* fs.exists(path.dirname(paths.procs)).pipe(Effect.orElseSucceed(() => false))),
    });
  });

  const probe: Effect.Effect<
    Probed<{
      readonly bwrap: string;
      readonly procs: string | undefined;
      readonly loaded?: string | undefined;
    }>
  > = Effect.gen(function* () {
    const absent = yield* missing;
    if (absent !== undefined) return { reason: absent };
    const sandbox = yield* probeBwrap;
    if ("reason" in sandbox) return sandbox;
    const current = yield* settings;
    if (!current.enabled || current.network === "open")
      return { bwrap: sandbox.bwrap, procs: undefined };
    const network = yield* probeNetwork;
    return "reason" in network ? network : { bwrap: sandbox.bwrap, ...network };
  });

  const networkFor = Effect.fn("BotSandbox.networkFor")(function* (
    slug: string,
    ready: { readonly procs: string | undefined; readonly loaded?: string | undefined },
  ) {
    if (ready.procs === undefined) return { procs: undefined, environment: undefined, own: [] };
    const procs = botCgroupProcs(ready.procs, slug);
    const none = { procs, environment: undefined, own: [] };
    if (ready.loaded === undefined) return none;
    const text = yield* fs.readFileString(ready.loaded).pipe(
      Effect.tapError((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.logWarning("The bot sandbox cannot read what the network rule loaded", {
              cause,
            }),
      ),
      Effect.option,
    );
    if (text._tag === "None") return none;
    const { shared, own } = loadedGrants(text.value, slug);
    return { procs, environment: { [LOCAL_NETWORK_ENV]: [...shared, ...own].join(" ") }, own };
  });

  const sessionIdentity = Effect.fn("BotSandbox.sessionIdentity")(function* (threadId: string) {
    const slug = yield* identity(threadId);
    if (slug === undefined || (yield* settings).network === "open") return slug;
    const paths = yield* cgroupPaths;
    if (paths === undefined) return slug;
    const { own } = yield* networkFor(slug, paths);
    return own.length === 0 ? slug : `${slug}+${fingerprint(own.join(" "))}`;
  });

  const sshFor = (slug: string) => {
    const dir = path.join(config.stateDir, "bot-ssh", slug);
    return fs.exists(dir).pipe(
      Effect.map((found) => (found ? dir : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  };

  const allowFile = path.join(config.stateDir, "bot-sandbox-net.allow");
  const publishNetwork = Effect.gen(function* () {
    const contents = networkAllowFile(yield* store.list, slugFor);
    const current = yield* fs.readFileString(allowFile).pipe(Effect.option);
    if (current._tag === "Some" && current.value === contents) return;
    yield* writeFileStringAtomically({ filePath: allowFile, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Could not write bot-sandbox-net.allow", { cause })),
    Effect.withSpan("BotSandbox.publishNetwork"),
  );
  yield* publishNetwork;

  const ensureDirectory = (dir: string) =>
    fs.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);

  const realPath = (target: string) => fs.realPath(target).pipe(Effect.option);

  /**
   * bwrap follows a symlinked source on the host, so an entry that resolves anywhere else is not shared:
   * a link a bot planted while unsandboxed would otherwise mount its target into every bot.
   */
  const sharedEntries = Effect.fn("BotSandbox.sharedEntries")(function* (
    dir: string,
    rule: Parameters<typeof isSharedEntry>[0],
  ) {
    const real = yield* realPath(dir);
    if (real._tag === "None") return [];
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
    const shared: string[] = [];
    for (const name of names) {
      const entry = path.join(dir, name);
      const resolved = yield* realPath(entry);
      if (resolved._tag === "None" || resolved.value !== path.join(real.value, name)) continue;
      const info = yield* fs.stat(entry).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (isSharedEntry(rule, name, info.value.type === "Directory")) shared.push(entry);
    }
    return shared;
  });

  const homeOf = (env: NodeJS.ProcessEnv, homeSource: string) => {
    const home = env.HOME?.trim();
    return home && path.isAbsolute(home) && home !== "/" ? path.resolve(home) : homeSource;
  };

  const botSlug = (threadId: string) =>
    store
      .owner(ThreadId.make(threadId))
      .pipe(Effect.map((bot) => (bot === undefined ? undefined : slugFor(bot.threadId))));

  const attachmentsView = (slug: string, threadId: string) =>
    path.join(root, slug, "attachments", toSafeThreadAttachmentSegment(threadId) ?? "thread");

  const sha256 = (file: string) =>
    fs.stream(file).pipe(
      Stream.runFold(
        () => NodeCrypto.createHash("sha256"),
        (hash, chunk) => hash.update(chunk),
      ),
      Effect.map((hash) => hash.digest("hex")),
    );

  // The short name hard-links the id-named copy, so large files cost no second copy or read.
  const stageShortCopy = Effect.fn("BotSandbox.stageShortCopy")(function* (
    view: string,
    name: string,
    copy: string,
  ) {
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    const info = yield* fs.stat(copy);
    const inode = Option.getOrUndefined(info.ino);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${extension}`;
      const target = path.join(view, candidate);
      const link = yield* fs.readLink(target).pipe(Effect.option);
      if (link._tag === "Some") yield* fs.remove(target);
      const existing = yield* fs.stat(target).pipe(Effect.option);
      if (existing._tag === "None") {
        yield* fs.link(copy, target).pipe(Effect.catch(() => fs.copyFile(copy, target)));
        return candidate;
      }
      if (
        inode !== undefined &&
        existing.value.dev === info.dev &&
        Option.getOrUndefined(existing.value.ino) === inode
      )
        return candidate;
      if (existing.value.size === info.size && (yield* sha256(target)) === (yield* sha256(copy)))
        return candidate;
    }
  });

  const stageAttachments = Effect.fn("BotSandbox.stageAttachments")(function* (
    threadId: string,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    const staged = new Map<string, string>();
    if (attachments.length === 0) return staged;
    const bot = yield* store.owner(ThreadId.make(threadId));
    // The main bot routes files unopened, so its sandbox gets no copy.
    if (bot === undefined || bot.threadId === (yield* store.mainBot)) return staged;
    const view = attachmentsView(slugFor(bot.threadId), threadId);
    yield* ensureDirectory(view);
    yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const source = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (source === null) return;
          const target = path.join(view, path.basename(source));
          // Views were writable once: a link left there would turn the copy into a host write.
          for (const file of [target, `${target}.txt`]) {
            const link = yield* fs.readLink(file).pipe(Effect.option);
            if (link._tag === "Some") yield* fs.remove(file);
          }
          const [info, existing] = yield* Effect.all([
            fs.stat(source).pipe(Effect.option),
            fs.stat(target).pipe(Effect.option),
          ]);
          if (info._tag === "None") return;
          if (existing._tag !== "Some" || existing.value.size !== info.value.size) {
            yield* fs.copyFile(source, target);
            if (yield* fs.exists(`${source}.txt`).pipe(Effect.orElseSucceed(() => false))) {
              yield* fs.copyFile(`${source}.txt`, `${target}.txt`);
            }
          }
          // The id-named path is too long for a model to retype; the prompt names this one.
          const short = yield* stageShortCopy(view, safeFileName(attachment.name), target);
          if (yield* fs.exists(`${source}.txt`).pipe(Effect.orElseSucceed(() => false))) {
            const textTarget = path.join(view, `${short}.txt`);
            const link = yield* fs.readLink(textTarget).pipe(Effect.option);
            if (link._tag === "Some") yield* fs.remove(textTarget);
            yield* fs.copyFile(`${source}.txt`, textTarget);
          }
          staged.set(attachment.id, path.join(config.attachmentsDir, short));
        }),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not stage a bot chat attachment.", { cause }),
      ),
    );
    return staged;
  });

  const baseLayout = (slug: string, threadId: string, env: NodeJS.ProcessEnv) => {
    const homeSource = path.join(root, slug, "home");
    return {
      home: homeOf(env, homeSource),
      homeSource,
      workspace: { target: workspaces, source: path.join(workspaces, slug) },
      binds: [],
      // The prompt names host attachment paths; the view holds this thread's files only.
      attachments: { source: attachmentsView(slug, threadId), target: config.attachmentsDir },
    };
  };

  const homeLayout = Effect.fn("BotSandbox.homeLayout")(function* (
    slug: string,
    threadId: string,
    env: NodeJS.ProcessEnv,
  ) {
    const layout = baseLayout(slug, threadId, env);
    yield* ensureDirectory(layout.homeSource);
    yield* ensureDirectory(layout.workspace.source);
    yield* ensureDirectory(layout.attachments.source);
    return layout;
  });

  const providerLayout = Effect.fn("BotSandbox.providerLayout")(function* (
    slug: string,
    threadId: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const base = yield* homeLayout(slug, threadId, environment);
    const binds: Array<{ source: string; target: string }> = [...base.binds];
    const readOnly: string[] = [];
    const files: Array<{ source: string; target: string }> = [];
    for (const [index, dir] of providerDirs(environment, base.home, path.join).entries()) {
      const target = path.resolve(dir.path);
      // A provider home outside HOME gets its own per-bot directory; inside HOME it already has one.
      if (!isWithin(base.home, target)) {
        const source = path.join(root, slug, "dirs", String(index));
        yield* ensureDirectory(source);
        binds.push({ source, target });
      }
      const shared = yield* sharedEntries(target, dir.share);
      readOnly.push(...shared);
      const settings = dir.claudeSettings
        ? [
            {
              source: path.join(root, slug, "settings", `${index}.json`),
              target: path.join(target, "settings.json"),
            },
          ]
        : [];
      files.push(...settings);
      yield* clearPlaceholders(
        hostPathOf({ ...base, binds, readOnly: [] }, target),
        new Set(
          [...shared, ...settings.map((file) => file.target)].map((entry) => path.basename(entry)),
        ),
      );
    }
    return { ...base, binds, readOnly, files };
  });

  /**
   * bwrap leaves an empty read-only file in the bot's own provider home where it mounted a shared
   * file. Once that file is per bot, the placeholder would keep the CLI from writing its own.
   */
  const clearPlaceholders = Effect.fn("BotSandbox.clearPlaceholders")(function* (
    botDir: string,
    shared: ReadonlySet<string>,
  ) {
    const names = yield* fs.readDirectory(botDir).pipe(Effect.orElseSucceed((): string[] => []));
    for (const name of names) {
      if (shared.has(name)) continue;
      const entry = path.join(botDir, name);
      const info = yield* fs.stat(entry).pipe(Effect.option);
      if (
        info._tag === "Some" &&
        info.value.type === "File" &&
        info.value.size === 0n &&
        (info.value.mode & 0o222) === 0
      )
        yield* fs.remove(entry).pipe(Effect.ignore);
    }
  });

  const writeClaudeSettings = Effect.fn("BotSandbox.writeClaudeSettings")(function* (
    slug: string,
    file: { readonly source: string; readonly target: string },
    environment: NodeJS.ProcessEnv,
  ) {
    const dir = path.dirname(file.target);
    const [realDir, realFile] = yield* Effect.all([realPath(dir), realPath(file.target)]);
    // A link planted while unsandboxed would hand the bot whatever JSON file it points at.
    const host =
      realDir._tag === "Some" &&
      realFile._tag === "Some" &&
      realFile.value === path.join(realDir.value, "settings.json")
        ? yield* fs.readFileString(realFile.value).pipe(
            Effect.flatMap(decodeJson),
            Effect.orElseSucceed((): unknown => ({})),
          )
        : {};
    const upstream = claudeUpstream(host, environment);
    const grant = upstream === undefined ? undefined : yield* modelProxy.grant(slug, dir, upstream);
    yield* ensureDirectory(path.dirname(file.source));
    const contents = yield* encodeJson(sandboxClaudeSettings(host, grant)).pipe(Effect.orDie);
    yield* fs.writeFileString(file.source, contents, { mode: 0o600 }).pipe(Effect.orDie);
    return grant;
  });

  const identity = Effect.fn("BotSandbox.identity")(function* (threadId: string) {
    return (yield* enabled) && (yield* missing) === undefined
      ? yield* botSlug(threadId)
      : undefined;
  });

  const provider = Effect.fn("BotSandbox.provider")(function* (
    threadId: string,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    args: ReadonlyArray<string>,
  ) {
    const slug = yield* identity(threadId);
    if (slug === undefined) return undefined;
    const ready = yield* probe;
    if ("reason" in ready) return refusalCommand(ready.reason);
    const environment = env ?? hostEnvironment;
    const layout = yield* providerLayout(slug, threadId, environment);
    const grants = yield* Effect.forEach(layout.files, (file) =>
      writeClaudeSettings(slug, file, environment),
    );
    const grant = grants.find((entry) => entry !== undefined);
    const readOnly = [...layout.readOnly];
    const resolved = yield* resolve(command, environment);
    // `node cli.js` needs the script's install too, not only the interpreter's.
    const script =
      INTERPRETERS.has(path.basename(command)) && args[0] !== undefined && path.isAbsolute(args[0])
        ? args[0]
        : null;
    for (const file of [resolved, script]) {
      if (file === null) continue;
      const real = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
      const install = installRoot(real, [layout.home, config.stateDir, root]);
      if (install !== undefined) readOnly.push(install);
    }
    const network = yield* networkFor(slug, ready);
    const sandboxArgs = bwrapArgs({
      ...layout,
      readOnly,
      ssh: yield* sshFor(slug),
      environment: {
        ...(buildBotProviderEnvironment(environment, SANDBOX_INTERNAL_ENVIRONMENT) as Readonly<
          Record<string, string>
        >),
        ...network.environment,
        // Settings carry it too; this keeps a host variable from pointing past the route.
        ...(grant === undefined ? {} : { ANTHROPIC_BASE_URL: grant.url }),
      },
    });
    // An unresolved command still runs inside the sandbox, where it fails to start.
    return enterCgroup(network.procs, ready.bwrap, [...sandboxArgs, "--", resolved ?? command]);
  });

  return BotSandbox.of({
    enabled,
    unavailable: Effect.gen(function* () {
      if (!(yield* enabled) || (yield* missing) !== undefined) return undefined;
      const ready = yield* probe;
      return "reason" in ready ? ready.reason : undefined;
    }),
    state: Effect.gen(function* () {
      if (!(yield* enabled)) return { kind: "off" } as const;
      const reason = yield* missing;
      if (reason !== undefined) return { kind: "absent", reason } as const;
      const ready = yield* probe;
      return "reason" in ready
        ? ({ kind: "broken", reason: ready.reason } as const)
        : ({ kind: "ready" } as const);
    }),
    identity,
    sessionIdentity,
    provider,
    hostPath: Effect.fn("BotSandbox.hostPath")(function* (threadId, target, env) {
      const slug = yield* identity(threadId);
      if (slug === undefined) return undefined;
      return hostPathOf(yield* providerLayout(slug, threadId, env), path.resolve(target));
    }),
    filePath: Effect.fn("BotSandbox.filePath")(function* (threadId, target) {
      const slug = yield* identity(threadId);
      if (slug === undefined) return undefined;
      const requested = path.resolve(target);
      const host = hostPathOf(
        { ...baseLayout(slug, threadId, hostEnvironment), readOnly: [] },
        requested,
      );
      if (host === requested) return undefined;
      // Main gets no attachments view, and older chats name real host files under these roots.
      return (yield* fs.exists(host).pipe(Effect.orElseSucceed(() => false))) ? host : undefined;
    }),
    stageAttachments,
    shell: Effect.fn("BotSandbox.shell")(function* (botThreadId) {
      const ready = yield* probe;
      if ("reason" in ready) return ready.reason;
      const slug = slugFor(botThreadId);
      const base = yield* homeLayout(slug, botThreadId, hostEnvironment);
      const network = yield* networkFor(slug, ready);
      return enterCgroup(network.procs, ready.bwrap, [
        ...bwrapArgs({
          ...base,
          readOnly: [],
          ssh: yield* sshFor(slug),
          environment: { ...toolEnvironment, ...network.environment },
        }),
        "--",
      ]);
    }),
    publishNetwork,
    media: Effect.fn("BotSandbox.media")(function* (workDir, binaries) {
      const ready = yield* probe;
      if ("reason" in ready) return ready.reason;
      const network = yield* networkFor(MEDIA_SLUG, ready);
      return enterCgroup(network.procs, ready.bwrap, [
        ...bwrapArgs(mediaLayout(workDir, binaries)),
        "--",
      ]);
    }),
    browser: Effect.fn("BotSandbox.browser")(function* (botThreadId, chromium) {
      const ready = yield* probe;
      if ("reason" in ready) return ready.reason;
      const resolved = yield* resolve(chromium, hostEnvironment);
      if (resolved === null)
        return "Chromium is not installed on this server, so the bot has no browser.";
      const slug = slugFor(botThreadId);
      const home = path.join(root, slug, "browser");
      const profile = path.join(home, "profile");
      yield* ensureDirectory(profile);
      const args = bwrapArgs({
        home,
        homeSource: home,
        binds: [],
        readOnly: [],
        system: ["/sys"],
        environment: toolEnvironment,
      });
      // Playwright appends Chromium's flags and talks CDP over fds 3 and 4, which bwrap keeps.
      const executable = path.join(root, slug, "chromium");
      const network = yield* networkFor(slug, ready);
      const launch = enterCgroup(network.procs, ready.bwrap, [...args, "--", resolved]);
      yield* fs
        .writeFileString(
          executable,
          `#!/bin/sh\nexec ${[launch.command, ...launch.args].map(shQuote).join(" ")} "$@"\n`,
          { mode: 0o700 },
        )
        .pipe(Effect.andThen(fs.chmod(executable, 0o700)), Effect.orDie);
      return { executable, profile };
    }),
  });
});

export const layerWithRunner = Layer.effect(BotSandbox, make);
export const layer = layerWithRunner.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(modelProxyLayer),
);

const agentSandbox = Effect.gen(function* () {
  const sandbox = yield* BotSandbox;
  return {
    identity: (threadId) => Effect.map(sandbox.sessionIdentity(threadId), Option.fromUndefinedOr),
    refusal: (threadId, driver) =>
      sandbox
        .identity(threadId)
        .pipe(
          Effect.flatMap((identity) =>
            identity === undefined
              ? Effect.succeedNone
              : Effect.map(sandbox.unavailable, (reason) =>
                  Option.fromUndefinedOr(reason ?? sandboxedDriverReason(driver)),
                ),
          ),
        ),
    launch: Effect.fn("BotSandbox.launch")(function* (input) {
      const launch =
        input.threadId === undefined
          ? undefined
          : yield* sandbox.provider(input.threadId, input.command, input.env, input.args);
      return launch === undefined
        ? { command: input.command, args: input.args }
        : { command: launch.command, args: [...launch.args, ...input.args] };
    }),
    hostPath: ({ threadId, path, env }) =>
      Effect.map(sandbox.hostPath(threadId, path, env), Option.fromUndefinedOr),
    filePath: ({ threadId, path }) =>
      Effect.map(sandbox.filePath(threadId, path), Option.fromUndefinedOr),
    stageAttachments: (threadId, attachments) => sandbox.stageAttachments(threadId, attachments),
  } satisfies AgentSandboxShape;
});

export const agentScopeLayer = Layer.mergeAll(
  Layer.effect(
    AgentScope,
    Effect.gen(function* () {
      const inner = yield* AgentScope;
      const sandbox = yield* agentSandbox;
      return {
        ...inner,
        wrap: Effect.fn("BotSandbox.wrap")(function* (input) {
          if (input.survivesRestart === true) return yield* inner.wrap(input);
          const launch = yield* sandbox.launch({
            threadId: input.threadId ?? (yield* AgentScopeThreadId),
            command: input.command,
            args: input.args,
            env: input.env,
          });
          return yield* inner.wrap({ ...input, ...launch });
        }),
      } satisfies AgentScopeShape;
    }),
  ),
  Layer.effect(AgentSandbox, agentSandbox),
);

import { parseLocalNetworkEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A missing file means on, so a new instance starts sandboxed and an existing one opts out with `{ "enabled": false }`.
 * `network` defaults to `restricted`: sandboxes reach the internet but not this host's loopback or the LAN.
 */
export const SandboxSettings = Schema.Struct({
  enabled: Schema.Boolean,
  network: Schema.optional(Schema.Literals(["restricted", "open"])),
});

export const sandboxCgroupProcs = (procSelfCgroup: string): string | undefined => {
  const line = procSelfCgroup.split("\n").find((entry) => entry.startsWith("0::"));
  if (line === undefined) return undefined;
  const path = line.slice(3).trim().replace(/\/+$/, "");
  return `/sys/fs/cgroup${path}/sandbox/cgroup.procs`;
};

/** bwrap makes it the root of the bot's cgroup namespace, so no bot can move into another's and take its Local network access. */
export const botCgroupProcs = (procs: string, slug: string) =>
  procs.replace(/cgroup\.procs$/, `${slug}/cgroup.procs`);

export const networkAllowFile = (
  bots: ReadonlyArray<{
    readonly threadId: string;
    readonly localNetwork?: ReadonlyArray<string> | undefined;
  }>,
  slug: (threadId: string) => string,
) =>
  bots
    .flatMap((bot) =>
      (bot.localNetwork ?? []).flatMap((entry) => {
        const parsed = parseLocalNetworkEntry(entry);
        return parsed === undefined ? [] : [`${slug(bot.threadId)} ${parsed}`];
      }),
    )
    .map((line) => `${line}\n`)
    .join("");

export const loadedNetworkFile = (procSelfCgroup: string) => {
  const line = procSelfCgroup.split("\n").find((entry) => entry.startsWith("0::"));
  const unit = line?.slice(3).trim().replace(/\/+$/, "").split("/").pop();
  return unit ? `/run/bot-sandbox-net/${unit}.loaded` : undefined;
};

export const loadedGrants = (loaded: string, slug: string) => {
  const shared: string[] = [];
  const own: string[] = [];
  for (const line of loaded.split("\n")) {
    const [owner, entry] = line.trim().split(/\s+/);
    if (entry === undefined) continue;
    if (owner === "*") shared.push(entry);
    else if (owner === slug) own.push(entry);
  }
  return { shared, own };
};

export const fingerprint = (text: string) => {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

export const LOCAL_NETWORK_ENV = "BOT_LOCAL_NETWORK";

// Runs nothing unless it got into the cgroup: outside it the network rule does not apply. A bot's
// own cgroup is made on first use; the rule's script makes those of bots with grants.
const ENTER_SCRIPT =
  'mkdir -p "${1%/cgroup.procs}" 2>/dev/null; echo $$ >"$1" || { echo "bot sandbox: could not enter $1" >&2; exit 126; }; shift; exec "$@"';

export const enterCgroup = (
  procs: string | undefined,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  procs === undefined
    ? { command, args }
    : { command: "/bin/sh", args: ["-c", ENTER_SCRIPT, "bot-sandbox", procs, command, ...args] };

export const LOOPBACK_PROBE = `const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),3000);`;

export const netRuleMissingReason = (detail: string) =>
  `The bot sandbox keeps bots off this server's loopback and local network, but that rule is not in place (${detail}), so the bot did not run. Load it from the server's unit with scripts/bot-sandbox-net.sh (docs/operations/bot-sandbox.md), or set "network": "open" in bot-sandbox.json.`;

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt"];

export interface SandboxLayout {
  /** The sandbox's HOME; the bot's own `homeSource` is mounted there, hiding the server's home. */
  readonly home: string;
  readonly homeSource: string;
  readonly workspace?: { readonly target: string; readonly source: string } | undefined;
  readonly binds: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  /**
   * The thread's attachments view, read-only: the server copies files into it on the host, so a
   * link the bot could plant there would redirect that copy anywhere the server may write.
   */
  readonly attachments?: { readonly source: string; readonly target: string } | undefined;
  readonly readOnly: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly system?: ReadonlyArray<string>;
  readonly ssh?: string | undefined;
  /** Environment explicitly passed after bwrap clears the host environment. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

/** The sandbox dies with its parent, so a killed launcher takes every process inside with it. */
export const bwrapArgs = (layout: SandboxLayout): string[] => [
  "--unshare-all",
  // `--unshare-all` only tries; without its own cgroup namespace a bot could join another's cgroup.
  "--unshare-cgroup",
  "--share-net",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  ...SYSTEM_DIRS.flatMap((dir) => ["--ro-bind-try", dir, dir]),
  ...(layout.system ?? []).flatMap((dir) => ["--ro-bind-try", dir, dir]),
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  "--bind",
  layout.homeSource,
  layout.home,
  ...(layout.workspace ? ["--bind", layout.workspace.source, layout.workspace.target] : []),
  ...layout.binds.flatMap(({ source, target }) => ["--bind", source, target]),
  ...(layout.attachments
    ? ["--ro-bind", layout.attachments.source, layout.attachments.target]
    : []),
  ...layout.readOnly.flatMap((path) => ["--ro-bind", path, path]),
  ...(layout.files ?? []).flatMap(({ source, target }) => ["--ro-bind", source, target]),
  ...(layout.ssh ? ["--ro-bind", layout.ssh, `${layout.home}/.ssh`] : []),
  ...Object.entries(layout.environment ?? {}).flatMap(([name, value]) => ["--setenv", name, value]),
  "--setenv",
  "HOME",
  layout.home,
  "--setenv",
  "TMPDIR",
  "/tmp",
  "--chdir",
  layout.workspace?.target ?? layout.home,
];

export const MEDIA_WORK_DIR = "/work";
export const MEDIA_TOOLS_DIR = "/tools";
/** The cgroup the video downloader runs in, next to the bots': the network rule keeps it on public addresses. */
export const MEDIA_SLUG = "video-media";

/**
 * yt-dlp and ffmpeg parse media from the web, so they see the system read-only, their work
 * directory at `/work` and their own binaries under `/tools`; the server's home and state are absent.
 */
export const mediaLayout = (
  workDir: string,
  binaries: ReadonlyArray<{ readonly source: string; readonly name: string }>,
): SandboxLayout => ({
  home: MEDIA_WORK_DIR,
  homeSource: workDir,
  binds: [],
  readOnly: [],
  files: binaries.map(({ source, name }) => ({ source, target: `${MEDIA_TOOLS_DIR}/${name}` })),
  environment: { PATH: `${MEDIA_TOOLS_DIR}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" },
});

export type ShareRule = "config" | ReadonlyArray<string>;

export interface ProviderDir {
  readonly path: string;
  readonly share: ShareRule;
  readonly claudeSettings?: boolean;
}

const CONFIG_DIRS = new Set([
  "agents",
  "commands",
  "hooks",
  "output-styles",
  "plugins",
  "prompts",
  "rules",
  "skills",
]);
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

/**
 * Config dirs and instruction files are shared. Settings, keys, credentials, backups, sessions
 * and caches are not: a file is shared only when it is known to hold no secret.
 */
export const isSharedEntry = (rule: ShareRule, name: string, directory: boolean) => {
  if (rule !== "config") return rule.includes(name);
  return directory ? CONFIG_DIRS.has(name) : INSTRUCTION_FILES.has(name);
};

export const providerDirs = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  join: (...parts: string[]) => string,
): ProviderDir[] => {
  const set = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  const config = set(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  const data = set(env.XDG_DATA_HOME) ?? join(home, ".local", "share");
  const opencodeData = set(env.OPENCODE_DATA_DIR)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [join(data, "opencode")];
  return [
    {
      path: set(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude"),
      share: "config",
      claudeSettings: true,
    },
    { path: set(env.CODEX_HOME) ?? join(home, ".codex"), share: "config" },
    { path: join(config, "opencode"), share: "config" },
    // OpenCode keeps its keys in the data dir's auth.json: nothing there is shared.
    ...opencodeData.map((path) => ({ path, share: [] })),
  ];
};

export const isWithin = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

export const hostPathOf = (layout: SandboxLayout, target: string) => {
  const mounts = [
    { source: layout.homeSource, target: layout.home },
    ...(layout.workspace ? [layout.workspace] : []),
    ...layout.binds,
    ...(layout.attachments ? [layout.attachments] : []),
    ...layout.readOnly.map((path) => ({ source: path, target: path })),
    ...(layout.files ?? []),
  ];
  const mount = mounts.findLast((candidate) => isWithin(candidate.target, target));
  return mount === undefined ? target : mount.source + target.slice(mount.target.length);
};

/** A directory that holds a protected path (the server's home or state) is never mounted; then only the file is. */
export const installRoot = (realCommand: string, protectedPaths: ReadonlyArray<string>) => {
  if (SYSTEM_DIRS.some((dir) => isWithin(dir, realCommand))) return undefined;
  const modules = realCommand.lastIndexOf("/node_modules/");
  const candidate =
    modules >= 0
      ? realCommand.slice(0, modules + "/node_modules".length)
      : realCommand.slice(0, Math.max(1, realCommand.lastIndexOf("/")));
  return protectedPaths.some((path) => isWithin(candidate, path)) ? realCommand : candidate;
};

export const shQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const SANDBOX_OFF_HINT =
  "turn the sandbox off in bot-sandbox.json, so bots run without their provider's own tools";

/** No sandbox means no shell: bots run on the host with their provider's own tools off. */
const absentReason = (detail: string) =>
  `This machine has no bot sandbox (${detail}), so bots run without a shell, files or a browser of their own.`;

/**
 * Why this machine has no sandbox, from facts that do not flap: a sandbox that is set up but fails
 * is broken instead, and its bots refuse to run.
 */
export const sandboxAbsence = (facts: {
  readonly platform: string;
  readonly bwrap: boolean;
  readonly networkOpen: boolean;
  /** The network rule's cgroup exists, so the rule was loaded at least once. */
  readonly networkSetUp: boolean;
}) =>
  facts.platform !== "linux"
    ? absentReason("it needs Linux")
    : !facts.bwrap
      ? absentReason("bubblewrap (bwrap) is not installed")
      : facts.networkOpen || facts.networkSetUp
        ? undefined
        : absentReason("the network rule is not set up, see docs/operations/bot-sandbox.md");

export const missingBwrapReason = () =>
  `The bot sandbox is on, but bubblewrap (bwrap) is not installed on this server, so the bot did not run. Install bubblewrap, or ${SANDBOX_OFF_HINT}.`;

const WITHOUT_MODEL_ROUTE = new Map([
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
]);

export const sandboxedDriverReason = (driver: string) => {
  const name = WITHOUT_MODEL_ROUTE.get(driver);
  return name === undefined
    ? undefined
    : `${name} is not available for sandboxed bots: the sandbox holds no provider key, and only Claude models reach their provider through this server. Pick a Claude model for this bot, or ${SANDBOX_OFF_HINT}.`;
};

export const brokenBwrapReason = (detail: string) =>
  `The bot sandbox is on, but bubblewrap cannot create a sandbox on this server (${detail}), so the bot did not run. Unprivileged user namespaces must work, and the server's systemd unit must not set RestrictSUIDSGID=yes; or ${SANDBOX_OFF_HINT}.`;

/** A command that refuses to run: it prints why and exits 126, for spawn paths that cannot fail. */
export const refusalCommand = (reason: string) => ({
  command: "/bin/sh",
  args: ["-c", 'printf "%s\\n" "$1" >&2; exit 126', "bot-sandbox", reason],
});

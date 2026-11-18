// @effect-diagnostics nodeBuiltinImport:off - runs the root script that loads the network rule.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  bwrapArgs,
  hostPathOf,
  installRoot,
  isSharedEntry,
  loadedGrants,
  mediaLayout,
  networkAllowFile,
  providerDirs,
  sandboxAbsence,
  sandboxedDriverReason,
} from "./sandbox.ts";
import { buildBotProviderEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

const mounts = (args: ReadonlyArray<string>) => {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--bind" || flag === "--ro-bind" || flag === "--ro-bind-try") {
      found.push(`${flag} ${args[i + 1]} ${args[i + 2]}`);
      i += 2;
    } else if (flag === "--tmpfs" || flag === "--proc" || flag === "--dev") {
      found.push(`${flag} ${args[i + 1]}`);
      i += 1;
    }
  }
  return found;
};

describe("bwrapArgs", () => {
  it("clears the host environment and passes only provider-safe variables", () => {
    const args = bwrapArgs({
      home: "/home/bot",
      homeSource: "/state/bot/home",
      binds: [],
      readOnly: [],
      environment: buildBotProviderEnvironment({
        PATH: "/bin",
        HOME: "/host",
        LANG: "C.UTF-8",
        TERM: "xterm",
        CLAUDE_CONFIG_DIR: "/bot/.claude",
        ANTHROPIC_API_KEY: "secret",
      }) as Readonly<Record<string, string>>,
    });
    expect(args).toContain("--clearenv");
    expect(args).toContain("PATH");
    expect(args).toContain("/bin");
    expect(args).toContain("CLAUDE_CONFIG_DIR");
    expect(args).toContain("/bot/.claude");
    expect(args).not.toContain("secret");
  });
  it("unshares all but the network and mounts the bot's own dirs over the server's", () => {
    const args = bwrapArgs({
      home: "/var/lib/rejects",
      homeSource: "/var/lib/rejects/userdata/sandbox/news/home",
      workspace: {
        target: "/var/lib/rejects/userdata/bots",
        source: "/var/lib/rejects/userdata/bots/news",
      },
      binds: [{ source: "/var/lib/rejects/userdata/sandbox/news/dirs/0", target: "/srv/claude" }],
      attachments: {
        source: "/var/lib/rejects/userdata/sandbox/news/attachments/news",
        target: "/var/lib/rejects/userdata/attachments",
      },
      readOnly: ["/srv/claude/skills", "/var/lib/rejects/tools/codex/node_modules"],
      files: [
        {
          source: "/var/lib/rejects/userdata/sandbox/news/settings/0.json",
          target: "/srv/claude/settings.json",
        },
      ],
      ssh: "/var/lib/rejects/userdata/bot-ssh/news",
      environment: { BOT_LOCAL_NETWORK: "192.168.1.10:22" },
    });
    expect(args.slice(0, 5)).toEqual([
      "--unshare-all",
      "--unshare-cgroup",
      "--share-net",
      "--die-with-parent",
      "--new-session",
    ]);
    expect(mounts(args).filter((mount) => !mount.startsWith("--ro-bind-try"))).toEqual([
      "--proc /proc",
      "--dev /dev",
      "--tmpfs /tmp",
      "--bind /var/lib/rejects/userdata/sandbox/news/home /var/lib/rejects",
      "--bind /var/lib/rejects/userdata/bots/news /var/lib/rejects/userdata/bots",
      "--bind /var/lib/rejects/userdata/sandbox/news/dirs/0 /srv/claude",
      "--ro-bind /var/lib/rejects/userdata/sandbox/news/attachments/news /var/lib/rejects/userdata/attachments",
      "--ro-bind /srv/claude/skills /srv/claude/skills",
      "--ro-bind /var/lib/rejects/tools/codex/node_modules /var/lib/rejects/tools/codex/node_modules",
      "--ro-bind /var/lib/rejects/userdata/sandbox/news/settings/0.json /srv/claude/settings.json",
      "--ro-bind /var/lib/rejects/userdata/bot-ssh/news /var/lib/rejects/.ssh",
    ]);
    expect(args.join(" ")).toContain("--setenv BOT_LOCAL_NETWORK 192.168.1.10:22");
    expect(mounts(args).filter((mount) => mount.startsWith("--ro-bind-try"))).toContain(
      "--ro-bind-try /usr /usr",
    );
    expect(args.slice(-2)).toEqual(["--chdir", "/var/lib/rejects/userdata/bots"]);
  });

  it("starts in HOME without a workspace and adds the extra system paths", () => {
    const args = bwrapArgs({
      home: "/state/sandbox/news/browser",
      homeSource: "/state/sandbox/news/browser",
      binds: [],
      readOnly: [],
      system: ["/sys"],
    });
    expect(mounts(args)).toContain("--ro-bind-try /sys /sys");
    expect(args.slice(-2)).toEqual(["--chdir", "/state/sandbox/news/browser"]);
  });
});

describe("sandboxAbsence", () => {
  const linux = { platform: "linux", bwrap: true, networkOpen: false, networkSetUp: true };
  it.each([
    [{}, undefined],
    [{ platform: "darwin" }, /needs Linux/],
    [{ bwrap: false }, /bwrap\) is not installed/],
    [{ networkSetUp: false }, /network rule is not set up/],
    [{ networkSetUp: false, networkOpen: true }, undefined],
  ])("%o: %s", (facts, reason) => {
    const absent = sandboxAbsence({ ...linux, ...facts });
    if (reason === undefined) expect(absent).toBeUndefined();
    else expect(absent).toMatch(reason);
  });
});

describe("mediaLayout", () => {
  it("gives the video downloader its work dir and binaries, and no other path of the server's", () => {
    const state = "/var/lib/rejects/userdata";
    const layout = mediaLayout(`${state}/video-tmp/video-1`, [
      { source: `${state}/tools/yt-dlp`, name: "yt-dlp" },
    ]);
    const args = bwrapArgs(layout);
    expect(mounts(args).filter((mount) => !mount.startsWith("--ro-bind-try"))).toEqual([
      "--proc /proc",
      "--dev /dev",
      "--tmpfs /tmp",
      `--bind ${state}/video-tmp/video-1 /work`,
      `--ro-bind ${state}/tools/yt-dlp /tools/yt-dlp`,
    ]);
    expect(hostPathOf(layout, `${state}/bots.json`)).toBe(`${state}/bots.json`);
    expect(args).toContain("--clearenv");
    expect(args.slice(-2)).toEqual(["--chdir", "/work"]);
  });
});

describe("hostPathOf", () => {
  it("follows the innermost mount, so the server reads the bot's own copy", () => {
    const layout = {
      home: "/var/lib/rejects",
      homeSource: "/state/sandbox/news/home",
      workspace: { target: "/state/bots", source: "/state/bots/news" },
      binds: [{ source: "/state/sandbox/news/dirs/0", target: "/srv/claude" }],
      readOnly: ["/srv/claude/skills"],
      files: [
        { source: "/state/sandbox/news/settings/0.json", target: "/srv/claude/settings.json" },
      ],
    };
    expect(hostPathOf(layout, "/var/lib/rejects/.claude/projects")).toBe(
      "/state/sandbox/news/home/.claude/projects",
    );
    expect(hostPathOf(layout, "/srv/claude/projects")).toBe("/state/sandbox/news/dirs/0/projects");
    expect(hostPathOf(layout, "/srv/claude/skills/a.md")).toBe("/srv/claude/skills/a.md");
    expect(hostPathOf(layout, "/srv/claude/settings.json")).toBe(
      "/state/sandbox/news/settings/0.json",
    );
    expect(hostPathOf(layout, "/state/bots/notes.md")).toBe("/state/bots/news/notes.md");
    expect(hostPathOf(layout, "/usr/bin/claude")).toBe("/usr/bin/claude");
  });
});

describe("isSharedEntry", () => {
  it.each([
    ["config", "skills", true, true],
    ["config", "plugins", true, true],
    ["config", "CLAUDE.md", false, true],
    ["config", "AGENTS.md", false, true],
    ["config", "settings.json", false, false],
    ["config", "settings.json.bak-old", false, false],
    ["config", ".credentials.json", false, false],
    ["config", "config.toml", false, false],
    ["config", "auth.json", false, false],
    ["config", "client.key", false, false],
    ["config", "installation_id", false, false],
    ["config", ".claude.json", false, false],
    ["config", "history.jsonl", false, false],
    ["config", "projects", true, false],
    ["config", "sessions", true, false],
    [[], "auth.json", false, false],
  ] as const)("%j %s (dir: %s) shared: %s", (rule, name, directory, shared) => {
    expect(isSharedEntry(rule, name, directory)).toBe(shared);
  });
});

describe("sandboxedDriverReason", () => {
  it.each([
    ["codex", "Codex is not available for sandboxed bots"],
    ["opencode", "OpenCode is not available for sandboxed bots"],
    ["claudeAgent", undefined],
  ])("%s", (driver, reason) => {
    const found = sandboxedDriverReason(driver);
    if (reason === undefined) expect(found).toBeUndefined();
    else expect(found).toContain(reason);
  });
});

describe("installRoot", () => {
  const protectedPaths = ["/var/lib/rejects", "/var/lib/rejects/userdata"];
  it("mounts a whole npm install, a binary's own dir, or only the file next to server state", () => {
    expect(
      installRoot(
        "/var/lib/rejects/tools/codex-npm/node_modules/@openai/codex/bin/codex.js",
        protectedPaths,
      ),
    ).toBe("/var/lib/rejects/tools/codex-npm/node_modules");
    expect(installRoot("/srv/agents/opencode/bin/opencode", protectedPaths)).toBe(
      "/srv/agents/opencode/bin",
    );
    expect(installRoot("/var/lib/opencode", protectedPaths)).toBe("/var/lib/opencode");
    expect(installRoot("/opt/node/lib/node_modules/claude/bin/claude", protectedPaths)).toBe(
      undefined,
    );
  });
});

describe("providerDirs", () => {
  it("follows the CLIs' environment and falls back to their HOME defaults", () => {
    const home = "/var/lib/rejects";
    expect(
      providerDirs(
        { CLAUDE_CONFIG_DIR: "/var/lib/rejects/.claude-deepseek", XDG_DATA_HOME: "/data" },
        home,
        (...parts) => parts.join("/"),
      ).map((dir) => dir.path),
    ).toEqual([
      "/var/lib/rejects/.claude-deepseek",
      "/var/lib/rejects/.codex",
      "/var/lib/rejects/.config/opencode",
      "/data/opencode",
    ]);
  });

  it("mounts OpenCode's configured data roots", () => {
    expect(
      providerDirs({ OPENCODE_DATA_DIR: "/data/one, /data/two" }, "/var/lib/rejects", (...parts) =>
        parts.join("/"),
      ).map((dir) => [dir.path, dir.share]),
    ).toEqual([
      ["/var/lib/rejects/.claude", "config"],
      ["/var/lib/rejects/.codex", "config"],
      ["/var/lib/rejects/.config/opencode", "config"],
      ["/data/one", []],
      ["/data/two", []],
    ]);
  });
});

describe("bot-sandbox-net.sh", () => {
  const script = new URL("../../../../scripts/bot-sandbox-net.sh", import.meta.url).pathname;
  const run = (allow: string, env: NodeJS.ProcessEnv = {}) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bot-sandbox-net-"));
    const file = NodePath.join(dir, "bot-sandbox-net.allow");
    NodeFS.writeFileSync(file, allow);
    try {
      return NodeChildProcess.execFileSync(
        "sh",
        [script, "--print", "--bots", file, "rejects.service", "rejects", "127.0.0.1:3774"],
        {
          encoding: "utf8",
          env: { ...process.env, BOT_SANDBOX_NET_CGROUP: "/system.slice/rejects.service", ...env },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true });
    }
  };

  it("adds each bot's own entries for its own cgroup only, and records what it loaded", () => {
    const allow = networkAllowFile(
      [
        {
          threadId: "homelab:1",
          localNetwork: [
            "192.168.1.27:22",
            "10.0.0.5/24:443",
            "x",
            "0.0.0.0/0:22",
            "10.0.0.0/8:443",
            "192.168.0.0/23:22",
            "127.0.0.1:22",
            "169.254.169.254:80",
            "224.0.0.251:5353",
            "8.8.8.8:53",
            "192.0.2.1:80",
            "100.64.0.0/10:22",
          ],
        },
        { threadId: "news" },
      ],
      (id) => id.replace(":", "-"),
    );
    expect(allow).toBe("homelab-1 192.168.1.27:22\nhomelab-1 10.0.0.0/24:443\n");
    const [rules = "", loaded = ""] = run(allow).split("--- loaded\n");
    const own = rules.split("\n").filter((line) => line.includes("socket cgroupv2 level 4"));
    expect(own.map((line) => line.trim())).toEqual([
      'socket cgroupv2 level 4 "system.slice/rejects.service/sandbox/homelab-1" ip daddr 192.168.1.27 tcp dport 22 accept',
      'socket cgroupv2 level 4 "system.slice/rejects.service/sandbox/homelab-1" ip daddr 10.0.0.0/24 tcp dport 443 accept',
    ]);
    expect(rules.indexOf(own[1]!)).toBeLessThan(rules.indexOf("fib daddr type local reject"));
    expect(rules).not.toContain("ct state");
    expect(loadedGrants(loaded, "homelab-1")).toEqual({
      shared: ["127.0.0.1:3774"],
      own: ["192.168.1.27:22", "10.0.0.0/24:443"],
    });
    expect(loadedGrants(loaded, "news")).toEqual({ shared: ["127.0.0.1:3774"], own: [] });
  });

  it("skips lines that are not a bot and an IPv4 entry, so the file cannot inject rules", () => {
    const output = run(
      'a 1.2.3.4:22; flush ruleset\nb 300.1.1.1:22\nc 10.0.0.1:0\n../x 10.0.0.1:22\nd "10.0.0.1":22\n' +
        "e 0.0.0.0/0:22\nf 10.0.0.0/8:443\ng 127.0.0.1:22\nh 169.254.169.254:80\ni 224.0.0.251:5353\n" +
        "j 010.0.0.1:22\nk 10.0.0.0/024:22\nl 10.0.0.5/24:22\nm 10.0.0.1/32:22\nn 10.0.0.1:022\n" +
        "o 10.0.0.1:65536\np 192.0.2.1:80\nq 8.8.8.8:53\nr 198.18.0.1:80\n",
    );
    expect(output).not.toContain("level 4");
    expect(output).not.toContain("flush");
    expect(output.split("--- loaded\n")[1]).toBe("* 127.0.0.1:3774\n");
  });

  it("gives no internet path on a host whose own egress is deny-by-default", () => {
    const allow = "homelab-1 192.168.1.27:22\n";
    const [open = ""] = run(allow).split("--- loaded\n");
    const [rules = ""] = run(allow, { BOT_SANDBOX_NET_OFFLINE: "1" }).split("--- loaded\n");
    const chain = (text: string) =>
      text
        .slice(text.indexOf("chain sandbox {"))
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && line !== "}");
    // Public addresses fall through to accept unless the chain ends in a refusal.
    expect(chain(open).at(-1)).not.toBe("reject with icmpx admin-prohibited");
    const offline = chain(rules);
    expect(offline.at(-1)).toBe("reject with icmpx admin-prohibited");
    expect(offline.filter((line) => line.endsWith(" accept"))).toEqual([
      "ip daddr 127.0.0.1 tcp dport 3774 accept",
      'socket cgroupv2 level 4 "system.slice/rejects.service/sandbox/homelab-1" ip daddr 192.168.1.27 tcp dport 22 accept',
    ]);
  });
});

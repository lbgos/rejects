# Bot sandbox

Every bot run on an instance goes through bubblewrap (`bwrap`): the bot's provider CLI and every command it starts, its computer shell, and its browser. A bot sees the system read-only, its own workspace and home read-write, and its provider's shared config read-only, without credentials. The server's state, the vault, other bots' workspaces and transcripts are not mounted, so they do not exist inside the sandbox. All bots still run as the server's user; the mounts and PID namespaces separate them.

## Switch

No sandbox means no shell. A bot outside a sandbox runs on the host with its provider's own tools off: it keeps only T3's MCP tools, and only Claude and OpenCode can run it. That holds with the switch off, and on a machine without the sandbox: not Linux, no `bwrap`, or a restricted network whose rule was never loaded (no `<server's cgroup>/sandbox`). `doctor` shows which.

`<stateDir>/bot-sandbox.json` turns it off:

```json
{ "enabled": false }
```

A missing file means on, with the network restricted (see [Network](#network)). `"network": "open"` keeps the sandbox but leaves the host's network as it is. An instance created before the sandbox keeps its behavior only with this file. A file that does not parse keeps the sandbox on. The file is read whenever a bot's provider CLI, shell or browser starts. A bot's provider session that started in the other mode restarts at the bot's next turn.

Provider sessions live in the bot's own provider home inside the sandbox and in the shared one outside it. Turning the sandbox on, a bot's next turn starts a fresh provider session and gets the thread's context handed over. Turning it off, a Claude bot whose session started in the sandbox fails with `No conversation found` until its transcripts are copied back: `cp -a <stateDir>/sandbox/<bot>/home/<config dir>/projects/. <config dir>/projects/`, with `<config dir>` the CLI's `CLAUDE_CONFIG_DIR` or `~/.claude`.

With the sandbox on and set up, but `bwrap` unable to create a sandbox (see [Setup](#setup)) or the network rule letting a sandbox reach the host, no bot runs. Each run fails with the reason, and other threads are unaffected.

## What a bot sees

| Path                                | In the sandbox                                      |
| ----------------------------------- | --------------------------------------------------- |
| `/usr`, `/etc`, `/opt`, `/bin`, ... | read-only                                           |
| `/tmp`, `/proc`, `/dev`             | private to the run                                  |
| server `HOME`                       | `<stateDir>/sandbox/<bot>/home`, the bot's own      |
| `<stateDir>/bots`, the bot's cwd    | `<stateDir>/bots/<bot>`, the bot's own workspace    |
| `<stateDir>/attachments`            | the files attached in this thread, read-only        |
| provider homes                      | per bot, with config dirs shared read-only          |
| a CLI outside the system dirs       | its `node_modules` tree or its directory, read-only |
| everything else                     | absent                                              |

Shared read-only from a provider home: the `skills`, `agents`, `commands`, `plugins`, `prompts`, `rules`, `hooks` and `output-styles` dirs, `CLAUDE.md` and `AGENTS.md`. Settings, credential and key files, backups, sessions, transcripts, history, SQLite state and caches are not; the sessions and the rest are per bot. An entry that is a symlink, or resolves outside its provider home, is not shared. The sandbox passes only a fixed set of provider-instance variables (base URLs and OpenCode config paths); credential variables do not reach a sandboxed bot.

## Model route

No provider key enters a sandbox. A Claude Code home's `settings.json` reaches the sandbox as a copy the server writes at each launch, read-only: without any field whose name holds `key`, `token`, `auth`, `secret`, `password`, `credential` or `header` (`*_TOKENS` counts stay), and with `ANTHROPIC_BASE_URL` set to the server's model route, `http://127.0.0.1:<port>/api/bots/model`, and `ANTHROPIC_AUTH_TOKEN` set to a token for that bot and home.

The route answers loopback only. It checks the token in constant time, forwards `/v1/...` requests to the home's real `ANTHROPIC_BASE_URL` with the home's real credential (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_CUSTOM_HEADERS`, from its `settings.json` over the instance's environment), and streams the answer back. The token works nowhere else. Tokens last until the server restarts, which also ends every sandboxed session; a new key applies from the bot's next launch.

Without an API credential, such as a Claude home signed in by OAuth (`.credentials.json`), a sandboxed bot has none either. Codex and OpenCode keep their keys in `config.toml` and `auth.json`, which are not shared, and have no model route, so a sandboxed bot on Codex or OpenCode does not run; its turn says why. Run bots on a Claude provider instance with an API key, or turn the sandbox off.

Each bot gets its own managed OpenCode server, started in its sandbox with a random password, so one bot cannot drive another's.

## Network

Sandboxes share the host's network namespace, because the browser and bots' tools need the internet. Every sandboxed process first moves into its bot's cgroup `<server's cgroup>/sandbox/<bot>`, which bwrap makes the root of the bot's cgroup namespace, so a bot cannot move itself into another bot's cgroup. The nftables table `inet bot_sandbox_net` filters that cgroup's traffic. It reaches the `host:port` pairs the server's unit lists, the resolvers in `/etc/resolv.conf` on port 53, and public addresses. Every other loopback, private, link-local, CGNAT and multicast address, and every address of the host, is refused as administratively prohibited (`No route to host`). Every packet is matched, with no shortcut for established connections, so a removed entry also ends connections already open. List the server's own port, since bots reach its MCP endpoint at `127.0.0.1:<port>`, and any LAN endpoint a provider needs, such as a CLIProxy.

On a host whose own egress is deny-by-default (an nftables output hook with policy drop in another table, such as a firewall that pins egress to a model endpoint), sandboxes get no internet path: only the unit's `host:port` pairs and their own Local network access, with no public address and no resolver. Whatever the host's filter admits is for the server, which reaches the model for them through the model route. The script logs `restricted, no internet` then.

`scripts/bot-sandbox-net.sh` creates the cgroup and loads the table. It runs as root before the server, from a drop-in:

```ini
[Service]
Delegate=yes
ProtectControlGroups=no
ExecStartPre=+/usr/local/sbin/bot-sandbox-net --bots /var/lib/rejects/userdata/bot-sandbox-net.allow rejects.service rejects 127.0.0.1:3774 <llm-proxy-host>:8317
ExecReload=+/usr/local/sbin/bot-sandbox-net --bots /var/lib/rejects/userdata/bot-sandbox-net.allow rejects.service rejects 127.0.0.1:3774 <llm-proxy-host>:8317
```

`Delegate=yes` lets the server's user move processes into the cgroup; `ProtectControlGroups=yes` would keep `/sys/fs/cgroup` read-only for it. nft resolves the cgroup when the table loads, and systemd makes a new cgroup on each start, so the table is reloaded there, in one transaction. This works in an unprivileged LXC container with nesting.

### Local network access per bot

The owner grants one bot more local destinations in Edit bot → Local network access: IPv4 `host:port` or `CIDR:port` (TCP), one per line, /24 or narrower, in a private range (`10/8`, `100.64/10`, `172.16/12`, `192.168/16`). The route refuses anything else, and the script loads only the canonical form the server writes. The route needs the settings scope, which only the owner's sessions hold; bot edits, MCP tools and the bridge never change the list. It is stored as the bot's `localNetwork` in `bots.json`.

The server writes every bot's entries to `<stateDir>/bot-sandbox-net.allow`. With `--bots`, the script makes each listed bot's cgroup `<sandbox>/<bot>` and accepts its entries from that cgroup only, then writes what it loaded to `/run/bot-sandbox-net/<unit>.loaded`. An entry not loaded yet is refused like any other address. Malformed lines are skipped, and if nft refuses the per-bot rules, the table loads without them. A path unit reloads the rule when the file changes:

```ini
# /etc/systemd/system/rejects-sandbox-net.path
[Path]
PathChanged=/var/lib/rejects/userdata/bot-sandbox-net.allow
[Install]
WantedBy=multi-user.target

# /etc/systemd/system/rejects-sandbox-net.service
[Service]
Type=oneshot
ExecStart=/bin/systemctl reload rejects.service
```

Inside a restricted sandbox, `BOT_LOCAL_NETWORK` holds what that bot may reach locally, as loaded: the unit's list and its own entries, space separated. A script can tell a probe the sandbox refuses from a host that is down.

### SSH key per bot

A bot that needs SSH gets `<stateDir>/bot-ssh/<bot>/`, mounted read-only at `HOME/.ssh` in its provider and shell sandboxes: `id_ed25519` (0600, the server's user) and `known_hosts`. The owner creates it as root; no tool writes it. Restrict the key on the target with `restrict,from=…,command=…` in `authorized_keys`, and add the target's `host:22` to the bot's Local network access. Run `ssh -F /dev/null` with explicit `-i` and `-o UserKnownHostsFile=`: in the sandbox's user namespace, root-owned files in `/etc/ssh/ssh_config.d` look unowned, and ssh refuses them.

The server checks the rule before every launch: a process in the cgroup must fail to reach a port the server opens on `127.0.0.1`. Without the cgroup, or with that port reachable, no bot runs, and each run fails with the reason. Other threads are unaffected.

## Computer

With the sandbox on, each bot's computer runs on this instance, and the SSH settings in `bot-computer.json` are ignored. `{ "enabled": true }` turns it on; `chromium` names another browser binary.

- Shell commands run in the bot's sandbox, in its workspace. `share_file` and the files the main bot hands over go through the same sandbox, so a link the bot planted cannot reach outside it. Files the user attached in this thread are at the paths the prompt names, read-only; other threads' files are absent.
- The browser is a headless Chromium per bot, in its own sandbox, with its profile in `<stateDir>/sandbox/<bot>/browser`. The server drives it over a CDP pipe, so no port exists. The profile is mounted only into that browser's sandbox; the bot's own shell cannot read its cookies. A browser idle for 10 minutes is closed; its profile stays.
- Desktop actions and the user's takeover act on that page through the same pipe. There is no X display, so GUI apps a shell starts have nowhere to draw.

Account logins (kept sign-ins and `request_login` sessions) stay in the vault and its account browsers and are never mounted into a bot; see [vault.md](vault.md).

## Video downloader

`video_transcript` runs yt-dlp and ffmpeg in a sandbox of their own, whatever `enabled` says: the system read-only, the call's work directory at `/work`, the binaries under `/tools`, nothing else of the server's. While the sandbox is on with the network restricted, they join the cgroup `<sandbox>/video-media`, so the network rule keeps them on public addresses as it keeps the bots. Without a working `bwrap`, or with that rule missing, the tool fails with the reason. yt-dlp gets only the extractors of the allowed sites (`apps/server/src/video/sites.ts`), never its generic one, which would fetch any URL.

## Setup

Debian: `apt install bubblewrap chromium`. `bwrap --unshare-all --ro-bind / / true` must exit 0 as the server's user and under the server's unit:

- In an LXC container, unprivileged user namespaces must work.
- `RestrictSUIDSGID=yes` in the systemd unit makes bwrap fail with `Can't open source /: Function not implemented`: its seccomp filter rejects a mount syscall bwrap needs. Set `RestrictSUIDSGID=no` in a drop-in. `NoNewPrivileges=yes` and an empty `CapabilityBoundingSet=` still keep setuid binaries from gaining privileges.

Check the unit's settings without restarting it: `systemd-run -q -p User=<user> -p NoNewPrivileges=yes ... --wait --pipe -- bwrap --unshare-all --share-net --ro-bind / / true`, with the unit's hardening options as `-p` flags.

## Checks

As the server's user, through a bot turn or `computer_shell`, each of these fails: reading `<stateDir>/statev2.sqlite`, `<stateDir>/secrets/*`, the vault directory, `<stateDir>/bots/<other bot>/*`, `<stateDir>/sandbox/<other bot>/*`, any browser profile, and a real provider key (`.credentials.json`, `config.toml`, `auth.json`, the host's `settings.json`). The sandbox's `settings.json` holds only the model route and a token, which the provider refuses. `ls` in the workspace shows only the bot's own files. With the network restricted, `curl` from a bot's shell to another port on `127.0.0.1` or to a LAN address fails at once, while the listed endpoints and public sites answer.

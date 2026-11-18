# Install rejects

rejects runs coding agents and bots on one machine and serves a web app you open
from a browser on that machine or another device. Install it on the machine
where the agents will work.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
start rejects and configure providers afterwards. Bots on Linux also need
`bubblewrap` for their sandbox.

## From source

You need [Vite+](https://viteplus.dev/guide/) (`vp`), which provides the Node
version the repository pins.

```bash
git clone https://github.com/lbgos/rejects.git
cd rejects
vp i
vp run --filter t3 build
node apps/server/dist/bin.mjs
```

The server listens on `127.0.0.1:3773` and opens the web app. Update a source
install with `git pull`, `vp i` and a rebuild.

## From npm

Once a release is published on
[GitHub Releases](https://github.com/lbgos/rejects/releases), you can run it
without a checkout (needs Node.js 20.11 or later):

```bash
npx @lbgos/rejects
```

or install the `rejects` command:

```bash
npm install --global @lbgos/rejects
rejects
```

The package downloads the release's server for this machine (macOS on Apple
silicon, Linux or Windows, x64 or arm64) into `~/.rejects/runtime` and starts it.
Cortex is not part of the package; it needs a source install.

## Commands

The table uses `rejects`. From a source install, run
`node apps/server/dist/bin.mjs` in its place.

| Task                                  | Command                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Start the server and open the web app | `rejects`                                                                    |
| Start the server without a browser    | `rejects serve`                                                              |
| Use it from your other devices        | `rejects up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `rejects service install` ([details](./background-service.md))               |
| Reclaim database space                | `rejects doctor` ([details](./background-service.md#reclaim-database-space)) |

Run `rejects help` or `rejects --help` for the full reference. To start in a new
working directory, use an explicit path such as `rejects ./my-project`. A bare
directory name is accepted only if it already exists.

If `rejects` or `rejects start` reports an already running server, connect to
that server. Stop it before starting a replacement, or use a different
`--base-dir` for an independent server.

## Data

Server data defaults to `~/.rejects`. Conversations and SQLite state live in
`~/.rejects/userdata`. `--base-dir` or `T3CODE_HOME` selects another directory.
Back up the data directory to keep your bots and chats.

## Phones and other browsers

The web app adapts to a phone screen. Follow [remote access](./remote-access.md)
to reach the server from another device with a pairing link. Web Push and
microphone access need HTTPS or a browser-trusted origin.

## Providers

Open **Settings → Providers** in the web app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from rejects's provider settings.                                                                                         |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If rejects cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Codex connected through ChatGPT and Antigravity can use their managed
runtimes without a `PATH` entry.

rejects warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when rejects cannot tell. Claude, Codex, and
OpenCode installs rejects cannot identify stay manual: update them through the
installer you used. rejects runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Antigravity updates with rejects. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release rejects tested. When rejects finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, rejects does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), and [Muse Code](./providers-muse.md).

### Provider check timeouts

If a provider works in its CLI but rejects reports a timeout while checking it,
allow more time in the server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 rejects serve
```

For a remote environment, set these on the machine running the rejects server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Managed policy](./managed-policy.md): configure rejects for everyone on a machine.

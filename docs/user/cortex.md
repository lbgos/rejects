# Cortex

Cortex is a local knowledge vault that bots search and cite. A bot with Cortex tools adds pages and notes with `cortex_add_source` and `cortex_record`, and finds them later with `cortex_search` and `cortex_read`, with the source and line it came from. Its embedder also makes bot memory search match meaning, not only words.

It runs beside the server on the same machine and listens on loopback only. Nothing leaves the machine: the embedding model runs on the CPU, and no model API or key is used.

## What it needs

- A checkout of this repository with its dependencies installed (`vp i`). The `npx` package does not include Cortex.
- Node 24.13.1 or newer in the Node 24 line, which `vp` provides.
- About 1 GB of free memory and 200 MB of disk for the model.
- Internet on first start, to download the `Xenova/multilingual-e5-small` model from Hugging Face. Later starts use the cached copy.

## Set it up

1. Make the access tokens. This writes `cortex-mcp.json` into the server's data directory and `cortex.env` for Cortex:

   ```sh
   CORTEX_VAULT=~/Cortex CORTEX_MODEL_CACHE=~/.cache/cortex/models \
     node apps/cortex/deploy/configure.mjs ~/.rejects/userdata ~/.config/cortex
   ```

   Use the server's own data directory if it is not `~/.rejects/userdata`, such as `/var/lib/rejects/userdata` for a server install. Without the two variables the vault goes to `/var/lib/cortex`.

2. Start Cortex:

   ```sh
   set -a; . ~/.config/cortex/cortex.env; set +a
   pnpm --filter @lbgos/cortex start
   ```

   The first start downloads the model, then prints `Cortex MCP http://127.0.0.1:3981/mcp`. On a Linux server, `apps/cortex/deploy/cortex.service` runs it as a systemd unit; adjust its paths to your checkout and data directory.

3. Optional, for bot memory: once Cortex has started, start the embedder, which reuses its model and which the server finds at `http://127.0.0.1:3982`:

   ```sh
   pnpm --filter @lbgos/cortex embed
   ```

   `apps/cortex/deploy/rejects-embed.service` runs it as a unit. Set `T3CODE_MEMORY_EMBED_URL` on the server to use another address, or `off` to stop looking for it.

4. Check it: `doctor` shows `ok` on the Cortex and Embedder lines. The server reads `cortex-mcp.json` at each call, so no restart is needed.

Bots made from the built-in templates already have Cortex tools. Without Cortex running, those tools tell the bot it is unavailable and nothing else changes.

## Good to know

- `~/Cortex/sources` and `events.jsonl` hold everything. Back them up. `index.sqlite` is rebuilt from them with `pnpm --filter @lbgos/cortex rebuild` while Cortex is stopped.
- Other MCP clients, such as Claude Code or Codex, can use the same endpoint with the read token from `cortex.env`. See [apps/cortex/README.md](../../apps/cortex/README.md).

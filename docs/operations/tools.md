# Shared tools host

One container (`tools`, `<tools-host>`) serves every rejects instance: anonymous web browsing, memory embeddings and the account browsers of each instance's vault. It keeps nothing between calls. Sessions, secrets and grants stay in each instance's [vault](vault.md).

| Service                                                                   | Port             | Per instance                                                               | Keeps                                                                                                          |
| ------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `camofox@<inst>` (camofox-browser, anonymous `web_search` / `web_browse`) | one per instance | own process, user `cf-<inst>`, own bearer key in `/etc/camofox/<inst>.env` | RAM only: profiles, cookies and traces under `/run/camofox-<inst>` (tmpfs), sessions end after 10 minutes idle |
| `rejects-embed` (multilingual-e5-small, `EMBED_HOST=<tools-host>`)        | 3982             | shared, stateless                                                          | nothing; callers by address                                                                                    |
| Account browsers (`tools-session-browser`, Chrome headless-shell)         | SSH 22           | user `sess-<inst>`, own vault key, own proxy ports                         | profile in `/run/tools-sessions/<inst>/<site>` while a lease runs                                              |

## Account browser lease

The vault runs with `--sessions-host <tools-host> --sessions-user sess-<inst> --session-store /var/lib/rejects-vault/profiles`. It keeps each account's browser profile as a tar in the store (0600, vault user, root can read it).

1. `put <site>`: the vault sends the stored profile; the host extracts it into tmpfs.
2. `open <site> <port>`: Chrome starts on that profile behind the vault's egress proxy (forwarded with `-R`), as in [vault.md](vault.md#egress).
3. The lease ends when the browser has been idle 3 minutes, the sheet is closed and idle, or the vault stops it. The vault closes the browser through CDP, waits for it to exit, then `get <site>` streams the profile back and the host deletes its copy. The vault keeps the previous copy as `<site>.tar.prev`.
4. Sign-out and revoke delete the stored profile in the vault and `wipe` any leftover on the host.

A lease that ends without `get` (vault down, host rebooted) leaves its profile on tmpfs until the next `put`/`wipe` of that site or until `tools-sessions-clean.timer` deletes directories older than 45 minutes. A browser is killed after 20 minutes. If a profile cannot be restored, the browser does not start, so an empty profile is never stored over a good one.

The host runs `scripts/tools-host.sh <inst>:<vault-ip>:<low>-<high>:<vault-public-key-file> ...` for every instance: user `sess-<inst>`, `authorized_keys` (`restrict`, `from=` the vault, one `permitlisten` per proxy port, forced command `tools-session-browser <inst>`), the nft table `sessions_egress` (each user reaches only its own proxy ports on loopback), the cleaner timer and a 1.6 GiB memory cap per user slice. Give each instance its own proxy port range, such as `38000-38015` and `38100-38115`.

## What the host guarantees

- No swap (`swap: 0`), volatile journal, no core dumps; profiles and temp files only on tmpfs.
- Input is dropped except SSH, each instance's Camoufox port from that instance only, and `3982` from every instance. Camoufox users cannot reach private addresses (RFC1918, CGNAT, link-local); account browsers reach only their vault's proxy.
- Each instance's browsers run as their own user with their own ports; one instance's key cannot open another's profiles or bind its proxy ports.
- Cookies are in the host's RAM while a lease runs, and root on the host can read them. The host protects instances from each other, not from its owner.

## Instance setup

- `camofox.json` in the state dir: `{ "url": "http://<tools-host>:<port>", "accessKey": "<key from /etc/camofox/<inst>.env>" }`, copied file to file. An optional `"bots": ["<bot chat thread id>"]` gives `web_search`, `web_browse` and `web_read` to those bots only; without it every bot whose tool list has them gets them.
- Optional in `camofox.json`: `trawlUrl` for the check-page solver; `firecrawlUrl` (base URL, no `/v2`) and `firecrawlKey`, which make `web_browse` and `web_read` read public pages through Firecrawl first, and a standalone bot's `web_search` search there first. Set `firecrawlSearch: true` to give regular bots that hold `web_read` Firecrawl-first `web_search`, with Camoufox as fallback. Without `firecrawlUrl`, every call goes to Camoufox.
- `T3CODE_MEMORY_EMBED_URL=http://<tools-host>:3982` in the rejects unit.
- The vault unit: the flags above, `known_hosts` with the host's ed25519 key, the vault's public key given to `tools-host.sh`.

## Checks

- From an instance: `curl` to its own Camoufox port answers (401 without the key); the other instance's port does not connect.
- On the host: `ls /run/tools-sessions/<inst>` is empty with no lease; `nft list table inet sessions_egress` shows the drop counter; `sess-<inst>` cannot read `/run/tools-sessions/<other>`.
- Reboot the host: web tools and accounts fail closed, the vault's stored profiles are intact, the next lease works.

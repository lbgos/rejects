# Account vault

`rejects vault` holds every account credential bots use: the signed-in browser profile of each account (one per site, such as `olx.ua`), the Gmail OAuth client, the instance's read-only Gmail refresh token and each bot's own Gmail accounts' refresh tokens, and the Slack user token. It runs as its own user, drives the browsers and makes the API calls itself, and answers rejects over a unix socket with page text and read results. Bots name an account or connector; nothing they can reach carries a password, cookie or token.

| Piece                    | Where                                                                         | Who can read it         |
| ------------------------ | ----------------------------------------------------------------------------- | ----------------------- |
| Vault process            | host `rejects-vault.service`, user `rejects-vault`                            | —                       |
| Secrets, accounts, audit | host `/var/lib/rejects-vault` (0700, files 0600)                              | `rejects-vault`         |
| Socket                   | host `/run/rejects-vault/vault.sock` (dir 0750, group `rejects-vault-client`) | `rejects` (only member) |
| Account browsers         | host user `rejects-sessions`, `~/profiles/<site>` (0700)                      | `rejects-sessions`      |
| SSH key to the browsers  | host `/var/lib/rejects-vault/.ssh/id_ed25519`                                 | `rejects-vault`         |

Bot processes run as `rejects-bot`, which is not in `rejects-vault-client`, so a bot shell cannot reach the socket. Root can read everything; the vault protects against bots and prompt injection, not against root.

## Accounts

A bot that needs a login signs in itself first. It asks with one `ask_secret` call of kind `login`: one private card, with one push, asks for the sign-in name and the password and names the exact host they are typed on. The server keeps them as two secrets (`<name>-username`, `<name>-password`) that share a `request` id, and wakes the bot once, when both are saved; that save also closes the bot's open sign-in sheet card for the host. A two-step code comes later in its own card, and so does any other single value typed on a site once, such as an API key, PIN or invite code (kind `code`, deleted after one typing). A code typed under a bot's grant lets that bot keep using the account before it is signed in, until Sign out or Disconnect. A name or password alone is refused unless the bot holds a saved name or password for the host, and a login ask takes over the bot's unanswered name and password cards for the host, so a re-sent login leaves one card. `request_login` is refused for a bot with `ask_secret` until it holds a saved login for the host, unless the host is sheet-first (Google, Microsoft, Apple and Slack sign-ins, `sheetFirstHost`) or the user chose the page: the login card's "Sign in on the page instead" records that choice for the bot and host (`pageChosen` in `connections.json`, cleared by Disconnect), replaces the card with a sign-in request and opens the sheet. The server forwards each value to the vault (`/login/set`) and keeps only the request's name, host and kind; the vault stores a name or password as `secrets/login.<id>.bin` and holds a code in memory for one typing. Saving a login for a site grants the bot that account. The bot types each value by reference with `web_browse`, `account` and `secretRef`. A kept password is typed once per half hour, and a second card for a name or password the bot already holds for that host is refused unless the site refused that password. The account counts as signed in once a page after the password shows neither a password field nor a code field (autocomplete `one-time-code`, a code-like name, id or placeholder, or a short numeric input). A submit that leaves the password field marks the password refused, and so does a field that refuses it as the wrong kind, since a value saved before kinds existed is kept as a password. When a password was typed and whether it was refused are kept with the login, so a vault restart keeps both. After a failed sign-in, a CAPTCHA, a passkey or a step it cannot finish, the bot calls `request_login`: the user signs in on the sign-in sheet and taps Done, which grants the bot the account and wakes it. Kept logins are listed under You → Secrets, where Remove deletes them; Sign out and Disconnect on an account delete the logins kept for its site. The bot then acts through `web_browse` with `account` set, which runs in the vault's browser for that site:

- Navigation is pinned to the site and its subdomains, for the bot's own `open` and for any link, form or script the page follows. Off-site loads are blocked and audited.
- Subresources (images, scripts, fonts, XHR) may also come from the site's asset origins, a built-in list per site (`apps/server/src/vault/assetOrigins.ts`: OLX, Google, proton.me, x.com, Slack) that a page may load from but a bot's page may never navigate to. A site missing from the list loads only itself and the origins the user allowed. Other off-list subresources fail without an audit entry; only a top-level page load or a WebSocket off the list is audited as refused.
- The browser reaches the network only through the [egress proxy](#egress). Service workers are never released: they are closed before they run, so sites that need one fall back to plain requests.
- Writes (click, type, press) run only when the bot's run was started by the user's own chat message, or the user allowed writes on schedules for that bot in Connections. Other runs read; a click on an on-site link becomes a page load.
- Every action is audited with the bot, the action, the element and the text typed. Connections shows it under the account.
- Revoke removes the grants in rejects first, then the vault deletes the profile. Sign out deletes the profile and the logins kept for the site, and keeps the grants. Neither logs the site session out on the site's servers.

Profile directories are named after the site, with `:` replaced by `_` (`example.org_8443`). A site must resolve to a public address: the egress proxy refuses names that resolve to loopback, the LAN or other non-global ranges, however the site is pinned.

## Sign-in sheet

The sheet is the account browser's page, shown on the phone. It sizes the page: the client sends its page area in CSS pixels (`/api/connections/sheet/viewport`), the page relayouts to that size, and frames are shown 1:1. The client also sends its pixel ratio, which the vault ignores: account pages, the sheet's and the bots', always run at a device scale of 1, because headful Chrome can read input coordinates divided by an emulated scale above 1 and taps then miss. When the keyboard opens or the phone turns, the area changes and the page follows. The keyboard follows the page's focus. iOS opens it only for a focus inside the tap itself, so the vault reports where the page's visible text fields are (positions only, never values) and the client focuses its typing field when a tap lands on one. Right after each tap, and whenever the page settles, the vault reads whether a text field has focus; the client closes the keyboard when it has not. Closing the sheet puts the page back to the default phone size (390x844 at 1x) for bots.

Frames come in two tiers, both at 1x (CSS-pixel sized), so they look soft on a high-density phone. While the page changes, the screencast's frames serve: small and quick. Once the page rests for 140 ms, one screenshot at JPEG quality 80 replaces them. A picture identical to the last screencast frame is not sent again, and a page nobody is touching that changes alone (a blinking caret) waits for its sharp frame instead of flipping the sheet to a blurry one, so an idle focused field sends nothing. Every frame carries the size, in CSS pixels, of the page it shows, read from the picture itself; the client draws it with that size and maps touches through the rect it was drawn in, so a frame from before a resize is never stretched into the new area and a tap lands where it was drawn. Typed text goes to the page as keystrokes, in order, one request at a time, and is logged nowhere.

A window the page opens while the sheet is open (an OAuth popup, `window.open`) gets the page's setup and takes over the sheet: the screencast, the size and the input follow it, and its frames carry `popup: true`, which turns the toolbar's Forward into a Close window button. When the window closes itself or is closed, the sheet returns to the page below. A page keeps two such windows; a third replaces the oldest. Closing the sheet closes every window but the site's own page. A popup that moves to another site (an OAuth popup does once its first request answers) gets a new renderer that is hidden and without the phone setup, and until it is shown and set up again it paints but takes no touch or click: the vault re-applies the size, touch setup and front position on each of its top-level navigations, and taps in a popup go in as a mouse click. `frame.popup` says the popup is what the sheet shows. A popup is not queued behind the input that opened it: the opener's script waits for the new window to be released, so a queued popup would wait for its own tap. Windows share the browser's egress proxy, so they follow the same pin and filter.

The browser presents itself as the same Chrome on a Pixel 8 for every site: reduced user agent, client hints with a Google Chrome brand and no headless one, an Android platform, `window.chrome`, English `Accept-Language`, 8 cores and 8 GB. `apps/server/src/vault/browser.test.ts` checks that no response header or script-visible value says headless.

## Egress

CDP's Fetch domain never sees WebRTC (STUN, TURN), DNS prefetch, preconnect, WebSocket handshakes or WebTransport, so a page could send a typed secret out through them. The account browser therefore runs with every flag in `egressFlags` (`apps/server/src/vault/egress.ts`):

- `--proxy-server` points at a proxy inside the vault process, one per browser, on a free loopback port of `--egress-ports` (default `38000-38099`). The browser runs on the vault's own machine (`--sessions-host 127.0.0.1`), so it reaches that port directly. A sessions host on another machine gets the port forwarded over the SSH session (`-R`) to the same port on its loopback.
- The proxy follows the browser's pin. It serves CONNECT and plain HTTP only to the site, its allowed origins and its asset origins; while the user has the sheet open it serves any public host. It resolves names itself and serves global unicast addresses only, for every host, the site and the sheet included: loopback, private, link-local, CGNAT, benchmarking (`198.18.0.0/15`), documentation and `192.88.99.0/24` ranges are refused, and IPv6 forms that carry an IPv4 address (such as `::ffff:7f00:1`) count as that address. A change of pin, the sheet opening and the sheet closing each end every tunnel and request opened under the old pin. Closing the sheet returns the browser to the last bot action's pin, or to a pin that reaches nothing when there was none, and blanks a page that pin does not cover. The browser stays open, so a sign-in keeps its session cookies.
- `--proxy-bypass-list=<-loopback>` sends loopback traffic through the proxy too. `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"` means Chromium resolves nothing itself, so no DNS query leaves it.
- `--webrtc-ip-handling-policy=disable_non_proxied_udp` keeps WebRTC off UDP. Chromium 156 reads this spelling; the `--force-` spelling is accepted by older builds and ignored by 156, where it left STUN and TURN-over-UDP open. `--disable-quic`, `--dns-prefetch-disable`, `--disable-background-networking`, `--disable-component-update` and `--no-pings` close the rest.

Live tests in `apps/server/src/vault/browser.test.ts` count what a fixture host receives (HTTP requests, TCP connections, UDP datagrams) from STUN/TURN carrying a secret, `<link rel=dns-prefetch|preconnect>`, a WebSocket, WebTransport, a blob worker and an out-of-process frame: zero. Without the flags the same page reaches it over UDP, TCP and the socket.

A firewall table keeps the browser's uid off the network below Chromium, whatever its flags do: it may open connections to `127.0.0.1` on the proxy ports and nothing else. The SSH session's own traffic belongs to a connection the vault opened, so it is already established. `scripts/vault-sessions-host.sh` loads it:

```nft
table inet sessions_egress {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid <rejects-sessions uid> ct state established,related accept
    meta skuid <rejects-sessions uid> oifname "lo" ip daddr 127.0.0.1 tcp dport 38000-38099 accept
    meta skuid <rejects-sessions uid> counter drop
  }
}
```

A typed secret is checked and inserted in one call in the page: the focused element must be an input in the top document of the field kind the secret was saved for (a password only into a password field, a sign-in name into a text, email or phone field, a code into a text, number, phone or code field), and the document must be on the exact host shown on the card (or its `www.`), over https, or plain http on loopback. A field inside a frame is never reached: refs resolve in the top document only. The vault types nothing while the sign-in sheet has the browser open to any host, so a secret is only typed under the account's pin. This is done using the page's natives as they were before its scripts ran. Whatever the vault returns to the bot, the audit log and errors included, has every typed secret removed by value before any length limit applies: as typed, percent-encoded, form-encoded, base64 and base64url, ignoring case and whitespace. The text is also normalized and matched again: NFKC folded, invisible characters (zero-width, joiners, bidi marks, soft hyphen, selectors) dropped, and JSON and JavaScript `\uXXXX` escapes, HTML entities and percent-encoding decoded, nested up to four layers. When that pass finds a secret, the normalized text is returned with it removed, which over-redacts.

Residual: the scrub is best-effort against a page that already holds the secret. A hostile pinned site can encode it in ways no list covers (reversed, rot13, split across elements, drawn on a canvas). The defense is the trust boundary, not the scrub: a secret is typed only on the host the user saw on the card, under the account's pin, and a password only into a password field there.

Residual: service workers stay closed, so sites that need one fall back to plain requests.

## API connectors

The vault serves the Gmail and Slack ops in `READ_OPS` (`apps/server/src/vault/Vault.ts`) and refuses everything else, whoever asks. Slack tokens with any write scope are refused when pasted.

A bot granted Gmail or Slack runs with `builtinTools: "none"` (only T3's MCP tools), loses web, shell, thread and Cortex-write tools, and only runs on Claude or OpenCode. A bot with a bridge grant cannot also be granted one. Account grants do not change a bot's tools.

## Bots' own OAuth accounts

A bot granted Gmail also connects its own accounts, several per bot, with `gmail.modify` and `gmail.compose` through the same Google client and redirect URI. Services, endpoints and scopes are the registry in `apps/server/src/vault/services.ts`; account ops are `ACCOUNT_OPS` in `Vault.ts`.

- `connect_account` returns a link on the redirect URI's origin. The 256-bit handle in it is separate from the OAuth `state`, lives in the vault's memory for 10 minutes and is bound to the bot. `GET` only names the bot, so link previews do not use it; `POST` opens it once and redirects to Google. The callback completes only a flow whose link was opened, and only once.
- Tokens are `secrets/oauth.<id>.bin`, records `oauth-accounts.json`. rejects names an account by id and bot; the vault refuses an account that belongs to another bot.
- `send` runs only from the user's Send on the card in the bot's chat, and only while the draft still has the message id the card showed. No bot tool reaches it.
- Disconnect revokes the grant at Google unless another bot holds the same address (one client and Google user share one grant), then deletes the token.
- The link and callback path need the same route as `/api/connections/callback`: reachable from the owner's browser, behind the same proxy login.

## Host setup

```sh
groupadd --system rejects-vault-client
useradd --system --user-group --home-dir /var/lib/rejects-vault --no-create-home --shell /usr/sbin/nologin rejects-vault
usermod -aG rejects-vault-client rejects   # takes effect when rejects restarts
install -d -m 0700 -o rejects-vault -g rejects-vault /var/lib/rejects-vault /var/lib/rejects-vault/.ssh
runuser -u rejects-vault -- ssh-keygen -q -t ed25519 -N '' -C rejects-vault@rejects-host -f /var/lib/rejects-vault/.ssh/id_ed25519
ssh-keyscan -t ed25519 127.0.0.1 > /var/lib/rejects-vault/.ssh/known_hosts && chown rejects-vault:rejects-vault /var/lib/rejects-vault/.ssh/known_hosts
echo '{"redirectUri":"https://<host>.<tailnet>.ts.net:8443/api/connections/callback"}' > /var/lib/rejects-vault/config.json
chown rejects-vault:rejects-vault /var/lib/rejects-vault/config.json && chmod 0600 /var/lib/rejects-vault/config.json
```

`/etc/systemd/system/rejects-vault.service`:

```ini
[Unit]
Description=rejects account vault (holds account credentials, serves reads to rejects)
After=network-online.target
Wants=network-online.target
Before=rejects.service

[Service]
User=rejects-vault
Group=rejects-vault-client
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
StateDirectory=rejects-vault
StateDirectoryMode=0700
RuntimeDirectory=rejects-vault
RuntimeDirectoryMode=0750
WorkingDirectory=/var/lib/rejects-vault
ExecStart=/opt/node/bin/node /opt/rejects/apps/server/dist/bin.mjs vault --state-dir /var/lib/rejects-vault --socket /run/rejects-vault/vault.sock --sessions-host 127.0.0.1 --sessions-user rejects-sessions --egress-ports 38000-38099
Restart=on-failure
RestartSec=5
MemoryMax=512M
UMask=0007
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictSUIDSGID=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
InaccessiblePaths=-/var/lib/rejects -/var/lib/rejects-bot

[Install]
WantedBy=multi-user.target
```

The vault runs the deployed `/opt/rejects` code. After a deploy that changes `apps/server/src/vault`, restart it: `systemctl restart rejects-vault`.

Account browsers run as `rejects-sessions` on the host. `scripts/vault-sessions-host.sh` sets up their host side. It is safe to run again, and it needs the vault's public key (a port range other than 38000-38099 is the optional second argument, and goes in `--egress-ports` too) and the browser, in `SESSIONS_BROWSER`. Without it the script uses the first of `chromium`, `chromium-browser`, `google-chrome` and the newest `/opt/chrome-headless-shell/*/chrome-headless-shell`, and says which; set it explicitly when the headless shell is the browser. In this order it:

1. loads and persists `sessions_egress` (`/etc/nftables.d/sessions_egress.nft`, included from `/etc/nftables.conf`) and enables `nftables.service` so the table loads at boot; it does not start the service, which would flush rules other units load themselves;
2. installs `/usr/local/bin/rejects-session-browser`;
3. writes the user's `authorized_keys`.

A failure in step 1 stops the script before the command or the key change, so a key never works without the firewall. The first run keeps the command and `authorized_keys` it replaces as `*.prev`. Check its exit status.

### Shared tools host

Instead of a sessions host on the vault's own machine, the browsers can run on the shared [tools host](tools.md): add `--session-store <dir>` to the vault, point `--sessions-host` and `--sessions-user` at it, and the profile lives there only while its browser runs. The sections above describe a local sessions host; the forced command on the tools host is `tools-session-browser`.

## Bot computer browser

With the [bot sandbox](bot-sandbox.md) off, the shared browser behind `computer_browser` and the bot desktops runs on the bot computer as `bot-browser`. Bot shells (`computer_shell`, and a bot's own `ssh`) log in as `bots`, so they reach neither the profiles nor CDP, which reads every cookie. Bots drive the browser only through rejects' tools.

| Piece                    | Where                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Profiles                 | `/var/lib/bot-browser/{rejects-browser-profile,browser-profile}` (home and profiles 0700)  |
| Units                    | `rejects-browser` (CDP 9223, display `:98`), `bots-browser` (CDP 9222), `rejects-desktops` |
| CDP ports                | loopback only; nft table `inet bot_browser` rejects every uid but `bot-browser`            |
| Tunnel key               | host `/var/lib/rejects/.ssh/id_ed25519_botbrowser` (0600 `rejects`)                        |
| Settings (host userdata) | `bot-computer.json`: `browserUser: "bot-browser"`, `browserIdentityFile: <tunnel key>`     |

On the bot computer:

```sh
useradd --system --user-group --home-dir /var/lib/bot-browser --create-home --shell /usr/sbin/nologin bot-browser
chmod 0700 /var/lib/bot-browser
install -d -m 0700 -o bot-browser -g bot-browser /var/lib/bot-browser/.ssh /var/lib/bot-browser/.cache
install -m 0644 -o root -g root desktop.py /usr/local/lib/rejects-computer/desktop.py
# authorized_keys (0600, owned by bot-browser), one line:
# restrict,port-forwarding,permitopen="127.0.0.1:9223",from="<rejects-host-ip>",command="/usr/sbin/nologin" ssh-ed25519 AAAA... rejects-browser-tunnel@rejects-host
```

The three units run with `User=bot-browser`, `Group=bot-browser` and `WorkingDirectory=/var/lib/bot-browser`, with `--user-data-dir` under it. `rejects-browser` also sets `PrivateTmp=yes` and starts `Xvfb :98 ... -nolisten tcp -nolisten local`, so the real browser window has no socket a bot shell can reach. `rejects-desktops` keeps the shared `/tmp`: bot shells draw on their own desktops through `DISPLAY`. In `/etc/nftables.conf`, the `bots_egress` LAN block covers both uids (`meta skuid != { 1000, <bot-browser uid> } accept`), and:

```nft
table inet bot_browser {
  chain output {
    type filter hook output priority 0; policy accept;
    oif "lo" tcp dport { 9222, 9223 } meta skuid != <bot-browser uid> counter reject with tcp reset
  }
}
```

Without `browserUser`, the tunnel logs in as `user`, which is the bot shells' account.

## Checks

- On the bot computer, `runuser -u bots -- curl -m 3 http://127.0.0.1:9223/json/version` is refused, and `runuser -u bots -- ls /var/lib/bot-browser` is denied.
- `runuser -u rejects -- ls /var/lib/rejects-vault` and `runuser -u rejects-bot -- ls /var/lib/rejects-vault` are denied.
- `runuser -u rejects-bot -- curl --unix-socket /run/rejects-vault/vault.sock -d '{}' http://vault/state` is denied.
- `runuser -u rejects-vault -- ssh -i /var/lib/rejects-vault/.ssh/id_ed25519 -o UserKnownHostsFile=/var/lib/rejects-vault/.ssh/known_hosts rejects-sessions@127.0.0.1 'open ../x 40000'` is refused, as is `'open olx.ua 80'`.
- `runuser -u rejects-sessions -- curl -m 3 https://example.com` and `curl -m 3 http://127.0.0.1:3774/` fail at connect (the `sessions_egress` rule), a listener on a proxy port (`38050`) answers, and `nft list table inet sessions_egress` shows the drop counter. Internet and an out-of-range loopback port time out, names do not resolve, and root is unaffected.
- The audit log (`/var/lib/rejects-vault/audit.jsonl`, also under each account and connector in Connections) records every action, read, refusal and change with the bot's name. Account entries include the text a bot typed; connector entries never include content.

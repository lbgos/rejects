#!/bin/sh
# Sets up the account-browser side of the vault on this machine. Safe to run again.
#
#   [SESSIONS_BROWSER=/path/to/chromium] vault-sessions-host.sh <vault-public-key-file> [<low>-<high>]
#
# Run as root on the machine whose `rejects vault --sessions-host` is 127.0.0.1 (see
# docs/operations/vault.md). The browser is SESSIONS_BROWSER, or else the first of chromium,
# chromium-browser, google-chrome and the newest /opt/chrome-headless-shell/*/chrome-headless-shell.
# It
#   - keeps the user rejects-sessions, whose home holds the browser profiles, and creates it if missing;
#   - loads the nftables table inet sessions_egress and keeps it across reboots: the user reaches only
#     127.0.0.1 ports <low>-<high>, where the vault's egress proxies listen, and nothing else;
#   - then installs /usr/local/bin/rejects-session-browser, the only command the vault's key may run,
#     and keeps the previous one and authorized_keys as *.prev for a rollback;
#   - last, writes that user's authorized_keys: the vault's key, from loopback, forced command, nothing
#     else. A failure in an earlier step leaves the old command and key in place, and a key never works
#     without the firewall.
set -eu
PATH=/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
export PATH

command -v nft >/dev/null 2>&1 || { echo "nft is not installed; the firewall comes first" >&2; exit 1; }
[ "$#" -ge 1 ] || {
  echo "usage: $0 <vault-public-key-file> [<low>-<high>]" >&2
  exit 2
}
key_file=$1
ports=${2:-38000-38099}
user=rejects-sessions
home=/var/lib/rejects-sessions

case "$ports" in
  [0-9]*-[0-9]*) ;;
  *) echo "ports must look like 38000-38099" >&2; exit 2 ;;
esac
low=${ports%-*}
high=${ports#*-}
case "$low$high" in
  *[!0-9]*) echo "ports must look like 38000-38099" >&2; exit 2 ;;
esac
{ [ "$low" -ge 1024 ] && [ "$high" -ge "$low" ] && [ "$high" -le 65535 ]; } || {
  echo "ports must be within 1024-65535, low first" >&2
  exit 2
}

key=$(sed -n '1p' "$key_file" | awk '{ print $1 " " $2 }')
case "$key" in
  "ssh-ed25519 "[A-Za-z0-9+/]*) ;;
  *) echo "$key_file does not start with an ssh-ed25519 public key" >&2; exit 2 ;;
esac

if ! id -u "$user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$home" --shell /bin/sh "$user"
  # An account with a locked password refuses key logins on some sshd setups.
  usermod -p '*' "$user"
fi
uid=$(id -u "$user")
# The browser the forced command runs, resolved now so the command holds one fixed path.
browser=${SESSIONS_BROWSER:-}
if [ -z "$browser" ]; then
  for name in chromium chromium-browser google-chrome google-chrome-stable; do
    browser=$(command -v "$name" || true)
    [ -n "$browser" ] && break
  done
fi
if [ -z "$browser" ]; then
  browser=$(ls -d /opt/chrome-headless-shell/*/chrome-headless-shell 2>/dev/null | sort -V | tail -1 || true)
fi
case "$browser" in
  "" | *[!A-Za-z0-9._/+-]*)
    echo "no usable browser found; set SESSIONS_BROWSER=/path/to/chromium" >&2
    exit 2
    ;;
esac
[ -x "$browser" ] || { echo "$browser is not executable" >&2; exit 2; }
# chrome-headless-shell is always headless and has no --headless switch.
case "$browser" in
  */chrome-headless-shell) headless="" ;;
  *) headless="--headless=new" ;;
esac
home=$(getent passwd "$user" | cut -d: -f6)
chmod 0700 "$home"
install -d -m 0700 -o "$user" -g "$user" "$home/.ssh" "$home/profiles"

# Chromium runs as this user and may use the vault's proxy ports on loopback and nothing else. The
# ssh session's own traffic belongs to an established connection the vault opened.
install -d -m 0755 /etc/nftables.d
nft_tmp=$(mktemp)
cat >"$nft_tmp" <<EOF
table inet sessions_egress
delete table inet sessions_egress
table inet sessions_egress {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid $uid ct state established,related accept
    meta skuid $uid oifname "lo" ip daddr 127.0.0.1 tcp dport $low-$high accept
    meta skuid $uid counter drop
  }
}
EOF
install -m 0644 -o root -g root "$nft_tmp" /etc/nftables.d/sessions_egress.nft
rm -f "$nft_tmp"
nft -f /etc/nftables.d/sessions_egress.nft
# Reboots reload /etc/nftables.conf only when the service is enabled. Not started here: that would
# flush rules other units load at their own start.
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable nftables.service >/dev/null 2>&1 ||
    echo "warning: could not enable nftables.service; sessions_egress will not survive a reboot" >&2
fi
if [ -f /etc/nftables.conf ] && ! grep -q '^include "/etc/nftables.d/\*.nft"' /etc/nftables.conf; then
  printf '\ninclude "/etc/nftables.d/*.nft"\n' >>/etc/nftables.conf
fi

# Opens or wipes one site's browser profile. `open` also takes the port of the vault's egress proxy,
# which is all the browser may reach. Keep the flags in step with `egressFlags` (vault/egress.ts).
command_tmp=$(mktemp)
cat >"$command_tmp" <<'COMMAND'
#!/bin/sh
# Forced command for rejects-sessions: open or wipe one site's browser profile, nothing else.
set -euf
umask 077
# -f above: the unquoted split below must not expand globs from the client's text.
set -- ${SSH_ORIGINAL_COMMAND:-}
refuse() { echo refused >&2; exit 1; }
profile="${2:-}"
case "$profile" in
  "" | .* | *..* | *[!a-z0-9._-]*) refuse ;;
esac
[ "${#profile}" -le 200 ] || refuse
case "${1:-}" in
  wipe) [ "$#" -eq 2 ] || refuse; rm -rf -- "$HOME/profiles/$profile"; exit 0 ;;
  open) [ "$#" -eq 3 ] || refuse ;;
  *) refuse ;;
esac
port="$3"
case "$port" in
  "" | *[!0-9]*) refuse ;;
esac
{ [ "$port" -ge 1024 ] && [ "$port" -le 65535 ]; } || refuse
mkdir -p "$HOME/profiles/$profile"
exec '@BROWSER@' @HEADLESS@ --remote-debugging-pipe --user-data-dir="$HOME/profiles/$profile" \
  --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-gpu \
  --disable-blink-features=AutomationControlled --window-size=390,844 --lang=en-US \
  --proxy-server="http://127.0.0.1:$port" --proxy-bypass-list='<-loopback>' \
  --host-resolver-rules='MAP * ~NOTFOUND , EXCLUDE 127.0.0.1' \
  --webrtc-ip-handling-policy=disable_non_proxied_udp \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --dns-prefetch-disable --disable-quic --disable-background-networking \
  --disable-component-update --no-pings \
  about:blank 3<&0 4>&1 >/dev/null 2>&1
COMMAND
sed -e "s#@BROWSER@#$browser#" -e "s#@HEADLESS@#$headless#" "$command_tmp" >"$command_tmp.final"
# The first run keeps what was there, so a rollback can restore the old two-argument command.
if [ -f /usr/local/bin/rejects-session-browser ] && [ ! -f /usr/local/bin/rejects-session-browser.prev ] &&
  ! cmp -s "$command_tmp.final" /usr/local/bin/rejects-session-browser; then
  cp -p /usr/local/bin/rejects-session-browser /usr/local/bin/rejects-session-browser.prev
fi
install -m 0755 -o root -g root "$command_tmp.final" /usr/local/bin/rejects-session-browser
rm -f "$command_tmp" "$command_tmp.final"

keys_tmp=$(mktemp)
printf 'restrict,from="127.0.0.1,::1",command="/usr/local/bin/rejects-session-browser" %s rejects-vault\n' \
  "$key" >"$keys_tmp"
if [ -f "$home/.ssh/authorized_keys" ] && [ ! -f "$home/.ssh/authorized_keys.prev" ] &&
  ! cmp -s "$keys_tmp" "$home/.ssh/authorized_keys"; then
  cp -p "$home/.ssh/authorized_keys" "$home/.ssh/authorized_keys.prev"
fi
install -m 0600 -o "$user" -g "$user" "$keys_tmp" "$home/.ssh/authorized_keys"
rm -f "$keys_tmp"

echo "rejects-sessions (uid $uid): $browser, forced command, authorized_keys and sessions_egress ($low-$high) in place"

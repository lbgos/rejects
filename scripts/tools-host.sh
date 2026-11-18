#!/bin/sh
# Sets up the account-browser side of the vault on the shared tools host. Safe to run again.
#
#   [SESSIONS_BROWSER=/path/to/chromium] tools-host.sh <inst>:<vault-ip>:<low>-<high>:<vault-public-key-file> ...
#
# Run as root. One argument per rejects instance. For each it
#   - keeps the user sess-<inst>, which runs that instance's browsers and holds nothing between them;
#   - writes that user's authorized_keys: the instance's vault key, from the vault's address, forced
#     command, and a forward only to the instance's own proxy ports (one permitlisten per port);
#   - gives the user the nft rule: its browsers reach 127.0.0.1 ports <low>-<high> and nothing else.
# It also installs /usr/local/bin/tools-session-browser, the only command the keys may run, a
# timer that deletes profiles left behind by a failed lease, and a 1.6 GiB memory cap per user slice.
# Profiles live under /run/tools-sessions (tmpfs). See docs/operations/tools.md.
set -eu
PATH=/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
export PATH

command -v nft >/dev/null 2>&1 || { echo "nft is not installed" >&2; exit 1; }
[ "$#" -ge 1 ] || {
  echo "usage: $0 <inst>:<vault-ip>:<low>-<high>:<vault-public-key-file> ..." >&2
  exit 2
}

browser=${SESSIONS_BROWSER:-}
if [ -z "$browser" ]; then
  browser=$(ls -d /opt/chrome-*/chrome 2>/dev/null | sort -V | tail -1 || true)
fi
if [ -z "$browser" ]; then
  browser=$(ls -d /opt/chrome-headless-shell/*/chrome-headless-shell 2>/dev/null | sort -V | tail -1 || true)
fi
case "$browser" in
  "" | *[!A-Za-z0-9._/+-]*) echo "no usable browser; set SESSIONS_BROWSER=/path/to/chrome-headless-shell" >&2; exit 2 ;;
esac
[ -x "$browser" ] || { echo "$browser is not executable" >&2; exit 2; }
# The forced command. A full Chrome runs headful on its own Xvfb (a real window, plugins, window.chrome);
# chrome-headless-shell runs headless. Keep the flags in step with `egressFlags` (vault/egress.ts).
command_tmp=$(mktemp)
cat >"$command_tmp" <<'COMMAND'
#!/bin/sh
# Forced command of a tools-host user: put, open, get or wipe one site's profile, nothing else.
set -euf
umask 077
inst="${1:-}"
case "$inst" in "" | *[!a-z0-9-]*) echo refused >&2; exit 1 ;; esac
set -- ${SSH_ORIGINAL_COMMAND:-}
refuse() { echo refused >&2; exit 1; }
cmd="${1:-}"
profile="${2:-}"
case "$profile" in
  "" | .* | *..* | *[!a-z0-9._-]*) refuse ;;
esac
[ "${#profile}" -le 200 ] || refuse
dir="/run/tools-sessions/$inst/$profile"
case "$cmd" in
  wipe) [ "$#" -eq 2 ] || refuse; rm -rf -- "$dir" "/run/tools-sessions/$inst/.tmp-$profile"; exit 0 ;;
  put)
    [ "$#" -eq 2 ] || refuse
    rm -rf -- "$dir"
    mkdir -- "$dir"
    exec tar -x --no-same-owner --no-same-permissions -C "$dir"
    ;;
  get)
    [ "$#" -eq 2 ] || refuse
    [ -d "$dir" ] || refuse
    rc=0
    # Only what a sign-in needs: caches and components Chrome downloads by itself are left out.
    tar -c -C "$dir" --exclude='*Cache*' --exclude='*cache*' --exclude='Crashpad' --exclude='Singleton*' \
      --exclude='BrowserMetrics*' --exclude='WasmTtsEngine' --exclude='OnDeviceHeadSuggestModel' \
      --exclude='CertificateRevocation' --exclude='ActorSafetyLists' --exclude='optimization_guide*' \
      --exclude='Safe Browsing*' --exclude='component_crx_cache' --exclude='extensions_crx_cache' \
      --exclude='*SafetyTips*' --exclude='Subresource Filter' --exclude='.tmp-*' . || rc=$?
    rm -rf -- "$dir" "/run/tools-sessions/$inst/.tmp-$profile"
    [ "$rc" -le 1 ] || exit "$rc"
    exit 0
    ;;
  open) [ "$#" -eq 3 ] || refuse ;;
  *) refuse ;;
esac
port="$3"
case "$port" in "" | *[!0-9]*) refuse ;; esac
{ [ "$port" -ge 1024 ] && [ "$port" -le 65535 ]; } || refuse
mkdir -p -- "$dir"
tmp="/run/tools-sessions/$inst/.tmp-$profile"
rm -rf -- "$tmp"; mkdir -- "$tmp"
export TMPDIR="$tmp"
set -- --remote-debugging-pipe "--user-data-dir=$dir" --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage --disk-cache-size=1048576 --disable-crash-reporter --password-store=basic \
  --disable-blink-features=AutomationControlled --window-size=390,844 --lang=en-US \
  "--proxy-server=http://127.0.0.1:$port" "--proxy-bypass-list=<-loopback>" \
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1" \
  --webrtc-ip-handling-policy=disable_non_proxied_udp \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --dns-prefetch-disable --disable-quic --disable-background-networking \
  --disable-component-update --no-pings
case '@BROWSER@' in
  */chrome-headless-shell)
    # A lease ends within 20 minutes whatever the vault does.
    timeout 1200 '@BROWSER@' --disable-gpu "$@" about:blank 3<&0 4>&1 >/dev/null 2>&1 || true
    ;;
  *)
    # One Xvfb per proxy port, so leases never share a display; no network listener.
    d=$((port - 30000))
    Xvfb ":$d" -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
    xpid=$!
    trap 'kill "$xpid" 2>/dev/null || true' EXIT
    n=0
    while [ ! -S "/tmp/.X11-unix/X$d" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    DISPLAY=":$d" DBUS_SESSION_BUS_ADDRESS=disabled: timeout 1200 '@BROWSER@' \
      --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader "$@" about:blank 3<&0 4>&1 >/dev/null 2>&1 || true
    ;;
esac
rm -rf -- "$tmp"
exit 0
COMMAND
sed -e "s#@BROWSER@#$browser#" "$command_tmp" >"$command_tmp.final"
install -m 0755 -o root -g root "$command_tmp.final" /usr/local/bin/tools-session-browser
rm -f "$command_tmp" "$command_tmp.final"

install -d -m 0755 /run/tools-sessions /etc/nftables.d
nft_tmp=$(mktemp)
tmpfiles_tmp=$(mktemp)
printf 'd /run/tools-sessions 0755 root root -\n' >"$tmpfiles_tmp"
printf 'table inet sessions_egress\ndelete table inet sessions_egress\ntable inet sessions_egress {\n  chain output {\n    type filter hook output priority 0; policy accept;\n' >"$nft_tmp"

for spec in "$@"; do
  inst=${spec%%:*}; rest=${spec#*:}
  ip=${rest%%:*}; rest=${rest#*:}
  ports=${rest%%:*}; key_file=${rest#*:}
  case "$inst" in "" | *[!a-z0-9-]*) echo "bad instance name $inst" >&2; exit 2 ;; esac
  case "$ip" in "" | *[!0-9.]*) echo "bad address $ip" >&2; exit 2 ;; esac
  low=${ports%-*}; high=${ports#*-}
  case "$low$high" in "" | *[!0-9]*) echo "ports must look like 38000-38015" >&2; exit 2 ;; esac
  { [ "$low" -ge 1024 ] && [ "$high" -ge "$low" ] && [ "$high" -le 65535 ] && [ $((high - low)) -lt 64 ]; } || {
    echo "ports $ports: within 1024-65535, at most 64" >&2; exit 2
  }
  key=$(sed -n '1p' "$key_file" | awk '{ print $1 " " $2 }')
  case "$key" in "ssh-ed25519 "[A-Za-z0-9+/]*) ;; *) echo "$key_file is not an ssh-ed25519 public key" >&2; exit 2 ;; esac

  user=sess-$inst
  home=/var/lib/$user
  if ! id -u "$user" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$home" --shell /bin/sh "$user"
    usermod -p '*' "$user"
  fi
  uid=$(id -u "$user")
  chmod 0700 "$home"
  install -d -m 0700 -o "$user" -g "$user" "$home/.ssh"
  listens=""
  p=$low
  while [ "$p" -le "$high" ]; do listens="$listens,permitlisten=\"127.0.0.1:$p\""; p=$((p + 1)); done
  printf 'restrict,port-forwarding,from="%s"%s,command="/usr/local/bin/tools-session-browser %s" %s rejects-vault-%s\n' \
    "$ip" "$listens" "$inst" "$key" "$inst" >"$home/.ssh/authorized_keys"
  chown "$user:$user" "$home/.ssh/authorized_keys"; chmod 0600 "$home/.ssh/authorized_keys"

  printf 'd /run/tools-sessions/%s 0700 %s %s -\n' "$inst" "$user" "$user" >>"$tmpfiles_tmp"
  printf '    meta skuid %s ct state established,related accept\n    meta skuid %s oifname "lo" ip daddr 127.0.0.1 tcp dport %s-%s accept\n    meta skuid %s counter drop\n' \
    "$uid" "$uid" "$low" "$high" "$uid" >>"$nft_tmp"
  install -d /etc/systemd/system/user-"$uid".slice.d
  printf '[Slice]\nMemoryMax=1600M\nMemorySwapMax=0\n' >/etc/systemd/system/user-"$uid".slice.d/limits.conf
done

printf '  }\n}\n' >>"$nft_tmp"
install -m 0644 -o root -g root "$nft_tmp" /etc/nftables.d/sessions_egress.nft
install -m 0644 -o root -g root "$tmpfiles_tmp" /etc/tmpfiles.d/tools-sessions.conf
rm -f "$nft_tmp" "$tmpfiles_tmp"
nft -f /etc/nftables.d/sessions_egress.nft
systemd-tmpfiles --create /etc/tmpfiles.d/tools-sessions.conf

# A lease that ended without `get` leaves its profile; nothing keeps it longer than 45 minutes.
cat >/etc/systemd/system/tools-sessions-clean.service <<'EOF'
[Unit]
Description=Delete browser profiles left by a failed lease
[Service]
Type=oneshot
ExecStart=/usr/bin/find /run/tools-sessions -mindepth 2 -maxdepth 2 -mmin +45 -exec rm -rf {} +
EOF
cat >/etc/systemd/system/tools-sessions-clean.timer <<'EOF'
[Unit]
Description=Delete browser profiles left by a failed lease
[Timer]
OnBootSec=10min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now tools-sessions-clean.timer >/dev/null 2>&1 || true
systemctl enable nftables.service >/dev/null 2>&1 || true
if [ -f /etc/nftables.conf ] && ! grep -q '^include "/etc/nftables.d/\*.nft"' /etc/nftables.conf; then
  printf '\ninclude "/etc/nftables.d/*.nft"\n' >>/etc/nftables.conf
fi
echo "tools host: $# instance(s), browser $browser"

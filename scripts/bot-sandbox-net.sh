#!/bin/sh
# Keeps sandboxed bot processes off loopback and the local network.
#
#   bot-sandbox-net.sh [--print] [--bots <file>] <unit> <user> [host:port | [v6]:port ...]
#
# Run as root from the server unit, before the server starts and on reload (see
# docs/operations/bot-sandbox.md):
#   ExecStartPre=+/usr/local/sbin/bot-sandbox-net --bots /var/lib/rejects/userdata/bot-sandbox-net.allow rejects.service rejects 127.0.0.1:3774
#
# It creates <unit cgroup>/sandbox, which the server's user may move processes into, and loads the
# nftables table inet bot_sandbox_net. A process in that cgroup reaches the listed host:port pairs,
# the resolvers in /etc/resolv.conf on port 53, and public addresses; every loopback, private,
# link-local, CGNAT and multicast address and every address of this host is refused as
# administratively prohibited, packet by packet, so a removed entry also ends open connections.
#
# --bots names the server's `<bot slug> <ipv4[/prefix]:port>` lines, the owner's Local network
# access per bot (canonical, /24 or narrower, private ranges only). Every bot runs in its
# own <sandbox>/<slug>, its cgroup namespace's root, so it cannot join another bot's; a listed bot's
# processes also reach its own entries.
# What was loaded goes to /run/bot-sandbox-net/<unit>.loaded (`*` for every sandbox), which the
# server reads. nft resolves cgroup paths when the table loads, so the table is reloaded after the
# mkdirs, in one transaction. --print writes the ruleset and that list instead, and changes
# nothing; BOT_SANDBOX_NET_CGROUP then stands in for the unit's cgroup.
#
# A host whose own egress is deny-by-default (an nftables output hook with policy drop in another
# table) keeps what that filter admits for itself: its sandboxes reach only the listed pairs and
# their own entries, with no public address and no resolver. Bots reach their model through the
# server's model route on the listed loopback port. In --print, BOT_SANDBOX_NET_OFFLINE=1 stands
# in for that check.
set -eu
# The unit's own PATH applies here and often leaves out sbin, where nft lives.
PATH=/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
export PATH

print=
bots=
while :; do
  case "${1-}" in
    --print) print=1; shift ;;
    --bots) bots=$2; shift 2 ;;
    *) break ;;
  esac
done
[ "$#" -ge 2 ] || {
  echo "usage: $0 [--print] [--bots <file>] <unit> <user> [host:port ...]" >&2
  exit 2
}
unit=$1
user=$2
shift 2

if [ -n "$print" ]; then
  group=${BOT_SANDBOX_NET_CGROUP:?}
else
  group=$(systemctl show -p ControlGroup --value "$unit")
fi
[ -n "$group" ] || {
  echo "bot-sandbox-net: $unit has no cgroup; run this from its ExecStartPre=+" >&2
  exit 1
}
offline=
if [ -n "$print" ]; then
  [ "${BOT_SANDBOX_NET_OFFLINE-}" = 1 ] && offline=1
elif nft list chains 2>/dev/null | awk '
  $1 == "table" { table = $3 }
  /hook output/ && /policy drop/ && table != "bot_sandbox_net" { found = 1 }
  END { exit !found }'; then
  offline=1
fi

sandbox="${group#/}/sandbox"
dir="/sys/fs/cgroup/$sandbox"
level=$(printf '%s\n' "$sandbox" | awk -F/ '{ print NF }')

# Gives the server's user a cgroup it can move processes into.
delegate() {
  [ -n "$print" ] && return 0
  mkdir -p "$1"
  chown "$user" "$1" "$1/cgroup.procs" "$1/cgroup.threads" "$1/cgroup.subtree_control"
}
delegate "$dir"

allow=""
loaded=""
for pair in "$@"; do
  case "$pair" in
    \[*\]:*)
      host=${pair%%]:*}
      host=${host#[}
      allow="$allow
    ip6 daddr $host tcp dport ${pair##*]:} accept"
      ;;
    *:*)
      allow="$allow
    ip daddr ${pair%:*} tcp dport ${pair##*:} accept"
      ;;
    *)
      echo "bot-sandbox-net: $pair is not host:port" >&2
      exit 2
      ;;
  esac
  loaded="$loaded* $pair
"
done
resolvers=$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)
[ -z "$offline" ] || resolvers=
last=
[ -z "$offline" ] || last="
    reject with icmpx admin-prohibited"
for resolver in $resolvers; do
  family=ip
  case "$resolver" in *:*) family=ip6 ;; esac
  allow="$allow
    $family daddr $resolver udp dport 53 accept
    $family daddr $resolver tcp dport 53 accept"
done

# Only well-formed lines reach nft; anything else in the server-written file is skipped.
own=""
own_loaded=""
if [ -n "$bots" ] && [ -r "$bots" ]; then
  valid=$(awk '
    # Only the canonical form the server writes (parseLocalNetworkEntry): no leading zeros, no /32,
    # no host bits, /24 or narrower, in a private range. Anything else is skipped, line by line.
    BEGIN {
      o = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])"
      entry = "^[A-Za-z0-9_-]+ " o "\\." o "\\." o "\\." o "(/(2[4-9]|3[01]))?:[1-9][0-9]?[0-9]?[0-9]?[0-9]?$"
    }
    $0 ~ entry && length($1) <= 128 {
      split($2, hp, ":"); split(hp[1], np, "/"); split(np[1], q, ".")
      prefix = np[2] == "" ? 32 : np[2] + 0
      address = ((q[1] * 256 + q[2]) * 256 + q[3]) * 256 + q[4]
      private = q[1] == 10 || (q[1] == 100 && q[2] >= 64 && q[2] <= 127) ||
        (q[1] == 172 && q[2] >= 16 && q[2] <= 31) || (q[1] == 192 && q[2] == 168)
      if (private && hp[2] + 0 <= 65535 && address % (2 ^ (32 - prefix)) == 0) { print; next }
    }
    NF { print "bot-sandbox-net: skipped line " NR " of the bots file" > "/dev/stderr" }
  ' "$bots")
  while read -r slug entry; do
    [ -n "$entry" ] || continue
    delegate "$dir/$slug"
    own="$own
    socket cgroupv2 level $((level + 1)) \"$sandbox/$slug\" ip daddr ${entry%:*} tcp dport ${entry##*:} accept"
    own_loaded="$own_loaded$slug $entry
"
  done <<EOF
$valid
EOF
fi

ruleset() {
  cat <<EOF
table inet bot_sandbox_net
delete table inet bot_sandbox_net
table inet bot_sandbox_net {
  chain output {
    type filter hook output priority filter - 1; policy accept;
    socket cgroupv2 level $level "$sandbox" jump sandbox
  }
  # No conntrack shortcut: every packet is matched, so a revoked grant ends open connections too.
  chain sandbox {$allow$1
    fib daddr type local reject with icmpx admin-prohibited
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } reject with icmpx admin-prohibited
    ip6 daddr { ::/127, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 } reject with icmpx admin-prohibited$last
  }
}
EOF
}

if [ -n "$print" ]; then
  ruleset "$own"
  printf '%s\n%s%s' '--- loaded' "$loaded" "$own_loaded"
  exit 0
fi
# A per-bot rule nft refuses must not leave every bot without the base rule.
if ! ruleset "$own" | nft -f -; then
  echo "bot-sandbox-net: loading the bots' Local network access failed; loaded without it" >&2
  own_loaded=""
  ruleset "" | nft -f -
fi
install -d -m 0755 /run/bot-sandbox-net
printf '%s%s' "$loaded" "$own_loaded" >"/run/bot-sandbox-net/$unit.loaded.tmp"
# The server reads it as its own user; the unit's UMask applies here too.
chmod 0644 "/run/bot-sandbox-net/$unit.loaded.tmp"
mv -f "/run/bot-sandbox-net/$unit.loaded.tmp" "/run/bot-sandbox-net/$unit.loaded"
echo "bot-sandbox-net: $dir restricted${offline:+, no internet}"

#!/bin/sh
# Leak checks for CI (.github/workflows/checks.yml, leak-gate.yml) and the pre-push hook
# (.vite-hooks/pre-push).
#
#   leak-scan.sh denylist <patterns-file> <rev> [<git log revision args>...]
#     Matches one extended regex per line (case-insensitive; '#' lines and blank lines skipped)
#     against every tracked file and path at <rev> outside .repos/ (vendored upstream sources) and,
#     with revision args (a range such as base..head), against the commit messages and
#     author/committer identities of those commits.
#   leak-scan.sh generic <base> <head>
#     Flags private-range IPv4 literals and email addresses other than the allowlist below on the
#     lines <head> adds relative to its merge base with <base>, outside .repos/ and lockfiles. A line
#     that needs such a value (a sandbox network rule, an SSRF test) carries "leak-scan: allow".
#
# Hits print as file:line, "path #n" or "commit <sha>" only. A matched value never reaches the
# output, since CI logs are public. Exit 1 on a hit, 2 on a usage or input error.
set -eu

die() {
  echo "leak-scan: $*" >&2
  exit 2
}

# Lines on stdin as "<prefix>\036<text>": prints each prefix whose text matches the ERE file $1,
# minus matches of the ERE file $2 when given (an allowlist).
match_prefixes() {
  tmp=$(mktemp -d)
  awk -F '\036' -v keys="$tmp/keys" -v texts="$tmp/texts" '{ print $1 > keys; print substr($0, length($1) + 2) > texts }'
  [ -s "$tmp/texts" ] || { rm -rf "$tmp"; return 0; }
  grep -n -o -i -E -f "$1" "$tmp/texts" > "$tmp/found" || [ $? -eq 1 ] || die "grep failed"
  if [ -n "${2-}" ]; then
    # Drop allowed matches; a line with any other match still counts.
    grep -v -i -E -f "$2" "$tmp/found" > "$tmp/kept" || [ $? -eq 1 ] || die "grep failed"
    sed -n 's/^\([0-9]*\):.*/\1/p' "$tmp/kept"
  else
    sed -n 's/^\([0-9]*\):.*/\1/p' "$tmp/found"
  fi | sort -un | awk 'NR == FNR { want[$1] = 1; next } FNR in want' - "$tmp/keys"
  rm -rf "$tmp"
}

denylist() {
  [ $# -ge 2 ] || die "usage: leak-scan.sh denylist <patterns-file> <rev> [<git log revision args>...]"
  list=$1 rev=$2
  shift 2
  [ -r "$list" ] || die "cannot read the denylist"
  git rev-parse --verify --quiet "$rev^{commit}" > /dev/null || die "unknown revision $rev"

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list" > "$work/patterns" || true
  [ -s "$work/patterns" ] || die "the denylist has no patterns"

  # -z separates path, line and text with NUL; \036 lets awk split them.
  git grep -I -n -i -E -z -f "$work/patterns" "$rev" -- . ':(exclude).repos/**' > "$work/content" 2> "$work/err" || {
    # git grep quotes a bad pattern in its error, so its stderr stays unprinted.
    [ $? -eq 1 ] || die "git grep failed; check every denylist line is a valid extended regex"
  }
  tr '\000' '\036' < "$work/content" | awk -F '\036' -v rev="$rev:" '{ p = $1; if (index(p, rev) == 1) p = substr(p, length(rev) + 1); print p ":" $2 }' > "$work/hits"

  git ls-tree -r --name-only "$rev" -- > "$work/all-paths" || die "git ls-tree failed"
  grep -v '^\.repos/' "$work/all-paths" > "$work/paths" || true
  grep -n -i -E -f "$work/patterns" "$work/paths" > "$work/path-hits" || [ $? -eq 1 ] || die "grep failed"
  sed -n 's|^\([0-9]*\):.*|path #\1 of git ls-tree -r --name-only, .repos/ excluded|p' "$work/path-hits" >> "$work/hits"

  if [ $# -gt 0 ]; then
    # One line per commit: "<sha>\036<identities and message>".
    git log -z --format='%H%x1e%an <%ae> %cn <%ce> %B' "$@" -- > "$work/log" || die "git log $* failed"
    tr '\n\000' ' \n' < "$work/log" > "$work/commits"
    match_prefixes "$work/patterns" < "$work/commits" > "$work/commit-hits"
    sed 's/^/commit /' "$work/commit-hits" >> "$work/hits"
  fi

  if [ -s "$work/hits" ]; then
    echo "Denylist hits (values withheld):"
    sort -u "$work/hits"
    return 1
  fi
  echo "Denylist: no hits."
}

generic() {
  [ $# -eq 2 ] || die "usage: leak-scan.sh generic <base> <head>"
  base=$1 head=$2
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  cat > "$work/patterns" << 'EOF'
(^|[^0-9.])10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)
(^|[^0-9.])172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)
(^|[^0-9.])192\.168\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)
(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)
[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}
EOF
  # Matched against "<n>:<match>" lines from grep -n -o.
  cat > "$work/allow" << 'EOF'
^[0-9]+:contact@lbgos\.dev$
^[0-9]+:[a-z0-9._%+-]+@users\.noreply\.github\.com$
^[0-9]+:noreply@github\.com$
^[0-9]+:git@
^[0-9]+:[^@]+@([a-z0-9-]+\.)*example\.(com|org|net)$
^[0-9]+:[^@]+@[a-z0-9.-]+\.(example|test|invalid|localhost)$
EOF

  git diff -U0 --no-color --no-renames --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "$base...$head" -- . \
    ':(exclude).repos/**' ':(exclude)**/pnpm-lock.yaml' ':(exclude)**/Cargo.lock' > "$work/diff" ||
    die "git diff $base...$head failed"
  awk '
      /^diff --git / { header = 1; next }
      header && /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); next }
      /^@@ / { header = 0; split($3, a, ","); line = substr(a[1], 2) + 0; next }
      !header && /^\+/ { if (!/leak-scan: allow/) printf "%s:%d\036%s\n", file, line, substr($0, 2); line++ }
    ' "$work/diff" > "$work/added"

  match_prefixes "$work/patterns" "$work/allow" < "$work/added" > "$work/hits"
  if [ -s "$work/hits" ]; then
    echo "Added lines with a private-range address or a non-public email (values withheld):"
    cat "$work/hits"
    return 1
  fi
  echo "Generic leak rule: no hits."
}

[ $# -ge 1 ] || die "usage: leak-scan.sh denylist|generic ..."
cmd=$1
shift
case $cmd in
  denylist) denylist "$@" ;;
  generic) generic "$@" ;;
  *) die "unknown command $cmd" ;;
esac

export interface ShellSecret {
  readonly env: string;
  readonly value: string;
  readonly file: boolean;
}

export const SHELL_SECRET_ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;

export const shellSecretsHeader = (secrets: ReadonlyArray<ShellSecret>) =>
  `${secrets.length}\n${secrets
    .map((s) => `${s.env} ${s.file ? "file" : "env"} ${Buffer.from(s.value).toString("base64")}\n`)
    .join("")}`;

/**
 * sh, with `$sec` set: reads the header from stdin into `$sec`, replacing what a crashed command
 * left. Env secrets become `<env>.env`, file secrets `<env>`. No single quotes: it is sh-quoted.
 */
export const SECRETS_UNPACK = `rm -rf "$sec"
read -r count
if [ "$count" -gt 0 ] 2>/dev/null; then
  (umask 077; mkdir -p "$sec")
  i=0
  while [ "$i" -lt "$count" ]; do
    read -r name mode value
    case "$name" in *[!A-Z0-9_]* | "") exit 3 ;; esac
    if [ "$mode" = env ]; then target="$sec/$name.env"; else target="$sec/$name"; fi
    (umask 077; printf %s "$value" | base64 -d >"$target")
    i=$((i + 1))
  done
fi`;

/** Values keep trailing newlines. No single quotes: it is sh-quoted. */
export const SECRETS_EXPORT = `d=$1 c=$2
if [ -d "$d" ]; then
  for f in "$d"/*; do
    [ -f "$f" ] || continue
    n=\${f##*/}
    case $n in
      *.env) v=$(cat "$f"; printf x); export "\${n%.env}=\${v%x}"; rm -f "$f" ;;
      *) export "$n=$f" ;;
    esac
  done
fi
unset d f n v
exec /bin/bash -c "$c"`;

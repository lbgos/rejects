import type { ComputerAction } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Challenge } from "./challenge.ts";
import { SECRETS_EXPORT, SECRETS_UNPACK, SHELL_SECRET_ENV } from "./shellSecrets.ts";

/** `identityFile` is a path on this server, and the key itself never enters settings, logs or model context. */
export const ComputerSettings = Schema.Struct({
  enabled: Schema.Boolean,
  chromium: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  host: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  user: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  identityFile: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  port: Schema.optional(Schema.Int),
  browserPort: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })),
  ),
  /**
   * The account and key for the CDP tunnel alone. Bot shells run as `user`; the browser, its
   * profile and its CDP port belong to this account, so a shell cannot read cookies or drive CDP.
   */
  browserUser: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  browserIdentityFile: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  desktopBridge: Schema.optional(Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/))),
});
export type ComputerSettings = typeof ComputerSettings.Type;
export type RemoteSettings = ComputerSettings & {
  readonly host: string;
  readonly user: string;
  readonly identityFile: string;
};

/** `detail` is shown to the bot or the user as is. */
export class BotComputerError extends Schema.TaggedError<BotComputerError>()("BotComputerError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const BROWSER_ACTIONS = [
  "open",
  "snapshot",
  "click",
  "type",
  "press",
  "back",
  "screenshot",
] as const;
/** A saved shell secret's name; the server passes its value, which the bot never sees. */
const SecretRef = Schema.String.annotate({
  description: "The name of a secret you saved with ask_secret. The server passes its value.",
});
export const BrowserInput = Schema.Struct({
  action: Schema.Literals(BROWSER_ACTIONS),
  url: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
export type BrowserInput = typeof BrowserInput.Type;
export const BrowserResult = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  snapshot: Schema.optional(Schema.String),
  screenshot: Schema.optional(
    Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
});
export type BrowserResult = typeof BrowserResult.Type;

export interface BrowserOutcome {
  readonly result: BrowserResult;
  readonly challenge?: Challenge | undefined;
  readonly frame?: Uint8Array | undefined;
}

export const SHELL_DEFAULT_TIMEOUT_SECONDS = 60;
export const ShellInput = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  timeoutSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))),
  secrets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        secretRef: SecretRef,
        env: Schema.String.check(Schema.isPattern(SHELL_SECRET_ENV)).annotate({
          description: "The env var the command reads it from, such as API_KEY.",
        }),
        file: Schema.optional(Schema.Boolean).annotate({
          description: "The env var holds the path of a private file with the value instead.",
        }),
      }),
    ).check(Schema.isMaxLength(10)),
  ),
});
export type ShellInput = typeof ShellInput.Type;

export const SHELL_OUTPUT_CAP = 8_000;
const SNAPSHOT_CAP = 12_000;

export const slugFor = (threadId: string) => threadId.replace(/[^A-Za-z0-9_-]/g, "-");
export const shellUnit = (threadId: string) => `bot-shell-${slugFor(threadId)}`;

export const browserInputProblem = (input: BrowserInput): string | undefined => {
  switch (input.action) {
    case "open":
      return input.url && /^https?:\/\//i.test(input.url)
        ? undefined
        : "open needs an http or https url.";
    case "click":
      return input.ref ? undefined : "click needs a ref from the latest snapshot.";
    case "type":
      return input.ref && input.text !== undefined
        ? undefined
        : "type needs a ref from the latest snapshot and text.";
    case "press":
      return input.text ? undefined : "press needs text naming a key, such as Enter.";
    default:
      return undefined;
  }
};

export const activityLabel = (input: BrowserInput | ShellInput | ComputerAction) =>
  "command" in input
    ? `$ ${input.command.split("\n")[0]!.slice(0, 120)}`
    : [input.action, "url" in input ? input.url : "ref" in input ? input.ref : undefined]
        .filter(Boolean)
        .join(" ");

/** Keeps the first quarter and the last three quarters of the cap, so a runaway command never fills a disk or memory. No single quotes: it is sh-quoted. */
export const SHELL_CAP = `import sys
cap = int(sys.argv[1]); keep = cap // 4
head = bytearray(); tail = bytearray(); size = 0
for chunk in iter(lambda: sys.stdin.buffer.read(65536), b""):
    size += len(chunk)
    room = max(0, keep - len(head))
    head += chunk[:room]; tail += chunk[room:]
    del tail[:max(0, len(tail) - (cap - keep))]
try:
    code = open(sys.argv[2]).read().strip() or "1"
except OSError:
    code = "1"
out = sys.stdout.buffer
out.write(bytes(head) + ("\\n\\u2026\\n".encode() if size > cap else b"") + bytes(tail))
out.write(("\\n%s %d" % (code, size)).encode())`;

/** Where a bot's command finds its secret files on the computer: tmpfs, gone at reboot. */
const SECRETS_DIR = `\${XDG_RUNTIME_DIR:-$HOME/.cache}/bot-secrets/$slug`;

/**
 * Each bot gets one transient user unit, so a stop kills the whole process tree. Always exits 0 and ends with "<exit code> <output bytes>"; 124 means the timeout hit.
 * systemd-run would expand `${…}` in the command's arguments itself.
 */
export const SHELL_SCRIPT = `set -u
slug=$1 limit=$2 cap=$3
dir="$HOME/work/$slug" code="$HOME/.cache/bot-shell/$slug.code" sec="${SECRETS_DIR}"
mkdir -p "$dir" "$HOME/shared" "$HOME/.cache/bot-shell"
if systemctl --user is-active --quiet "bot-shell-$slug"; then
  printf 'A previous command is still running. Ask the user to stop it from your screen.\\n75 0'
  exit 0
fi
${SECRETS_UNPACK}
cmd=$(cat)
echo 1 >"$code"
{ systemd-run --user --quiet --collect --wait --pipe --expand-environment=no --unit="bot-shell-$slug" \\
    --working-directory="$dir" -p MemoryMax=1G -p RuntimeMaxSec=$((limit + 30)) \\
    /usr/bin/timeout -k 5 "$limit" /bin/bash -c '${SECRETS_EXPORT}' bot-cmd "$sec" "$cmd" </dev/null 2>&1
  echo $? >"$code"; rm -rf "$sec"; } |
  python3 -c '${SHELL_CAP}' "$cap" "$code"`;

export const SECRETS_CLEANUP = `slug=$1; rm -rf "${SECRETS_DIR}"`;

export const ShellResult = Schema.Struct({
  exitCode: Schema.Number,
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
  output: Schema.String,
});
export type ShellResult = typeof ShellResult.Type;

export const parseShellOutput = (stdout: string): ShellResult | undefined => {
  const end = stdout.lastIndexOf("\n");
  const trailer = /^(\d+) (\d+)$/.exec(stdout.slice(end + 1));
  if (end < 0 || !trailer) return undefined;
  const exitCode = Number(trailer[1]);
  return {
    exitCode,
    timedOut: exitCode === 124,
    truncated: Number(trailer[2]) > SHELL_OUTPUT_CAP,
    output: stdout.slice(0, end),
  };
};

export const cutSnapshot = (snapshot: string) =>
  snapshot.length <= SNAPSHOT_CAP
    ? snapshot
    : `${snapshot.slice(0, SNAPSHOT_CAP)}\n… ${snapshot.length - SNAPSHOT_CAP} more characters. Snapshot a ref, such as the main region, to see one part.`;

const WORK_DIR_LINE = `case "$slug" in .) work=$PWD ;; *) work="$HOME/work/$slug" ;; esac`;

export const PUT_SCRIPT = `set -eu
slug=$1 name=$2
${WORK_DIR_LINE}
dir="$work/inbox"
mkdir -p "$dir"
case "$name" in ?*.*) stem=\${name%.*} ext=".\${name##*.}" ;; *) stem=$name ext="" ;; esac
target=$name n=1
while [ -e "$dir/$target" ]; do target="$stem ($n)$ext"; n=$((n + 1)); done
base64 -d >"$dir/.$target.part"
mv "$dir/.$target.part" "$dir/$target"
printf 'inbox/%s' "$target"`;

/** Only files under the bot's work dir or ~/shared are read. */
export const GET_SCRIPT = `set -u
slug=$1 rel=$2 cap=$3
${WORK_DIR_LINE}
mkdir -p "$work" "$HOME/shared"
base=$(realpath "$work") shared=$(realpath "$HOME/shared")
cd "$base" || exit 3
case "$rel" in "~/"*) rel="$HOME/\${rel#??}" ;; esac
p=$(realpath -e -- "$rel" 2>/dev/null) || { echo missing; exit 0; }
case "$p" in "$base"/* | "$shared"/*) ;; *) echo outside; exit 0 ;; esac
[ -f "$p" ] || { echo notfile; exit 0; }
size=$(stat -c %s -- "$p")
[ "$size" -le "$cap" ] || { echo "large $size"; exit 0; }
echo "ok $size"
base64 -w0 -- "$p"`;

export type GetFileResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "missing" | "outside" | "notfile" | "large" };

export const parseGetFileOutput = (stdout: string): GetFileResult | undefined => {
  const newline = stdout.indexOf("\n");
  const head = (newline < 0 ? stdout : stdout.slice(0, newline)).trim();
  if (head.startsWith("ok ")) {
    const bytes = Buffer.from(newline < 0 ? "" : stdout.slice(newline + 1).trim(), "base64");
    return bytes.length === Number(head.slice(3)) ? { ok: true, bytes } : undefined;
  }
  const reason = head.split(" ")[0];
  return reason === "missing" || reason === "outside" || reason === "notfile" || reason === "large"
    ? { ok: false, reason }
    : undefined;
};

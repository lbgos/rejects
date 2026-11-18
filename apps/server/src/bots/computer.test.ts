// @effect-diagnostics nodeBuiltinImport:off - runs the bot computer's file scripts in a real shell.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { GET_SCRIPT, parseGetFileOutput, PUT_SCRIPT } from "./computer.ts";
import { SECRETS_EXPORT, SECRETS_UNPACK, shellSecretsHeader } from "./shellSecrets.ts";

const run = (home: string, script: string, args: ReadonlyArray<string>, stdin = "") =>
  NodeChildProcess.execFileSync("sh", ["-c", script, "bot", ...args], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    input: stdin,
    encoding: "utf8",
  });

const withHome = (use: (home: string) => Promise<void>) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return;
    yield* Effect.promise(async () => {
      const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-files-"));
      try {
        await use(home);
      } finally {
        await NodeFSP.rm(home, { recursive: true, force: true });
      }
    });
  });

it.effect("puts files in the bot's inbox without overwriting one", () =>
  withHome(async (home) => {
    const put = (text: string) =>
      run(home, PUT_SCRIPT, ["study", "notes.txt"], Buffer.from(text).toString("base64"));
    assert.strictEqual(put("one"), "inbox/notes.txt");
    assert.strictEqual(put("two"), "inbox/notes (1).txt");
    const inbox = NodePath.join(home, "work/study/inbox");
    assert.strictEqual(await NodeFSP.readFile(NodePath.join(inbox, "notes.txt"), "utf8"), "one");
    assert.strictEqual(
      await NodeFSP.readFile(NodePath.join(inbox, "notes (1).txt"), "utf8"),
      "two",
    );
  }),
);

it.effect("reads only files in the work dir or ~/shared", () =>
  withHome(async (home) => {
    const work = NodePath.join(home, "work/study");
    await NodeFSP.mkdir(NodePath.join(work, "out"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, "shared"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(work, "out/report.csv"), "a,b\n");
    await NodeFSP.writeFile(NodePath.join(home, "shared/song.mp3"), "mp3");
    await NodeFSP.writeFile(NodePath.join(home, "secret"), "key");
    await NodeFSP.symlink(NodePath.join(home, "secret"), NodePath.join(work, "link"));
    const get = (path: string, cap = 100) =>
      parseGetFileOutput(run(home, GET_SCRIPT, ["study", path, String(cap)]));

    assert.deepEqual(get("out/report.csv"), { ok: true, bytes: Buffer.from("a,b\n") });
    assert.deepEqual(get("~/shared/song.mp3"), { ok: true, bytes: Buffer.from("mp3") });
    assert.deepEqual(get("../../secret"), { ok: false, reason: "outside" });
    assert.deepEqual(get("link"), { ok: false, reason: "outside" });
    assert.deepEqual(get(NodePath.join(home, "secret")), { ok: false, reason: "outside" });
    assert.deepEqual(get("out"), { ok: false, reason: "notfile" });
    assert.deepEqual(get("gone.txt"), { ok: false, reason: "missing" });
    assert.deepEqual(get("out/report.csv", 2), { ok: false, reason: "large" });
  }),
);

it.effect("gives one command its secrets and leaves no file behind", () =>
  withHome(async (home) => {
    const sec = NodePath.join(home, "sec");
    const runner = [
      `sec=$1`,
      SECRETS_UNPACK,
      `cmd=$(cat)`,
      `/bin/bash -c '${SECRETS_EXPORT}' bot-cmd "$sec" "$cmd"`,
      `rm -rf "$sec"`,
    ].join("\n");
    const token = 'it\'s a "token" $HOME\n';
    const command = [
      `printf %s "$TOKEN" | base64 -w0; echo`,
      `cat "$KEY"; echo`,
      `stat -c %a "$(dirname "$KEY")" "$KEY"`,
      `ls -A "$(dirname "$KEY")"`,
    ].join("\n");
    const output = run(
      home,
      runner,
      [sec],
      shellSecretsHeader([
        { env: "TOKEN", value: token, file: false },
        { env: "KEY", value: "line one\nline two", file: true },
      ]) + command,
    );
    assert.deepEqual(output.split("\n"), [
      Buffer.from(token).toString("base64"),
      "line one",
      "line two",
      "700",
      "600",
      "KEY",
      "",
    ]);
    assert.isFalse(
      await NodeFSP.access(sec).then(
        () => true,
        () => false,
      ),
    );
    assert.strictEqual(run(home, runner, [sec], `${shellSecretsHeader([])}echo plain`), "plain\n");
  }),
);

it("refuses output that is not a whole file", () => {
  assert.isUndefined(parseGetFileOutput("ok 10\nYWI=\n"));
  assert.isUndefined(parseGetFileOutput("Permission denied\n"));
});

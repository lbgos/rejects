// @effect-diagnostics nodeBuiltinImport:off - Runs the lease against a fake `ssh` on PATH.
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeSshLease } from "./lease.ts";

const withFakeHost = async (
  body: (env: { host: string; store: string; log: () => Promise<string[]> }) => Promise<void>,
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
  const bin = NodePath.join(root, "bin");
  const host = NodePath.join(root, "host");
  const store = NodePath.join(root, "store");
  await NodeFSP.mkdir(bin);
  await NodeFSP.mkdir(host);
  await NodeFSP.writeFile(
    NodePath.join(bin, "ssh"),
    `#!/bin/sh
for last; do :; done
set -- $last
echo "$1 $2" >> "${root}/log"
case "$1" in
  put) cat > "${host}/$2" ;;
  get) [ -f "${host}/$2" ] || exit 1; cat "${host}/$2"; rm -f "${host}/$2" ;;
  wipe) rm -f "${host}/$2" ;;
esac
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await body({
      host,
      store,
      log: () =>
        NodeFSP.readFile(NodePath.join(root, "log"), "utf8").then((text) =>
          text.trim().split("\n"),
        ),
    });
  } finally {
    process.env.PATH = path;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const target = {
  host: "tools",
  user: "sess-owner",
  identityFile: "/key",
  knownHostsFile: "/known",
};

it("a profile is stored on save, put back on restore, and kept when a fetch fails", async () => {
  await withFakeHost(async ({ host, store, log }) => {
    const lease = makeSshLease(target, store);
    await lease.restore("olx.ua");
    await NodeFSP.writeFile(NodePath.join(host, "olx.ua"), "cookies-1");
    await lease.save("olx.ua");
    assert.equal(await NodeFSP.readFile(NodePath.join(store, "olx.ua.tar"), "utf8"), "cookies-1");
    assert.equal((await NodeFSP.stat(NodePath.join(store, "olx.ua.tar"))).mode & 0o777, 0o600);
    assert.deepEqual(await NodeFSP.readdir(host), []);
    await lease.restore("olx.ua");
    assert.equal(await NodeFSP.readFile(NodePath.join(host, "olx.ua"), "utf8"), "cookies-1");
    await NodeFSP.writeFile(NodePath.join(host, "olx.ua"), "cookies-2");
    await lease.save("olx.ua");
    assert.equal(await NodeFSP.readFile(NodePath.join(store, "olx.ua.tar"), "utf8"), "cookies-2");
    assert.equal(
      await NodeFSP.readFile(NodePath.join(store, "olx.ua.tar.prev"), "utf8"),
      "cookies-1",
    );
    let failed = false;
    await lease.save("olx.ua").catch(() => {
      failed = true;
    });
    assert.isTrue(failed);
    assert.deepEqual((await NodeFSP.readdir(store)).toSorted(), ["olx.ua.tar", "olx.ua.tar.prev"]);
    assert.equal(await NodeFSP.readFile(NodePath.join(store, "olx.ua.tar"), "utf8"), "cookies-2");
    await lease.discard("olx.ua");
    assert.deepEqual(await NodeFSP.readdir(store), []);
    assert.deepEqual(await log(), [
      "wipe olx.ua",
      "get olx.ua",
      "put olx.ua",
      "get olx.ua",
      "get olx.ua",
    ]);
  });
});

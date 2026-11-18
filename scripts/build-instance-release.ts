#!/usr/bin/env node
/**
 * Slim release tree for a headless instance: the bundled server and web client plus only the
 * runtime-external packages the bundle loads from disk, and the scripts deploys install from the
 * release. It keeps the paths of a full checkout, so units, gates and swaps run it unchanged.
 *
 *   vp run --filter t3 build && node scripts/build-instance-release.ts --out <dir>
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import * as HostProcess from "@t3tools/shared/HostProcess";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { stageRuntimeExternals } from "./build-cli-archive.ts";

/** Scripts the instance's swap and the vault rollout install from the release (`/opt/rejects/scripts`). */
const RELEASE_SCRIPTS = ["scripts/bot-sandbox-net.sh", "scripts/vault-sessions-host.sh"];
/** Every release path a unit, deploy gate, swap or rollout script reads; a slim tree lacking one fails here. */
const RELEASE_READS = [
  "apps/server/dist/bin.mjs",
  "apps/server/dist/client/index.html",
  "apps/server/dist/client/.vite/manifest.json",
  ...RELEASE_SCRIPTS,
];

export const buildInstanceRelease = Effect.fn("buildInstanceRelease")(function* (input: {
  readonly out: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const dist = path.join(repoRoot, "apps/server/dist");
  for (const required of ["bin.mjs", "client/index.html"]) {
    if (!(yield* fs.exists(path.join(dist, required)))) {
      return yield* Effect.die(
        `${path.join(dist, required)} is missing: run vp run --filter t3 build first.`,
      );
    }
  }

  const out = path.resolve(input.out);
  if (yield* fs.exists(out)) return yield* Effect.die(`${out} exists; pass a new directory.`);
  const targetDist = path.join(out, "apps/server/dist");
  yield* fs.makeDirectory(path.dirname(targetDist), { recursive: true });
  yield* fs.copy(dist, targetDist);
  const maps = (yield* fs.readDirectory(targetDist, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) yield* fs.remove(path.join(targetDist, entry));
  for (const script of RELEASE_SCRIPTS) {
    yield* fs.makeDirectory(path.join(out, path.dirname(script)), { recursive: true });
    yield* fs.copyFile(path.join(repoRoot, script), path.join(out, script));
  }
  const missing: string[] = [];
  for (const read of RELEASE_READS)
    if (!(yield* fs.exists(path.join(out, read)))) missing.push(read);
  if (missing.length > 0)
    return yield* Effect.die(`${out} lacks ${missing.join(", ")}, which deploys read.`);

  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: out,
    platform: "linux",
    arch: (yield* HostProcess.Architecture) === "arm64" ? "arm64" : "x64",
    version: serverPackageJson.version,
  });
  yield* Effect.log(`[instance-release] ${out}: dropped ${String(maps.length)} source maps.`);
  return out;
});

const command = Command.make(
  "build-instance-release",
  { out: Flag.String("out").pipe(Flag.withDescription("New directory for the release tree.")) },
  (input) => buildInstanceRelease(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Stage a slim headless-instance release from a built checkout."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}

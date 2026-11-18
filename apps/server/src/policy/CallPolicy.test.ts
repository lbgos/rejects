import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as CallPolicy from "./CallPolicy.ts";

it.effect.each([
  { name: "no zdr.json", contents: undefined, lock: undefined, starts: true },
  { name: "zdr.json off", contents: '{"enabled": false}', lock: undefined, starts: true },
  { name: "zdr.json on", contents: '{"enabled": true}', lock: undefined, starts: false },
  { name: "a damaged zdr.json", contents: "{", lock: undefined, starts: false },
  { name: "the DeepSeek-only lock", contents: undefined, lock: "1", starts: false },
])("a build without a policy, with $name", ({ contents, lock, starts }) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    if (contents !== undefined) yield* fs.writeFileString(`${config.stateDir}/zdr.json`, contents);
    const policy = yield* CallPolicy.CallPolicy.pipe(
      Effect.provide(CallPolicy.layerDefault),
      Effect.provideService(HostProcess.Environment, { T3CODE_DEEPSEEK_ONLY: lock }),
      Effect.result,
    );
    if (!starts) {
      assert.strictEqual(policy._tag, "Failure");
      return;
    }
    assert.strictEqual(policy._tag, "Success");
    if (policy._tag === "Success")
      assert.isTrue(Option.isNone(yield* policy.success.outside("linked-environment")));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-call-policy-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

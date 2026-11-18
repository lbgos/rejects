import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as VaultStore from "./VaultStore.ts";

const mode = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(Effect.map((info) => info.mode & 0o777));

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("VaultStore", (it) => {
  it.effect("keeps secrets in 0600 files under 0700 directories and never shows them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vault-store-test-" });
      const stateDir = path.join(dir, "state");
      const store = yield* VaultStore.make(stateDir);

      yield* store.setSecret("gmail", "clientSecret", "GOCSPX-not-a-real-secret");
      yield* store.setSecret("gmail", "refreshToken", "1//refresh-not-real");
      yield* store.updateAccount("olx.ua", () => ({
        createdAt: "2026-11-06T00:00:00Z",
        signedInAt: null,
        lastUsedAt: null,
      }));
      yield* store.audit({
        connection: "gmail",
        op: "connect",
        actor: "user",
        status: "ok",
        count: null,
        detail: null,
      });

      assert.strictEqual(yield* mode(fs, stateDir), 0o700);
      assert.strictEqual(yield* mode(fs, path.join(stateDir, "secrets")), 0o700);
      for (const file of yield* fs.readDirectory(path.join(stateDir, "secrets")))
        assert.strictEqual(yield* mode(fs, path.join(stateDir, "secrets", file)), 0o600, file);
      assert.strictEqual(yield* mode(fs, path.join(stateDir, "connections.json")), 0o600);
      assert.strictEqual(yield* mode(fs, path.join(stateDir, "audit.jsonl")), 0o600);
      assert.strictEqual(yield* mode(fs, path.join(stateDir, "accounts.json")), 0o600);

      const stored = yield* store.getSecret("gmail", "clientSecret");
      assert.deepStrictEqual(stored, Option.some("GOCSPX-not-a-real-secret"));
      assert.isTrue(Option.isNone(yield* store.getSecret("slack", "clientSecret")));

      const view = store.view("gmail");
      const shown = JSON.stringify(view);
      assert.notInclude(shown, "GOCSPX");
      assert.notInclude(shown, "refresh-not-real");
      assert.isNotNull(view.fields.find((f) => f.name === "clientSecret")?.setAt);
      assert.isNull(view.fields.find((f) => f.name === "clientId")?.setAt);
      assert.isUndefined(view.fields.find((f) => f.name === "refreshToken"));

      const reopened = yield* VaultStore.make(stateDir);
      assert.deepStrictEqual(reopened.view("gmail").fields, view.fields);
    }),
  );
});

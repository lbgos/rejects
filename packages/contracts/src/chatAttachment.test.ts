import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  CHAT_FILE_ATTACHMENT_MAX_BYTES,
  ChatAttachment,
  getProviderAttachmentLimitError,
  SnapShotAccessibility,
} from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);

it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const largestFile = yield* decodeAttachment({
      ...base,
      type: "file",
      sizeBytes: 300 * 1024 * 1024,
    });
    assert.strictEqual(largestFile.sizeBytes, 300 * 1024 * 1024);
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: CHAT_FILE_ATTACHMENT_MAX_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it("accepts up to 500 attachments in one message", () => {
  const files = Array.from({ length: 501 }, () => ({
    type: "file" as const,
    mimeType: "application/pdf",
    sizeBytes: 1024,
  }));
  assert.isUndefined(getProviderAttachmentLimitError(files.slice(0, 500)));
  assert.include(getProviderAttachmentLimitError(files), "up to 500 files");
});

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

import {
  type ChatAttachment,
  ChatAttachmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  attachmentFileExtension,
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export class BotAttachmentError extends Schema.TaggedError<BotAttachmentError>()(
  "BotAttachmentError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

export const safeFileName = (name: string) => {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const name120 = clean.length > 120 ? clean.slice(clean.length - 120) : clean;
  return name120 === "" || name120 === "." || name120 === ".." ? "file" : name120;
};

export const storeAttachment = Effect.fn("BotAttachments.store")(function* (input: {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const name = safeFileName(input.name);
  if (input.bytes.length === 0)
    return yield* new BotAttachmentError({ detail: `${name} is empty.` });
  if (input.bytes.length > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    return yield* new BotAttachmentError({ detail: `${name} is over 50 MB.` });
  const image =
    isProviderSendTurnSupportedImageMimeType(input.mimeType) &&
    input.bytes.length <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
  const id = createAttachmentId(input.threadId, image ? undefined : attachmentFileExtension(name));
  if (id === null) return yield* new BotAttachmentError({ detail: "This chat takes no files." });
  const attachment: ChatAttachment = {
    type: image ? "image" : "file",
    id: ChatAttachmentId.make(id),
    name,
    mimeType: input.mimeType.slice(0, 100) || "application/octet-stream",
    sizeBytes: input.bytes.length,
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (path === null) return yield* new BotAttachmentError({ detail: `Could not save ${name}.` });
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(path, input.bytes)),
    Effect.mapError(
      (cause) => new BotAttachmentError({ detail: `Could not save ${name}.`, cause }),
    ),
  );
  return attachment;
});

/** The bytes of an attachment stored for `threadId`; other chats' attachments are refused. */
export const readAttachment = Effect.fn("BotAttachments.read")(function* (
  threadId: ThreadId,
  attachmentId: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path =
    parseThreadSegmentFromAttachmentId(attachmentId) === toSafeThreadAttachmentSegment(threadId)
      ? resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId })
      : null;
  if (path === null)
    return yield* new BotAttachmentError({ detail: `No file ${attachmentId} in this chat.` });
  return yield* fs
    .readFile(path)
    .pipe(
      Effect.mapError(
        (cause) => new BotAttachmentError({ detail: `Could not read ${attachmentId}.`, cause }),
      ),
    );
});

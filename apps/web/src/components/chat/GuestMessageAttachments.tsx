import type { ChatAttachment } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { Fragment } from "react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { type ChatFileAttachment, isFileAttachment, isImageAttachment } from "../../types";
import { AttachmentImage } from "../media/AttachmentImage";
import { PierreEntryIcon } from "./PierreEntryIcon";

const IMAGE_FRAME =
  "aspect-[4/3] overflow-hidden rounded-lg border border-border/80 bg-background/70";
const FILE_ROW = "flex min-w-0 items-center gap-2 py-1 text-sm";
const DOWNLOAD_LINK =
  "flex shrink-0 items-center justify-center rounded-md p-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 focus-visible:outline-none";

/**
 * A guest message's files, drawn like a sent message's: image thumbnails, then file rows. The
 * owner opens them in the app; the guest loads them from the guest route. Files a bot shared
 * draw the same way at the start of the row.
 */
export function GuestMessageAttachments(props: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Where an image loads from; undefined while its URL is not ready. */
  readonly imageUrl: (attachment: ChatAttachment) => string | undefined;
  readonly onOpenImage: (attachment: ChatAttachment) => void;
  /** A file row as a link, or a button that calls `onOpenFile`. */
  readonly fileHref?: (attachment: ChatFileAttachment) => string;
  readonly onOpenFile?: (attachment: ChatFileAttachment) => void;
  /** A plain `<a download>` to a URL the server answers with `Content-Disposition: attachment`, so iOS Safari saves it. */
  readonly downloadHref?: (attachment: ChatAttachment) => string | undefined;
  readonly align?: "start" | "end";
}) {
  const { resolvedTheme } = useTheme();
  const images = props.attachments.filter(isImageAttachment);
  const files = props.attachments.filter(isFileAttachment);
  if (images.length === 0 && files.length === 0) return null;
  const downloadLink = (attachment: ChatAttachment) => {
    const href = props.downloadHref?.(attachment);
    return href ? (
      <a
        href={href}
        download={attachment.name}
        aria-label={`Download ${attachment.name}`}
        className={DOWNLOAD_LINK}
      >
        <DownloadIcon className="size-4" />
      </a>
    ) : null;
  };
  return (
    <div
      className={cn("flex flex-col gap-2", props.align === "start" ? "items-start" : "items-end")}
    >
      {images.length > 0 ? (
        <div className="grid w-[210px] grid-cols-2 gap-2">
          {images.map((image) => {
            const src = props.imageUrl(image);
            return (
              <div key={image.id} className={IMAGE_FRAME}>
                {src ? (
                  <button
                    type="button"
                    className="block size-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => props.onOpenImage(image)}
                  >
                    {/* Isolate the thumbnail raster from nearby activity repaints in Chromium. */}
                    <AttachmentImage
                      name={image.name}
                      mimeType={image.mimeType}
                      src={src}
                      alt={image.name}
                      decoding="async"
                      className="block size-full transform-gpu object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex size-full items-center justify-center px-2 text-center text-2xs text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {props.downloadHref
        ? images.map((image) => (
            <div key={image.id} className={cn(FILE_ROW, "max-w-full")}>
              <span className="min-w-0 truncate">{image.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatAttachmentSize(image.sizeBytes)}
              </span>
              {downloadLink(image)}
            </div>
          ))
        : null}
      {files.map((file) => {
        const identity = (
          <>
            <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatAttachmentSize(file.sizeBytes)}
            </span>
          </>
        );
        const open = props.fileHref ? (
          <a
            href={props.fileHref(file)}
            download={file.name}
            className={cn(FILE_ROW, "hover:underline")}
          >
            {identity}
          </a>
        ) : props.onOpenFile ? (
          <button
            type="button"
            aria-label={`Preview ${file.name}`}
            onClick={() => props.onOpenFile?.(file)}
            className={cn(FILE_ROW, "min-w-0 cursor-pointer hover:underline")}
          >
            {identity}
          </button>
        ) : (
          <div className={FILE_ROW}>{identity}</div>
        );
        return props.downloadHref ? (
          <div key={file.id} className="flex max-w-full min-w-0 items-center">
            {open}
            {downloadLink(file)}
          </div>
        ) : (
          <Fragment key={file.id}>{open}</Fragment>
        );
      })}
    </div>
  );
}

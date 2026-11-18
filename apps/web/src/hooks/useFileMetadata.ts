import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  isAbsolutePath,
  isNetworkPath,
  normalizeProjectPathForComparison,
} from "@t3tools/shared/path";
import { useContext } from "react";

import { BotThreadContext } from "../bots/context";
import { useEnvironmentScope } from "../state/session";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

/** `mapped`: a sandboxed bot's chat, whose paths the server maps to the files the bot wrote. */
export function getFileMetadataQueryAtom(
  environmentId: EnvironmentId,
  path: string,
  cwd?: string,
  threadRef?: ScopedThreadRef | null,
  mapped = false,
) {
  const hostPath = splitFilePathPosition(path).path;
  const targetPath = normalizeProjectPathForComparison(
    hostPath.startsWith("~/") || !cwd ? hostPath : resolvePathLinkTarget(hostPath, cwd),
  );
  const absolute = isAbsolutePath(targetPath) || targetPath.startsWith("~/");
  return (
    // Servers stat what they are asked about, and a network path leaks the
    // Windows user's NTLM credentials to its host before any chip is clicked.
    absolute && !isNetworkPath(targetPath) && targetPath.length <= 512
      ? projectEnvironment.fileMetadata({
          environmentId,
          input: {
            path: targetPath,
            ...(threadRef?.environmentId === environmentId
              ? { threadId: threadRef.threadId, ...(mapped ? { mapped: true as const } : {}) }
              : {}),
          },
        })
      : null
  );
}

export function useFileMetadata(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd?: string,
) {
  const canRead = useEnvironmentScope(environmentId ?? null, AuthFilesystemReadScope);
  const threadRef = useContext(FileMetadataThreadContext);
  const botThread = useContext(BotThreadContext);
  return useEnvironmentQuery(
    environmentId && canRead
      ? getFileMetadataQueryAtom(environmentId, path, cwd, threadRef, botThread)
      : null,
  ).data;
}

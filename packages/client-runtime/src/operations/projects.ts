import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type {
  EnvironmentId,
  ServerConfig,
  ServerSettings,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { cloneUrlRepositoryPath } from "@t3tools/shared/cloneUrl";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseParentPath,
  inferProjectTitleFromPath,
} from "../state/projects.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { sourceControlClients } from "../sourceControlClients.ts";
import type { SourceControlDefinition } from "../sourceControlClients.ts";

export type AddProjectRemoteSource = SourceControlProviderKind | "url";

export function canCreateProjectInEnvironment(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function availableScratchWorkspaceRoot(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
  serverConfig: Pick<ServerConfig, "scratchWorkspaceRoot"> | null | undefined,
): string | null {
  return canCreateProjectInEnvironment(connectionPhase)
    ? (serverConfig?.scratchWorkspaceRoot ?? null)
    : null;
}

export interface AddProjectRemoteSourceReadinessEntry {
  readonly ready: boolean;
  readonly hint: string | null;
}

export type AddProjectRemoteSourceReadiness = (
  source: AddProjectRemoteSource,
) => AddProjectRemoteSourceReadinessEntry;

export type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const ADD_PROJECT_REMOTE_PROVIDER_SOURCES: ReadonlyArray<SourceControlProviderKind> =
  sourceControlClients.definitions.map((definition) => definition.kind);

function addProjectRemoteSourceLabel(source: AddProjectRemoteSource): string {
  return source === "url" ? "Git URL" : sourceControlClients.get(source).pickerLabel;
}

const REPOSITORY_SHORTHAND = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/;

/**
 * The clone URL of `owner/name` on the public host of the host a repository reads as before it
 * reports one. Null when that host has no public host.
 */
function defaultHostCloneUrl(repository: string): string | null {
  const definition = sourceControlClients.get(undefined);
  if (definition.publicHost === null) return null;
  const path = repository.endsWith(".git") ? repository : `${repository}.git`;
  return definition.defaultCloneTransport === "https"
    ? `https://${definition.publicHost}/${path}`
    : `git@${definition.publicHost}:${path}`;
}

/** Owner present, repository name missing: `owner/` or `owner//`. */
const INCOMPLETE_GITHUB_OWNER_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/+$/;

const INCOMPLETE_GITHUB_OWNER_REPOSITORY_MESSAGE = "Enter the full owner/repository name.";

/**
 * Message to show when a GitHub add-project field is only `owner/`.
 * Lookup would send that to GitHub and come back as a generic failure.
 * Returns null for complete names, bare repo names, URLs, and other sources.
 */
export function githubIncompleteOwnerRepositoryMessage(
  source: AddProjectRemoteSource,
  input: string,
): string | null {
  if (source !== "github") return null;
  if (!INCOMPLETE_GITHUB_OWNER_PATH.test(input.trim())) return null;
  return INCOMPLETE_GITHUB_OWNER_REPOSITORY_MESSAGE;
}

export function normalizePastedCloneUrl(input: string): string {
  const trimmed = input.trim();
  if (REPOSITORY_SHORTHAND.test(trimmed)) return defaultHostCloneUrl(trimmed) ?? trimmed;
  return sourceControlClients.repositoryUrlFromPage(trimmed) ?? trimmed;
}

export function getDefaultCloneUrl(
  repository: Pick<SourceControlRepositoryInfo, "provider" | "url" | "sshUrl">,
): string {
  return sourceControlClients.get(repository.provider).defaultCloneTransport === "https"
    ? repository.url
    : repository.sshUrl;
}

export type OfferedSourceControlProviders = ServerSettings["offeredSourceControlProviders"];

/** Whether the project pickers offer a host. Only the default host is on until the user turns others on. */
export function isSourceControlProviderOffered(
  offered: OfferedSourceControlProviders | undefined,
  kind: SourceControlProviderKind,
): boolean {
  return offered?.[kind] ?? kind === sourceControlClients.get(undefined).kind;
}

export function sortAddProjectProviderSources(
  readiness: AddProjectRemoteSourceReadiness,
  offered: OfferedSourceControlProviders | undefined,
): ReadonlyArray<SourceControlProviderKind> {
  return Arr.sort(
    ADD_PROJECT_REMOTE_PROVIDER_SOURCES.filter((source) =>
      isSourceControlProviderOffered(offered, source),
    ),
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (source: SourceControlProviderKind) => ({
        ready: readiness(source).ready,
        label: addProjectRemoteSourceLabel(source),
      }),
    ),
  );
}

export function getAddProjectInitialQuery(baseDirectory: string | null | undefined): string {
  const trimmed = baseDirectory?.trim() ?? "";
  return trimmed.length === 0 ? "~/" : ensureBrowseDirectoryPath(trimmed);
}

export function getCloneDirectoryName(repositoryOrRemoteUrl: string | null | undefined): string {
  const withoutQuery = (repositoryOrRemoteUrl ?? "").split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  const pathPart = schemeIndex >= 0 ? withoutQuery.slice(schemeIndex + "://".length) : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) {
    return "";
  }

  const lastSegment = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(lastSegment)) {
    return "";
  }
  return lastSegment.endsWith(".git") ? lastSegment.slice(0, -".git".length) : lastSegment;
}

/** The folder a clone gets below its base: `<repo>`, or `<host>/<owner>/<repo>` like ghq. */
export function getCloneDirectoryPath(
  remoteUrl: string,
  ghqCloneLayout: boolean,
  repository = remoteUrl,
): string {
  return (
    (ghqCloneLayout ? cloneUrlRepositoryPath(remoteUrl) : null) ?? getCloneDirectoryName(repository)
  );
}

/** The clone's own folder, which folder browsing keeps at the end of the destination. */
export function getCloneDirectoryLeafName(
  remoteUrl: string,
  ghqCloneLayout: boolean,
  repository = remoteUrl,
): string {
  return getCloneDirectoryPath(remoteUrl, ghqCloneLayout, repository).split("/").at(-1) ?? "";
}

export function getCloneDestinationPath(
  directoryPath: string,
  directoryName: string | null | undefined,
): string {
  const name = directoryName?.trim() ?? "";
  if (name.length === 0) {
    return directoryPath;
  }
  const base = ensureBrowseDirectoryPath(directoryPath);
  return `${base}${base.endsWith("\\") ? name.replaceAll("/", "\\") : name}`;
}

export interface NewProjectPublishTarget {
  readonly definition: SourceControlDefinition;
  readonly owner: string | null;
}

function getCloneDestinationBrowsePath(input: {
  readonly browseDirectoryPath: string;
  readonly selectedDirectoryName: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const selectedDirectoryPath = appendBrowsePathSegment(
    input.browseDirectoryPath,
    input.selectedDirectoryName,
  );
  const selectedDirectoryMatches = input.caseSensitive
    ? input.selectedDirectoryName === input.cloneDirectoryName
    : input.selectedDirectoryName.toLowerCase() === input.cloneDirectoryName.toLowerCase();
  return selectedDirectoryMatches
    ? selectedDirectoryPath
    : getCloneDestinationPath(selectedDirectoryPath, input.cloneDirectoryName);
}

// The native picker returns a full path, not a name under the browsed directory.
// Split it and reuse the in-app rules so a folder already named after the
// repository stays that folder instead of becoming repo/repo.
export function getCloneDestinationForPickedFolder(input: {
  readonly pickedPath: string;
  readonly cloneDirectoryName: string;
  readonly caseSensitive: boolean;
}): string {
  const parentPath = getBrowseParentPath(input.pickedPath);
  if (parentPath === null) {
    return getCloneDestinationPath(input.pickedPath, input.cloneDirectoryName);
  }
  return getCloneDestinationBrowsePath({
    browseDirectoryPath: parentPath,
    selectedDirectoryName: inferProjectTitleFromPath(input.pickedPath),
    cloneDirectoryName: input.cloneDirectoryName,
    caseSensitive: input.caseSensitive,
  });
}

export function findExistingAddProject(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentProject | null {
  return (
    findProjectByPath(
      input.projects.filter((project) => project.environmentId === input.environmentId),
      input.path,
    ) ?? null
  );
}

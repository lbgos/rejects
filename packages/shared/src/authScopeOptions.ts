import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";

export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "View chats",
    description: "Read chats, status and configuration.",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "Send and stop",
    description: "Send messages, and start and stop replies and tasks.",
  },
  {
    scope: AuthSettingsWriteScope,
    title: "Change settings",
    description: "Edit this server's settings.",
  },
  {
    scope: AuthProvidersManageScope,
    title: "Manage providers",
    description: "Set up, sign in to and update providers and usage hubs.",
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: "Maintain the server",
    description: "Update the server and control its processes.",
  },
  {
    scope: AuthPreviewOperateScope,
    title: "Control the browser",
    description: "Open browser pages and drive browser automation.",
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: "View diagnostics and usage",
    description: "Read process diagnostics, resource history and usage totals.",
  },
  {
    scope: AuthTerminalReadScope,
    title: "View terminals",
    description: "Read existing terminal output and status.",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "Use terminals",
    description: "Create terminals and send input to running shells.",
  },
  {
    scope: AuthSourceControlWriteScope,
    title: "Change source control",
    description: "Commit, push, manage branches and repositories, and change pull requests.",
  },
  {
    scope: AuthFilesystemReadScope,
    title: "Read files",
    description: "Browse files on the server and search workspaces.",
  },
  {
    scope: AuthFilesystemWriteScope,
    title: "Write files",
    description: "Edit workspace files.",
  },
  {
    scope: AuthAccessReadScope,
    title: "View access",
    description: "See pairing links and paired devices.",
  },
  {
    scope: AuthAccessWriteScope,
    title: "Manage access",
    description: "Create and revoke access for other devices.",
  },
  {
    scope: AuthRelayReadScope,
    title: "View relay",
    description: "Inspect managed relay connectivity.",
  },
  {
    scope: AuthRelayWriteScope,
    title: "Manage relay",
    description: "Change managed tunnel connectivity.",
  },
];

/** Shown instead of the granted scopes while they are unknown, so every surface says the same thing. */
export function sessionPermissionsUnavailableMessage(input: {
  readonly connected: boolean;
  /** The check errored; the client retries it while connected. */
  readonly failed: boolean;
  /** The environment answered that this session is not signed in; retrying will not change that. */
  readonly rejected: boolean;
}): string {
  if (!input.connected) return "Connect to this server to see this session’s permissions.";
  if (input.rejected) return "This server did not accept your session. Reconnect to try again.";
  return input.failed
    ? "Could not verify your permissions. Retrying automatically."
    : "Checking permissions…";
}

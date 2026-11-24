import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthRelayWriteScope,
  type EnvironmentId,
  connectReachabilityHelpUrl,
  formatConnectReachable,
  managedCapabilityDenial,
} from "@t3tools/contracts";

import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { useT3ConnectTurnOn } from "~/cloud/useT3ConnectTurnOn";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { readEnvironmentScope } from "~/state/session";
import { useManagedPolicy } from "~/state/managedPolicy";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { CLI_COMMAND_NAME } from "@t3tools/shared/cliRelease";

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable T3 Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({
  environmentId,
  canManageRelay,
  connectDeviceApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly canManageRelay: boolean;
  readonly connectDeviceApproval: ConnectDeviceApprovalControl | null;
}) {
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
  const {
    isSignedIn,
    linkState: cloudLinkState,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController(environmentId);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // The server unlinks and refuses relay changes under such a policy; unlinking stays possible.
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  const turnOn = useT3ConnectTurnOn(environmentId);
  // Turning on links from this desktop's own backend only; turning off works from anywhere.
  const showSwitch = isElectron && (turnOn.kind !== "on-host" || managedTunnelActive);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = canManageRelay
    ? null
    : "Your session does not have permission to manage T3 Connect access.";
  const isBusy = isUpdating || isUpdatingPreference;
  const switchDisabled =
    !canManageRelay ||
    !isSignedIn ||
    cloudLinkState.data === null ||
    cloudLinkState.isPending ||
    isBusy;
  // `isSignedIn` is undefined until Clerk loads. Signed out, one row shows a
  // sign-in button instead of its switch.
  const signedOut = isSignedIn === false;
  const signInButton = (
    <Button size="sm" variant="outline" onClick={openAuthPrompt}>
      Sign in
    </Button>
  );
  const refreshLinkState = useEffectEvent(cloudLinkState.refresh);
  // The server rechecks reachability when the tunnel's 30 s readiness poll changes.
  // Poll while mounted, so a failed read does not stop later ones.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30 s interval that refreshes the cloud link reachability while mounted
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const reachability = managedTunnelActive ? cloudLinkState.data?.reachability : undefined;
  const reachabilityStatus =
    reachability?.status === "reachable" ? (
      formatConnectReachable(reachability)
    ) : reachability?.status === "unreachable" ? (
      <span className="block text-destructive">
        {[reachability.reason, reachability.hint, `Fix: ${reachability.fix}`]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          More info
        </a>
      </span>
    ) : null;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthRelayWriteScope)) return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? "T3 Connect linked"
          : publishAgentActivity
            ? "T3 Connect tunnel disabled"
            : "T3 Connect unlinked",
        description: enabled
          ? "This environment is available through T3 Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through T3 Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthRelayWriteScope)) return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? "T3 Connect keeps webhook requests for up to 24 hours while this environment is offline."
          : "Requests to an offline environment now fail. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {showSwitch ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={
            connectDenial !== undefined && !managedTunnelActive
              ? connectDenial
              : signedOut
                ? "Sign in to make this environment available to your other devices through T3 Connect."
                : linkRevoked
                  ? "This environment was removed from T3 Connect. Turn it on to link it again."
                  : managedTunnelActive
                    ? reachability?.status === "unreachable"
                      ? "T3 Connect is on, but other devices cannot reach this environment."
                      : reachability?.status === "reachable"
                        ? "This environment is available to your other devices through T3 Connect."
                        : "T3 Connect is on. Reachability has not been checked yet."
                    : managedTunnelOutOfSync
                      ? "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it."
                      : "Make this environment available to your other devices through T3 Connect."
          }
          status={operationError ?? cloudLinkState.error ?? reachabilityStatus}
          managed={managedTunnelActive ? undefined : connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                checked={managedTunnelActive}
                disabled={switchDisabled}
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
              />
            )
          }
        />
      ) : linkRevoked ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={`This environment was removed from T3 Connect. Run \`${CLI_COMMAND_NAME} connect link\` on the host to link it again.`}
        />
      ) : isElectron ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={`Run \`${CLI_COMMAND_NAME} connect link\` on the host, then restart rejects there.`}
        />
      ) : null}
      {signedOut && showSwitch ? null : (
        <SettingsRow
          title={searchableSetting("publish-agent-activity").title}
          description={
            signedOut
              ? "Sign in to send activity to mobile notifications and Live Activities."
              : "Send activity to mobile notifications and Live Activities without T3 Connect."
          }
          managed={connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                ariaLabel="Publish agent activity to mobile clients"
                checked={publishAgentActivity}
                disabled={switchDisabled}
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
              />
            )
          }
        />
      )}
      {managedTunnelActive && !signedOut ? (
        <SettingsRow
          title={searchableSetting("hold-webhooks-while-offline").title}
          description="Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing."
          managed={connectDenial}
          control={
            <CloudLinkSwitch
              ariaLabel="Hold webhook requests while this environment is offline"
              checked={holdWebhooksWhileOffline}
              disabled={switchDisabled}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
            />
          }
        />
      ) : null}
      {managedTunnelActive && connectDeviceApproval ? (
        <SettingsRow
          title={searchableSetting("connect-device-approval").title}
          description="Devices that sign in to your T3 Connect account wait until someone already connected here approves them."
          managed={connectDenial}
          control={
            <CloudLinkSwitch
              ariaLabel="Require approval for new T3 Connect devices"
              checked={connectDeviceApproval.required}
              disabled={!connectDeviceApproval.canManage}
              disabledReason={
                connectDeviceApproval.canManage
                  ? null
                  : "Your session does not have permission to manage access."
              }
              onCheckedChange={(enabled) =>
                updateEnvironmentSettings({ requireConnectDeviceApproval: enabled })
              }
            />
          }
        />
      ) : null}
    </>
  );
}

/** Older servers have no device approval, so callers pass null and the row stays hidden. */
export interface ConnectDeviceApprovalControl {
  readonly required: boolean;
  readonly canManage: boolean;
}

export function CloudLinkRow({
  environmentId,
  canReadRelay,
  canManageRelay,
  connectDeviceApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
  readonly connectDeviceApproval: ConnectDeviceApprovalControl | null;
}) {
  if (!hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    return (
      <SettingsRow
        title="T3 Connect"
        description="To edit these settings, pair this connection with both View relay and Manage relay permissions."
      />
    );
  }
  return (
    <ConfiguredCloudLinkRow
      environmentId={environmentId}
      canManageRelay={canManageRelay}
      connectDeviceApproval={connectDeviceApproval}
    />
  );
}

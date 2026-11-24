import { hasSavedBearerRoute } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    }),
  );
}

/** Environments this device saved: switch one off to stop connecting, or forget it. */
export function SavedEnvironmentsSettings() {
  const { environments } = useEnvironments();
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const remove = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [removingId, setRemovingId] = useState<EnvironmentId | null>(null);
  const saved = environments.filter(
    (environment) =>
      environment.entry.target._tag !== "PrimaryConnectionTarget" &&
      !isDesktopLocalConnectionTarget(environment.entry.target),
  );
  if (saved.length === 0) return null;

  const handleSetEnabled = async (environmentId: EnvironmentId, enabled: boolean) => {
    const result = await setEnabled({ environmentId, enabled });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(
        `Could not switch environment ${enabled ? "on" : "off"}`,
        squashAtomCommandFailure(result),
      );
    }
  };
  const handleRemove = async (environment: EnvironmentPresentation) => {
    const confirmed = await requestConfirmDialog(
      `Remove ${environment.label} from this device?\nThis forgets its pairing, credentials, and cached threads here. Switch it off instead to keep it saved.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRemovingId(environment.environmentId);
    const result = await remove(environment.environmentId);
    setRemovingId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not remove environment", squashAtomCommandFailure(result));
    }
  };

  return (
    <SettingsSection {...searchableSetting("saved-environments")}>
      {saved.map((environment) => {
        const unsupported = environment.connection.phase === "unsupported";
        const blocked = unsupported && !hasSavedBearerRoute(environment.entry);
        const enabled = environment.entry.enabled && !unsupported;
        const removing = removingId === environment.environmentId;
        return (
          <SettingsRow
            key={environment.environmentId}
            title={environment.label}
            description={enabled ? "On" : "Off"}
            control={
              <div className="flex items-center gap-2">
                <Switch
                  checked={enabled}
                  disabled={removing || blocked}
                  aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
                  onCheckedChange={(checked) =>
                    void handleSetEnabled(environment.environmentId, checked)
                  }
                />
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  disabled={removing}
                  onClick={() => void handleRemove(environment)}
                >
                  Remove
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

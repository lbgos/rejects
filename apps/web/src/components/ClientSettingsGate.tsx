import { RefreshIcon } from "~/components/ui/refresh-icon";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";
import { StandalonePage, StandalonePageHeader } from "./ui/standalone-page";

/** Holds the app until saved client settings load, so it never renders on defaults. */
export function ClientSettingsGate({ children }: { readonly children: React.ReactNode }) {
  const status = useClientSettingsHydrationStatus();
  if (status === "ready") return children;
  if (status === "pending") return null;
  const retrying = status === "retrying";
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Could not read settings"
        description="The settings saved in this browser could not be loaded. Nothing was changed."
      />
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={retrying}
          onClick={() => void ensureClientSettingsHydrated().catch(() => undefined)}
        >
          <RefreshIcon refreshing={retrying} />
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload app
        </Button>
      </div>
    </StandalonePage>
  );
}

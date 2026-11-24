import { RefreshIcon } from "~/components/ui/refresh-icon";

import {
  ensureClientSettingsHydrated,
  useClientSettingsHydrationStatus,
} from "../hooks/useSettings";
import { Button } from "./ui/button";

/** Holds the app until saved client settings load, so it never renders on defaults. */
export function ClientSettingsGate({ children }: { readonly children: React.ReactNode }) {
  const status = useClientSettingsHydrationStatus();
  if (status === "ready") return children;
  if (status === "pending") return null;
  const retrying = status === "retrying";
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">Could not read settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your saved settings could not be loaded.
        </p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => void ensureClientSettingsHydrated().catch(() => undefined)}
        >
          <RefreshIcon refreshing={retrying} />
          Retry
        </Button>
      </div>
    </main>
  );
}

import { useClerk } from "@clerk/react";

import { retryClerkLoad } from "./clerkLoadFailure";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    if (clerk.status === "error") {
      retryClerkLoad();
      return;
    }
    clerk.openSignIn();
  };
  return { openAuthPrompt };
}

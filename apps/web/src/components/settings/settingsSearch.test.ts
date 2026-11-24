import { describe, expect, it, vi } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isSecretsFeatureEnabled: false,
}));

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/access",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("sharing", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    const spanish = (message: string) => (message === "Word wrap" ? "Ajuste de línea" : message);
    expect(searchSettings("ajuste", ITEMS, spanish).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("hides the Secrets page from nav and search while the secrets feature is disabled", () => {
    expect(SETTINGS_NAV_GROUPS.flatMap((group) => group.paths)).not.toContain("/settings/secrets");
    expect(searchSettings("1password").map((item) => item.to)).not.toContain("/settings/secrets");
  });

  it("finds the Scheduled tasks page", () => {
    expect(searchSettings("scheduled tasks")[0]).toMatchObject({
      id: "scheduled-tasks",
      to: "/settings/scheduled-tasks",
    });
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
    });

    const gatedIds = new Set<string>([
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "linked-environments",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);

    const connected = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
    };
    const ids = (hasCallPolicy: boolean) =>
      filterAvailableSettingsSearchItems({ ...connected, hasCallPolicy }).map((item) => item.id);
    expect(ids(false)).not.toContain("zero-data-retention");
    expect(ids(true)).toContain("zero-data-retention");
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "linked environments",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/access",
        targetId: "linked-environments",
      }),
    );
  });

  it("finds rows by the titles shown on their pages", () => {
    for (const [title, id] of [
      ["Delete old browser artifacts", "storage-artifacts"],
      ["Delete old rotated logs", "storage-artifacts"],
      ["Native sessions", "providers"],
      ["CODEX_HOME path", "providers"],
      ["Shadow home path", "providers"],
    ] as const) {
      expect(searchSettings(title)[0]?.id, title).toBe(id);
    }
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry export").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    for (const id of ["response-streaming", "speech-project-dictionary"]) {
      expect(getSettingsSearchTargetScope(id)?.scope).toBe("project-defaults");
    }
    for (const scope of ["all", "environment", "project"] as const) {
      expect(isSettingsSearchScopeAvailable("project-defaults", scope)).toBe(true);
    }
    expect(getSettingsSearchTargetScope("tool-call-visibility")!.scope).toBeNull();
  });
});

describe("movedSettingsPath", () => {
  it("sends old links to the page their row moved to", () => {
    expect(movedSettingsPath("/settings/connections", "authorized-clients")).toBe(
      "/settings/access",
    );
    expect(movedSettingsPath("/settings/connections", "network-access")).toBe("/settings/access");
    expect(movedSettingsPath("/settings/connections", "remote-environments")).toBe(
      "/settings/access",
    );
    expect(movedSettingsPath("/settings/labs", "linked-environments-beta")).toBe(
      "/settings/access",
    );
    expect(movedSettingsPath("/settings/threads", "response-streaming")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/labs", "prompt-suggestions-beta")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/storage", "")).toBe("/settings/maintenance");
  });

  it("sends links to removed pages to the settings list", () => {
    expect(movedSettingsPath("/settings/worktrees", "")).toBe("/settings");
    expect(movedSettingsPath("/settings/keybindings", "keybindings")).toBe("/settings");
    expect(movedSettingsPath("/settings/beta", "")).toBe("/settings");
  });

  it("leaves current pages alone", () => {
    expect(movedSettingsPath("/settings/general", "time-format")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "theme")).toBeNull();
  });
});

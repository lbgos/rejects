import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

import type { UsageMetric } from "./usageShortcuts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  muse: {
    label: "Muse Code",
    color: "#0866ff",
    driverKind: ProviderDriverKind.make("muse"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

export function rankProvidersByMetric(
  providers: readonly UsageProviderKind[],
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
  metric: UsageMetric,
): readonly UsageProviderKind[] {
  const field = metric === "cost" ? "costUsd" : "totalTokens";
  const value = (provider: UsageProviderKind) =>
    totals.find((entry) => entry.provider === provider)?.[field] ?? 0;
  return providers.toSorted((left, right) => value(right) - value(left));
}

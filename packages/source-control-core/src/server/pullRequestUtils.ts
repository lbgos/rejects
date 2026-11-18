export function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/** Normalize host timestamps to UTC for cross-host string sorting. */

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

// @effect-diagnostics nodeBuiltinImport:off -- Redacts this server's home path at the push boundary.
import * as NodeOS from "node:os";

const KEY_SHAPES =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_[a-z]+_[A-Za-z0-9_]{16,}|whsec_[A-Za-z0-9+/=_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

export const redactKeys = (text: string) => text.replace(KEY_SHAPES, "[redacted]");

/** Scrub outbound push text before truncation, including incomplete PEM blocks. */
export function redact(text: string, home = NodeOS.homedir()): string {
  const clean = text
    .replace(
      /https?:\/\/[^\s<>"']*(?:\/webhooks?(?:\/|[?])|\/hooks\/|hooks\.[^/]+\/|webhook\.[^/]+\/)[^\s<>"']*/gi,
      "[redacted]",
    )
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(
      /https?:\/\/(?:hooks\.slack\.com\/services\/|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)[^\s<>"']+/gi,
      "[redacted]",
    )
    .replace(KEY_SHAPES, "[redacted]")
    .replace(
      /\b(?:Bearer\s+|(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "[redacted]",
    );
  return home.length > 1 ? clean.split(home).join("~") : clean;
}

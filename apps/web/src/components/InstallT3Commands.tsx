import { CLI_COMMAND_NAME, CLI_NPM_PACKAGE_NAME } from "@t3tools/shared/cliRelease";

import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install the CLI, then run `command`. The browser showing this
 * is often not the computer being set up.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">Install (needs Node.js)</p>
      <CommandBlock command={`npm install --global ${CLI_NPM_PACKAGE_NAME}`} />
      <p className="text-xs text-muted-foreground">Then</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Skip the install if you already have <code className="font-mono">{CLI_COMMAND_NAME}</code>.
      </p>
    </div>
  );
}

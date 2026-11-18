import { isEntrypoint } from "./entrypoint.ts";
import { main } from "./main.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  await main();
}

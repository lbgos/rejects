import type { BrowserResult } from "../../../bots/computer.ts";
import * as Effect from "effect/Effect";
import * as BotComputer from "../../../bots/BotComputer.ts";
import * as Accounts from "../../../connections/Accounts.ts";
import * as BotSecrets from "../../../secrets/BotSecrets.ts";
import * as Access from "../../McpToolAccess.ts";
import { botActs } from "../botActs.ts";
import { ComputerBrowserToolkit, ComputerShellToolkit, ComputerDesktopToolkit } from "./tools.ts";

const actor = Effect.fn("ComputerTools.actor")(function* () {
  const acts = yield* botActs("computer");
  return { ...acts, computer: yield* BotComputer.BotComputer };
});

const redacted = (result: BrowserResult, redact: (text: string) => string): BrowserResult => ({
  ...result,
  url: redact(result.url),
  title: redact(result.title),
  ...(result.snapshot === undefined ? {} : { snapshot: redact(result.snapshot) }),
});

export const layerBrowser = Access.toLayer(ComputerBrowserToolkit, {
  computer_browser: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, bot, redact, fail, record, computer } = yield* actor();
      const acting = input.action !== "snapshot" && input.action !== "screenshot";
      const what =
        input.action === "type"
          ? `"${input.text ?? ""}" into ${input.ref}`
          : (input.url ?? input.ref ?? input.text ?? "");
      const step = { action: `computer_browser ${input.action}` };
      const outcome = yield* computer.browse(bot, input).pipe(
        Effect.tapError((error) =>
          acting
            ? record({ ...step, detail: `${what} · ${error.message}`, status: "failed" })
            : Effect.void,
        ),
        Effect.mapError((error) => fail(error.message)),
      );
      const result = redacted(outcome.result, redact);
      if (acting)
        yield* record({
          ...step,
          detail: `${what} · ${result.url}`,
          status: outcome.challenge ? "refused" : "ok",
          image: outcome.frame,
        });
      if (outcome.challenge === undefined) return result;
      return yield* fail(
        yield* (yield* Accounts.Accounts).requestCheck(scope, {
          url: outcome.result.url,
          challenge: outcome.challenge,
          browser: "computer",
        }),
        "capability_denied",
      );
    }),
  ),
});

export const layerShell = Access.toLayer(ComputerShellToolkit, {
  computer_shell: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bot, redact, fail, record, computer } = yield* actor();
      const service = yield* BotSecrets.BotSecrets;
      const secrets = yield* Effect.forEach(input.secrets ?? [], (s) =>
        service
          .forShell(bot, s.secretRef)
          .pipe(Effect.map((value) => ({ env: s.env, value, file: s.file === true }))),
      );
      const line = `$ ${input.command.split("\n")[0]!.slice(0, 200)}`;
      const step = {
        action: "computer_shell",
        ...(secrets.length ? { secret: input.secrets?.map((s) => s.secretRef).join(",") } : {}),
      };
      const result = yield* computer.shell(bot, input, secrets).pipe(
        Effect.tapError((error) =>
          record({ ...step, detail: `${line} · ${error.message}`, status: "failed" }),
        ),
        Effect.mapError((error) => fail(error.message)),
      );
      yield* record({ ...step, detail: `${line} · exit ${result.exitCode}`, status: "ok" });
      return { ...result, output: redact(result.output) };
    }),
  ),
});

export const layerDesktop = Access.toLayer(ComputerDesktopToolkit, {
  computer_desktop: Access.actsAsCaller(({ input }) =>
    Effect.gen(function* () {
      const { bot, redact, fail, record, computer } = yield* actor();
      const result = yield* computer
        .desktop(bot, input)
        .pipe(Effect.mapError((error) => fail(error.message)));
      if (input.action !== "screenshot" && input.action !== "wait")
        yield* record({
          action: `computer_desktop ${input.action}`,
          detail: "text" in input ? `"${input.text}"` : "x" in input ? `${input.x},${input.y}` : "",
          status: "ok",
        });
      return { ...result, url: redact(result.url), title: redact(result.title) };
    }),
  ),
});

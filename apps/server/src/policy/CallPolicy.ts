import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";

/** Outside services that would receive the user's content. */
export type OutsideService = "cloud-speech" | "linked-environment";

/**
 * Each method returns the refusal text, or none to allow the call. `threadId` names the thread a
 * provider session runs; calls outside one (titles, structured output, dreaming) pass none.
 */
export interface CallPolicyShape {
  readonly model: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: string;
    readonly model: string;
    readonly threadId?: ThreadId | undefined;
  }) => Effect.Effect<Option.Option<string>>;
  readonly outside: (service: OutsideService) => Effect.Effect<Option.Option<string>>;
  /**
   * Provider sessions load settings only from their config dir, never from the project they run
   * in, so a model route comes only from sources a policy can read: the instance's environment,
   * the server's, and the config dir.
   */
  readonly settingsPinned: Effect.Effect<boolean>;
}

/** A deployment's entry may provide a policy (see `ServerExtension`); the default refuses nothing. */
export const CallPolicy = Context.Reference<CallPolicyShape>("t3/policy/CallPolicy", {
  defaultValue: () => ({
    model: () => Effect.succeedNone,
    outside: () => Effect.succeedNone,
    settingsPinned: Effect.succeed(false),
  }),
});

export class CallPolicyMissing extends Schema.TaggedError<CallPolicyMissing>()(
  "CallPolicyMissing",
  {
    message: Schema.String,
  },
) {}

const decodeSwitch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ enabled: Schema.Boolean })),
);

/**
 * The policy of a build without one. `<stateDir>/zdr.json` turned on (or unreadable), or the
 * `T3CODE_DEEPSEEK_ONLY=1` model lock, means the instance expects a guard this build does not
 * have, so the server refuses to start rather than call any model.
 */
export const layerDefault = Layer.effect(
  CallPolicy,
  Effect.gen(function* () {
    if ((yield* HostProcess.Environment).T3CODE_DEEPSEEK_ONLY === "1")
      return yield* new CallPolicyMissing({
        message:
          "T3CODE_DEEPSEEK_ONLY=1 locks this instance's models, and this build has no guard for it, so the server does not start. Deploy the build with the guard, or unset the variable.",
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join((yield* ServerConfig.ServerConfig).stateDir, "zdr.json");
    const on = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeSwitch),
      Effect.map((value) => value.enabled),
      Effect.catch((cause) =>
        Effect.succeed(!(cause._tag === "PlatformError" && cause.reason._tag === "NotFound")),
      ),
    );
    if (on)
      return yield* new CallPolicyMissing({
        message: `${file} turns zero data retention on, and this build has no guard for it, so the server does not start. Deploy the build with the guard, or remove ${file}.`,
      });
    return CallPolicy.defaultValue();
  }),
);

import {
  type BotDriverFit,
  type BotReadiness,
  botDriverFit,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import { getOnboardingProviderState } from "../onboarding/providerReadiness.logic";

export interface ProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  /** Set when a bot can run on it now. */
  readonly selection: ModelSelection | null;
  readonly blocker:
    | "signIn"
    | "checking"
    | "attention"
    | "noModel"
    | Exclude<BotDriverFit, "ok">
    | null;
}

/** The installed providers a first run offers for bots, usable ones first. */
export const botProviderChoices = (
  providers: ReadonlyArray<ServerProvider>,
  readiness: Pick<BotReadiness, "sandbox" | "keyedInstances">,
): ReadonlyArray<ProviderChoice> =>
  providers
    .flatMap((provider): ReadonlyArray<ProviderChoice> => {
      const state = getOnboardingProviderState(provider);
      if (state === "disabled" || state === "install") return [];
      const fit = botDriverFit(
        provider.driver,
        readiness.sandbox,
        readiness.keyedInstances.includes(provider.instanceId),
      );
      const model = provider.models[0]?.slug;
      const blocker =
        fit !== "ok" ? fit : state !== "ready" ? state : model === undefined ? "noModel" : null;
      return [
        {
          instanceId: provider.instanceId,
          name: provider.displayName ?? provider.driver,
          selection:
            blocker === null && model !== undefined
              ? { instanceId: provider.instanceId, model }
              : null,
          blocker,
        },
      ];
    })
    .toSorted((a, b) => Number(b.selection !== null) - Number(a.selection !== null));

export const ENDPOINT_INSTANCE_ID = ProviderInstanceId.make("botsEndpoint");
const ANTHROPIC = "https://api.anthropic.com";

/**
 * A Claude Code instance on an Anthropic-compatible endpoint. Anthropic takes its keys as
 * `x-api-key`; other endpoints take a bearer token.
 */
export const endpointInstance = (input: {
  readonly url: string;
  readonly key: string;
  readonly model: string;
}): ProviderInstanceMutation => {
  const url = input.url.trim().replace(/\/+$/, "") || ANTHROPIC;
  return {
    operation: "upsert",
    instanceId: ENDPOINT_INSTANCE_ID,
    instance: {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Bots endpoint",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: url, sensitive: false },
        {
          name: url === ANTHROPIC ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
          value: input.key.trim(),
          sensitive: true,
        },
      ],
      config: { customModels: [input.model.trim()] },
    },
  };
};

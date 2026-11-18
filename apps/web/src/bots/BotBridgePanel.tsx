import {
  BOT_BRIDGE_ENDPOINTS,
  type BotBridgeAuditEntry,
  type BotBridgeRequest,
  type BotBridgeState,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CLI_COMMAND_NAME } from "@t3tools/shared/cliRelease";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { t, uiLocales, type UiText } from "../i18n";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";
import { EMPTY_NOTE, SECTION_HEADER, SHEET_LIST } from "./panelStyles";
import { formatUnlistedModelName } from "../components/chat/providerIconUtils";

// Every bridge write bumps this, so the chat's proposal card and the Bridge sheet both refetch.
let bridgeWrites = 0;
const writeListeners = new Set<() => void>();
const subscribeWrites = (listener: () => void) => {
  writeListeners.add(listener);
  return () => void writeListeners.delete(listener);
};
const readWrites = () => bridgeWrites;
const bridgeWritten = () => {
  bridgeWrites += 1;
  for (const listener of writeListeners) listener();
};

export function useBridgeState(environmentId: EnvironmentId, key: string | null) {
  const [state, setState] = useState<BotBridgeState | null>(null);
  const writes = useSyncExternalStore(subscribeWrites, readWrites, readWrites);
  const fetchKey = key === null ? null : `${key}:${writes}`;
  // A cold start renders the bot chat before the connection is ready; requests wait for it.
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's bridge state; fetchKey marks when it may have changed
  useEffect(() => {
    if (fetchKey === null || !connected) return;
    const controller = new AbortController();
    botRequest(environmentId, BOT_BRIDGE_ENDPOINTS.state, {}, controller.signal).then(
      setState,
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, fetchKey, connected]);
  return state;
}

const clock = (at: string) =>
  new Date(at).toLocaleString(uiLocales, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const STATUS_WORD: Record<BotBridgeAuditEntry["status"], UiText> = {
  ok: "ok",
  refused: "refused",
  failed: "failed",
  pending: "pending",
  approved: "approved",
  denied: "denied",
};

const failed = (error: unknown) =>
  toastManager.add({
    type: "error",
    title: error instanceof Error ? error.message : t("The bridge refused that."),
  });

export const decideProposal = (
  environmentId: EnvironmentId,
  request: BotBridgeRequest,
  approve: boolean,
) =>
  botRequest(environmentId, BOT_BRIDGE_ENDPOINTS.decide, { requestId: request.id, approve })
    .then((settled) => {
      if (settled.status === "failed") failed(new Error(settled.error ?? t("The run failed.")));
    }, failed)
    .finally(bridgeWritten);

export const runModel = (selection: ModelSelection) => {
  const effort =
    getModelSelectionStringOptionValue(selection, "effort") ??
    getModelSelectionStringOptionValue(selection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(selection, "variant");
  // The vendor is implied by the model's own name ("Opus 5.5"), as in a phone's narrow card.
  const model = formatUnlistedModelName(selection.model).replace(/^Claude /, "");
  return effort === undefined ? model : `${model} · ${effort}`;
};

export function BotBridgePanel({ target }: { target: ScopedThreadRef }) {
  const state = useBridgeState(target.environmentId, "");
  if (!state) return <p className="px-4 py-3 text-sm text-muted-foreground">{t("Loading…")}</p>;
  const labels = new Map(state.environments.map((env) => [env.environmentId, env.label]));
  const requests = state.requests.filter((request) => request.botThreadId === target.threadId);
  const pending = requests.filter((request) => request.status === "pending");
  const decided = requests.filter((request) => request.status !== "pending").toReversed();
  const audit = state.audit.filter((entry) => entry.botThreadId === target.threadId).toReversed();

  const grant = (environmentId: EnvironmentId, value: string | undefined) =>
    botRequest(target.environmentId, BOT_BRIDGE_ENDPOINTS.grant, {
      botThreadId: target.threadId,
      environmentId,
      access: value === "read" || value === "operate" ? value : null,
    }).then(bridgeWritten, failed);
  const decide = (request: BotBridgeRequest, approve: boolean) =>
    decideProposal(target.environmentId, request, approve);

  return (
    <div className="text-sm max-md:flex max-md:flex-col max-md:gap-7 max-md:py-3 md:divide-y">
      {pending.map((request) => (
        <Proposal
          key={request.id}
          request={request}
          label={labels.get(request.proposal.environmentId) ?? request.proposal.environmentId}
          onDecide={(approve) => void decide(request, approve)}
        />
      ))}
      {state.environments.length === 0 ? (
        <NoEnvironments />
      ) : (
        state.environments.map((env) => {
          const access =
            state.grants.find(
              (g) => g.botThreadId === target.threadId && g.environmentId === env.environmentId,
            )?.access ?? "none";
          return (
            <div key={env.environmentId} className="flex flex-col gap-1.5 px-4 py-2.5 max-md:p-0">
              <div className="flex items-center justify-between gap-3 max-md:min-h-11 max-md:px-5">
                <span className="truncate font-medium max-md:text-bot-body max-md:font-normal">
                  {env.label}
                </span>
                <ToggleGroup
                  aria-label={t("Bridge access to {environment}", { environment: env.label })}
                  value={[access]}
                  onValueChange={(values) => void grant(env.environmentId, values[0])}
                >
                  <Toggle value="none">{t("None")}</Toggle>
                  <Toggle value="read">{t("Read only")}</Toggle>
                  <Toggle value="operate">{t("Operate")}</Toggle>
                </ToggleGroup>
              </div>
              <div className="text-xs text-muted-foreground max-md:px-5 max-md:text-bot-footnote">
                {env.linkAccess === "read-only"
                  ? t("Read-only link")
                  : t("Link has {access} access; reads are refused until it is linked read-only", {
                      access: env.linkAccess,
                    })}
                {" · "}
                {env.writes ? t("approved runs signed in") : t("approved runs not set up")}
              </div>
            </div>
          );
        })
      )}
      {decided.length > 0 ? (
        <section>
          <h3 className={SECTION_HEADER}>{t("Proposals")}</h3>
          <ul className={SHEET_LIST}>
            {decided.slice(0, 10).map((request) => (
              <HistoryRow
                key={request.id}
                title={request.proposal.kind === "start" ? request.proposal.title : t("Message")}
                meta={[
                  clock(request.decidedAt ?? request.createdAt),
                  t(STATUS_WORD[request.status]),
                  request.error,
                ]}
              />
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className={SECTION_HEADER}>{t("Calls")}</h3>
        <ul aria-label={t("Bridge audit")} className={SHEET_LIST}>
          {audit.length === 0 ? (
            <li className={EMPTY_NOTE}>{t("No bridge calls yet.")}</li>
          ) : (
            audit
              .slice(0, 50)
              .map((entry) => (
                <HistoryRow
                  key={`${entry.at}:${entry.op}:${entry.target}:${entry.status}`}
                  title={`${entry.op} ${entry.target ?? ""}`}
                  meta={[clock(entry.at), t(STATUS_WORD[entry.status]), entry.detail]}
                />
              ))
          )}
        </ul>
      </section>
    </div>
  );
}

function HistoryRow({
  title,
  meta,
}: {
  title: string;
  meta: ReadonlyArray<string | null | undefined>;
}) {
  return (
    <li className="flex flex-col px-4 py-1.5 text-xs max-md:px-5 max-md:py-2.5">
      <span className="truncate max-md:text-bot-body">{title}</span>
      <span className="truncate text-muted-foreground tabular-nums max-md:text-bot-callout">
        {meta.filter(Boolean).join(" · ")}
      </span>
    </li>
  );
}

function Proposal({
  request,
  label,
  onDecide,
}: {
  request: BotBridgeRequest;
  label: string;
  onDecide: (approve: boolean) => void;
}) {
  const { proposal } = request;
  return (
    <div className="flex flex-col gap-2 px-4 py-3 max-md:px-5 max-md:py-0">
      <div className="font-medium max-md:text-bot-body max-md:font-semibold">
        {proposal.kind === "start"
          ? t("Start a thread on {environment}", { environment: label })
          : t("Send to a thread on {environment}", { environment: label })}
      </div>
      <dl className="flex flex-col gap-y-0.5 max-md:gap-0 max-md:text-bot-body md:text-xs">
        {proposal.kind === "start" ? (
          <>
            <Fact
              label={t("Project")}
              // A project on the linked machine may have no title here; its short id fits the row.
              value={request.targetTitle ?? proposal.projectId.slice(0, 8)}
            />
            <Fact label={t("Title")} value={proposal.title} />
            <Fact
              label={t("Model")}
              value={`${proposal.modelSelection.instanceId} / ${runModel(proposal.modelSelection)}`}
            />
          </>
        ) : (
          <Fact label={t("Thread")} value={request.targetTitle ?? proposal.threadId} />
        )}
        <Fact label={t("Mode")} value={t("approval required")} />
      </dl>
      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border p-2 font-mono text-xs max-md:rounded-3xl max-md:border-0 max-md:bg-bot-bubble max-md:px-3.75 max-md:py-2.5 max-md:text-bot-footnote">
        {proposal.prompt}
      </pre>
      <div className="grid grid-cols-2 gap-2">
        <Button size="pill" onClick={() => onDecide(true)}>
          {t("Approve")}
        </Button>
        <Button size="pill" variant="secondary" onClick={() => onDecide(false)}>
          {t("Deny")}
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 max-md:flex max-md:min-h-11 max-md:items-center max-md:justify-between">
      <dt className="text-muted-foreground max-md:shrink-0 max-md:text-foreground">{label}</dt>
      <dd className="truncate max-md:text-end max-md:text-muted-foreground">{value}</dd>
    </div>
  );
}

function NoEnvironments() {
  const [before, after] = t("No linked environments. Link one with {command}.", {
    command: "\u0000",
  }).split("\u0000");
  return (
    <p className="px-4 py-3 text-muted-foreground">
      {before}
      <code className="font-mono text-xs text-foreground">
        {`${CLI_COMMAND_NAME} environment link --access read-only`}
      </code>
      {after}
    </p>
  );
}

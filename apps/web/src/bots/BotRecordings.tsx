import {
  BOTS_ENDPOINTS,
  type BotRecording,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { failed } from "../connections/rows";
import { t, uiLocales } from "../i18n";
import { cn } from "../lib/utils";
import { usePreparedConnection } from "../state/session";
import { botRequest } from "./http";

const seconds = (at: string) =>
  new Date(at).toLocaleTimeString(uiLocales, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export function useBotRecordings(
  environmentId: EnvironmentId,
  botThreadId: ThreadId,
  key: string | null,
) {
  const [recordings, setRecordings] = useState<ReadonlyArray<BotRecording>>([]);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's recordings; key marks a new run
  useEffect(() => {
    if (key === null || !connected) return;
    const controller = new AbortController();
    botRequest(
      environmentId,
      BOTS_ENDPOINTS.recordings,
      { threadId: botThreadId },
      controller.signal,
    ).then(setRecordings, () => undefined);
    return () => controller.abort();
  }, [environmentId, botThreadId, key, connected]);
  return recordings;
}

export function RecordingSteps({
  environmentId,
  botThreadId,
  recording,
}: {
  environmentId: EnvironmentId;
  botThreadId: ThreadId;
  recording: BotRecording;
}) {
  return (
    <ol data-bot-recording className="space-y-1">
      {recording.steps.map((step, index) => (
        <li key={`${step.at}:${step.action}`} className="break-words">
          <span className="text-muted-foreground tabular-nums">{seconds(step.at)}</span>{" "}
          <span className={cn(step.status !== "ok" && "text-destructive-foreground")}>
            {step.action}
            {step.status === "ok" ? "" : ` · ${t(step.status)}`}
          </span>{" "}
          <span className="text-muted-foreground">{step.detail}</span>
          {step.image ? (
            <StepImage
              environmentId={environmentId}
              botThreadId={botThreadId}
              id={recording.id}
              step={index}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function StepImage({
  environmentId,
  botThreadId,
  id,
  step,
}: {
  environmentId: EnvironmentId;
  botThreadId: ThreadId;
  id: string;
  step: number;
}) {
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const toggle = () => {
    setShown(!shown);
    if (image !== undefined) return;
    botRequest(environmentId, BOTS_ENDPOINTS.recordingImage, {
      threadId: botThreadId,
      id,
      step,
    }).then(({ image }) => setImage(image), failed);
  };
  return (
    <>
      <Button size="xs" variant="ghost" className="ms-1" onClick={toggle}>
        {shown ? t("Hide") : t("Screen")}
      </Button>
      {shown && image ? (
        <img src={image} alt="" className="mt-1 max-h-80 max-w-full rounded-md border" />
      ) : shown && image === null ? (
        <span className="text-muted-foreground"> {t("gone")}</span>
      ) : null}
    </>
  );
}

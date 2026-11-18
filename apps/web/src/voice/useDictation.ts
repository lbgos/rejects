import { VOICE_TRANSCRIBE, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useState } from "react";
import { postToEnvironment } from "../bots/http";
import { createDictation, type DictationState } from "./dictation";
import { startRecording } from "./recorder";

const decodeTranscript = Schema.decodeUnknownSync(Schema.fromJsonString(VOICE_TRANSCRIBE.success));

async function transcribe(environmentId: EnvironmentId, audio: Blob, signal: AbortSignal) {
  const response = await postToEnvironment(
    environmentId,
    VOICE_TRANSCRIBE.path,
    { bytes: new Uint8Array(await audio.arrayBuffer()), contentType: audio.type },
    signal,
  );
  return decodeTranscript(response).text;
}

export function useDictation(options: {
  readonly environmentId: EnvironmentId;
  readonly session: string;
  readonly onText: (text: string) => void;
}) {
  const [state, setState] = useState<DictationState>({ status: "idle" });
  const onText = useEffectEvent((text: string) => options.onText(text));
  const [controller, setController] = useState<ReturnType<typeof createDictation> | null>(null);
  const { environmentId, session } = options;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the microphone and the request for this composer session and releases them on cleanup
  useEffect(() => {
    const active = createDictation({
      record: startRecording,
      transcribe: (audio, signal) => transcribe(environmentId, audio, signal),
      onText: (text) => onText(text),
      onState: setState,
      maxSeconds: VOICE_TRANSCRIBE.maxSeconds,
    });
    // oxlint-disable-next-line react/set-state-in-effect -- a new session starts idle, with its own controller
    setState({ status: "idle" });
    setController(active);
    return () => active.dispose();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new composer session drops the recording in progress
  }, [environmentId, session]);
  return {
    state,
    toggle: () => void controller?.toggle(),
    dismiss: () => controller?.dismiss(),
  };
}

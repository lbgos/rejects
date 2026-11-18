import { t } from "../i18n";
import type { Recording, RecordingSource } from "./recorder";

export type DictationState =
  | { readonly status: "idle" }
  | { readonly status: "listening"; readonly startedAt: number; readonly level: () => number }
  | { readonly status: "transcribing" }
  | { readonly status: "error"; readonly message: string };

export function createDictation(options: {
  readonly record: RecordingSource;
  readonly transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  readonly onText: (text: string) => void;
  readonly onState: (state: DictationState) => void;
  readonly maxSeconds: number;
}) {
  let state: DictationState = { status: "idle" };
  let recording: Recording | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let acquiring = false;
  let disposed = false;
  const setState = (next: DictationState) => {
    state = next;
    if (!disposed) options.onState(next);
  };
  const fail = (error: unknown) =>
    setState({
      status: "error",
      message: error instanceof Error ? error.message : t("Dictation failed."),
    });
  const stop = async () => {
    if (acquiring) {
      generation++;
      acquiring = false;
      controller?.abort();
      setState({ status: "idle" });
      return;
    }
    if (state.status !== "listening" || !recording || !controller) return;
    clearTimeout(timer);
    const current = generation;
    const active = recording;
    const signal = controller.signal;
    recording = undefined;
    setState({ status: "transcribing" });
    try {
      const audio = await active.stop();
      if (signal.aborted || disposed) return;
      const text = (await options.transcribe(audio, signal)).trim();
      if (current !== generation || disposed) return;
      if (!text) throw new Error(t("No speech was recognized."));
      options.onText(text);
      setState({ status: "idle" });
    } catch (error) {
      if (current === generation && !disposed) fail(error);
    } finally {
      active.cancel();
    }
  };
  const start = async () => {
    if (disposed || acquiring || state.status === "listening" || state.status === "transcribing")
      return;
    acquiring = true;
    const current = ++generation;
    controller = new AbortController();
    try {
      const active = await options.record(controller.signal);
      if (current !== generation || disposed) {
        active.cancel();
        return;
      }
      recording = active;
      acquiring = false;
      setState({ status: "listening", startedAt: Date.now(), level: active.level });
      timer = setTimeout(() => void stop(), options.maxSeconds * 1000);
    } catch (error) {
      if (current === generation && !disposed) {
        acquiring = false;
        fail(error);
      }
    }
  };
  return {
    toggle: () => (acquiring || state.status === "listening" ? stop() : start()),
    dismiss: () => {
      if (state.status === "error") setState({ status: "idle" });
    },
    dispose: () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      controller?.abort();
      recording?.cancel();
      recording = undefined;
    },
  };
}

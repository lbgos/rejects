import { t } from "../i18n";
export interface Recording {
  readonly stop: () => Promise<Blob>;
  readonly cancel: () => void;
  readonly level: () => number;
}
export type RecordingSource = (signal: AbortSignal) => Promise<Recording>;

/** WebM Opus where the browser has it; iOS Safari records MP4 AAC. The server converts either. */
const FORMATS = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

function describe(error: unknown) {
  if (!(error instanceof DOMException)) return error;
  const message =
    error.name === "NotAllowedError" || error.name === "SecurityError"
      ? t("Microphone access was denied. Allow it in the browser's site settings.")
      : error.name === "NotFoundError"
        ? t("No microphone was found.")
        : error.name === "NotReadableError"
          ? t("The microphone is in use by another app.")
          : null;
  return message ? new Error(message, { cause: error }) : error;
}

function meter(context: AudioContext | undefined, stream: MediaStream) {
  if (!context) return () => 0;
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length);
    };
  } catch {
    return () => 0;
  }
}

export const startRecording: RecordingSource = async (signal) => {
  if (!globalThis.isSecureContext) throw new Error(t("Microphone access requires HTTPS."));
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    throw new Error(t("This browser cannot record audio."));
  // Made and resumed inside the tap, before any await: iOS runs an AudioContext only from a gesture.
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    void context.resume().catch(() => undefined);
  } catch {
    context = undefined;
  }
  let stream: MediaStream | undefined;
  const release = () => {
    signal.removeEventListener("abort", release);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const format = FORMATS.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.addEventListener(
        "stop",
        () => resolve(new Blob(chunks, { type: recorder.mimeType || format || "audio/mp4" })),
        { once: true },
      );
      recorder.addEventListener("error", () => reject(new Error(t("Recording failed."))), {
        once: true,
      });
    });
    finished.catch(() => undefined);
    const level = meter(context, stream);
    recorder.start();
    return {
      level,
      stop: async () => {
        if (recorder.state !== "inactive") recorder.stop();
        try {
          return await finished;
        } finally {
          release();
        }
      },
      cancel: () => {
        chunks.length = 0;
        if (recorder.state !== "inactive") recorder.stop();
        release();
      },
    };
  } catch (error) {
    release();
    throw describe(error);
  }
};

import { describe, expect, it, vi } from "vite-plus/test";
import { createDictation, type DictationState } from "./dictation";
import type { Recording } from "./recorder";

function setup() {
  const states: DictationState[] = [];
  const recording = {
    stop: vi.fn(async () => new Blob(["audio"], { type: "audio/mp4" })),
    cancel: vi.fn(),
    level: () => 0,
  };
  const record = vi.fn(async (_signal: AbortSignal): Promise<Recording> => recording);
  const transcribe = vi.fn(async (_audio: Blob, _signal: AbortSignal) => " Привіт ");
  const onText = vi.fn();
  const controller = createDictation({
    record,
    transcribe,
    onText,
    onState: (state) => states.push(state),
    maxSeconds: 300,
  });
  return { states, recording, record, transcribe, onText, controller };
}

describe("dictation", () => {
  it("records once, transcribes, inserts the text once and releases the microphone", async () => {
    const test = setup();
    await test.controller.toggle();
    await test.controller.toggle();
    expect(test.record).toHaveBeenCalledOnce();
    expect(test.states.map((state) => state.status)).toEqual(["listening", "transcribing", "idle"]);
    expect(test.transcribe.mock.calls[0]?.[0].type).toBe("audio/mp4");
    expect(test.onText).toHaveBeenCalledExactlyOnceWith("Привіт");
    expect(test.recording.cancel).toHaveBeenCalledOnce();
    test.controller.dispose();
  });

  it("stops by itself at the length cap", async () => {
    vi.useFakeTimers();
    const test = setup();
    await test.controller.toggle();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.recording.stop).toHaveBeenCalledOnce();
    expect(test.onText).toHaveBeenCalledOnce();
    test.controller.dispose();
    vi.useRealTimers();
  });

  it("shows the server's error, clears it on dismiss, and listens again on the next tap", async () => {
    const test = setup();
    test.transcribe.mockRejectedValueOnce(
      new Error("Speech recognition is not set up on this server."),
    );
    await test.controller.toggle();
    await test.controller.toggle();
    expect(test.states.at(-1)).toEqual({
      status: "error",
      message: "Speech recognition is not set up on this server.",
    });
    test.controller.dismiss();
    expect(test.states.at(-1)).toEqual({ status: "idle" });
    test.transcribe.mockResolvedValueOnce("  ");
    await test.controller.toggle();
    await test.controller.toggle();
    expect(test.states.at(-1)).toEqual({ status: "error", message: "No speech was recognized." });
    expect(test.onText).not.toHaveBeenCalled();
    test.controller.dispose();
  });

  it("drops a microphone granted after the user cancelled", async () => {
    const test = setup();
    let grant: ((recording: Recording) => void) | undefined;
    test.record.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const starting = test.controller.toggle();
    await test.controller.toggle();
    grant?.(test.recording);
    await starting;
    expect(test.recording.cancel).toHaveBeenCalledOnce();
    expect(test.states).toEqual([{ status: "idle" }]);
    expect(test.transcribe).not.toHaveBeenCalled();
    test.controller.dispose();
  });

  it("ignores a transcript that arrives after the composer is gone", async () => {
    const test = setup();
    let answer: ((text: string) => void) | undefined;
    let asked: (() => void) | undefined;
    const transcribing = new Promise<void>((resolve) => {
      asked = resolve;
    });
    test.transcribe.mockImplementationOnce(() => {
      asked?.();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    await test.controller.toggle();
    const stopping = test.controller.toggle();
    await transcribing;
    test.controller.dispose();
    answer?.("late");
    await stopping;
    expect(test.onText).not.toHaveBeenCalled();
  });
});

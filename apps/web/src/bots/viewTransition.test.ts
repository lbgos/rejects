import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runViewTransition } from "./viewTransition";

function stubEnvironment(input: {
  reducedMotion?: boolean;
  typesSupported?: boolean;
  startViewTransition?: ((arg: unknown) => unknown) | undefined;
}) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query.includes("no-preference") ? !(input.reducedMotion ?? false) : false,
    }),
  });
  vi.stubGlobal("CSS", {
    supports: () => input.typesSupported ?? false,
  });
  vi.stubGlobal(
    "document",
    input.startViewTransition ? { startViewTransition: input.startViewTransition } : {},
  );
}

describe("runViewTransition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the object form when view-transition types are supported", () => {
    const startViewTransition = vi.fn((arg: unknown) => {
      if (typeof arg === "object" && arg !== null && "update" in arg) {
        (arg as { update: () => void }).update();
      }
    });
    stubEnvironment({ typesSupported: true, startViewTransition });
    const update = vi.fn();

    runViewTransition(["bots-push"], update);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(startViewTransition).toHaveBeenCalledWith(
      expect.objectContaining({ types: ["bots-push"], update: expect.any(Function) }),
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("falls back to the callback form when view-transition types are unavailable", () => {
    const startViewTransition = vi.fn((arg: unknown) => {
      if (typeof arg !== "function") throw new TypeError("callback required");
      arg();
    });
    stubEnvironment({ typesSupported: false, startViewTransition });
    const update = vi.fn();

    runViewTransition(["bots-tab"], update);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(startViewTransition).toHaveBeenCalledWith(expect.any(Function));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("falls back to the callback form if the object form throws before running update", () => {
    const startViewTransition = vi.fn((arg: unknown) => {
      if (typeof arg !== "function") throw new TypeError("callback required");
      arg();
    });
    stubEnvironment({ typesSupported: true, startViewTransition });
    const update = vi.fn();

    runViewTransition(["bots-pop"], update);

    expect(startViewTransition).toHaveBeenCalledTimes(2);
    expect(typeof startViewTransition.mock.calls[1]?.[0]).toBe("function");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "no view transitions", startViewTransition: undefined, reducedMotion: false },
    {
      name: "reduced motion",
      startViewTransition: vi.fn(),
      reducedMotion: true,
    },
    {
      name: "startViewTransition throws",
      startViewTransition: vi.fn(() => {
        throw new TypeError("unsupported");
      }),
      reducedMotion: false,
    },
  ])("runs update directly on $name", ({ startViewTransition, reducedMotion }) => {
    stubEnvironment({ typesSupported: false, startViewTransition, reducedMotion });
    const update = vi.fn();

    runViewTransition(["bots-push"], update);

    expect(update).toHaveBeenCalledTimes(1);
  });
});

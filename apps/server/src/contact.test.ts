import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { contact } from "./contact.ts";

const fallback = "https://github.com/lbgos/rejects";

describe("contact", () => {
  it.effect.each([
    { value: "", expected: fallback },
    { value: "contact@example.com", expected: fallback },
    { value: " mailto:contact@example.com ", expected: "mailto:contact@example.com" },
    { value: "https://example.com", expected: "https://example.com" },
  ])("T3CODE_CONTACT=$value reads as $expected", ({ value, expected }) =>
    Effect.gen(function* () {
      expect(yield* contact).toBe(expected);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_CONTACT: value } })),
      ),
    ),
  );
});

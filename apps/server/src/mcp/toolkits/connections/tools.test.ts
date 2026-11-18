import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { ConnectionsToolkit } from "./tools.ts";

it("exports object-root schemas, which MCP requires to register a tool", () => {
  for (const tool of Object.values(ConnectionsToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
  }
});

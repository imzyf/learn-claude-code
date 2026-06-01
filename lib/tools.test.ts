// lib/tools.test.ts - tools.ts 的单元测试
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { textOf, zodTool } from "./tools";

describe("zodTool", () => {
  it("converts a zod schema into a Claude tool definition", () => {
    const tool = zodTool(
      "bash",
      "Run a shell command.",
      z.object({ command: z.string() }),
    );

    expect(tool.name).toBe("bash");
    expect(tool.description).toBe("Run a shell command.");
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.properties).toHaveProperty("command");
    expect(tool.input_schema.required).toContain("command");
  });
});

describe("textOf", () => {
  it("joins all text blocks and ignores other block types", () => {
    const response = {
      content: [
        { type: "text", text: "Hello, " },
        { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        { type: "text", text: "world" },
      ],
    } as Anthropic.Message;

    expect(textOf(response)).toBe("Hello, world");
  });

  it("returns empty string when there is no text block", () => {
    const response = { content: [] } as unknown as Anthropic.Message;
    expect(textOf(response)).toBe("");
  });
});

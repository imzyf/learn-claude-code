// lib/tools.test.ts - tools.ts 的单元测试
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { textOf, zodTool } from "./tools";

describe("zodTool", () => {
  it("将 zod schema 转换为 Claude 工具定义", () => {
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
  it("拼接所有文本块并忽略其他块类型", () => {
    const response = {
      content: [
        { type: "text", text: "Hello, " },
        { type: "tool_use", id: "tu_1", name: "bash", input: {} },
        { type: "text", text: "world" },
      ],
    } as Anthropic.Message;

    expect(textOf(response)).toBe("Hello, world");
  });

  it("没有文本块时返回空字符串", () => {
    const response = { content: [] } as unknown as Anthropic.Message;
    expect(textOf(response)).toBe("[no text in response]");
  });
});

// lib/tools.test.ts - tools.ts 的单元测试
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeMessage, textBlock, toolUseBlock } from "./testing";
import { hasToolUse, textOf, zodTool } from "./tools";

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

describe("hasToolUse", () => {
  it("只看 content 里有没有 tool_use block，不看 stop_reason", () => {
    // stop_reason 说 end_turn，但内容里带着 tool_use：仍要再跑一轮工具。
    expect(
      hasToolUse(fakeMessage([toolUseBlock("t1", "bash", {})], "end_turn")),
    ).toBe(true);
    // 反过来，stop_reason 是 tool_use 而内容里没有工具调用：循环该停。
    expect(hasToolUse(fakeMessage([textBlock("hi")], "tool_use"))).toBe(false);
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

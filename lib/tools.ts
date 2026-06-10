// lib/tools.ts - Claude 工具定义与回复文本解析：LLM 工具层
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { print } from "./terminal";

// zod schema → Claude API 工具定义。
// z.toJSONSchema 产出标准 JSON Schema，符合 input_schema 要求。
export function zodTool(
  name: string,
  description: string,
  schema: z.ZodObject,
): Anthropic.Tool {
  return {
    name,
    description,
    input_schema: z.toJSONSchema(schema) as Anthropic.Tool.InputSchema,
  };
}

// 拼接回复中所有 text block 的内容。
// content 是 block 联合类型数组（text | tool_use | ...），此处只取文字。
// 根据 stop_reason 对空文本或截断结果补上明确信号，避免调用方拿到空字符串。
export function textOf(response: Anthropic.Message): string {
  const text = response.content
    // `b is Anthropic.TextBlock` 是类型谓词：过滤后把联合类型收窄成 TextBlock，
    // 这样下一步 b.text 才合法。
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  switch (response.stop_reason) {
    case "max_tokens":
      return text
        ? `${text}\n[truncated: hit max_tokens]`
        : "[no output: hit max_tokens before the model produced any text]";
    case "refusal":
      return text || "[model declined to respond]";
    case "pause_turn":
      return text || "[paused mid-turn]";
    default:
      return text || "[no text in response]";
  }
}

// 打印助手回复里的自然语言 block（相对 tool_use 而言）：正文 text（green）、
// thinking 推理独白（blue）。tool_use 等其它类型忽略，留给调用方分发。
export function printProse(block: Anthropic.ContentBlock): void {
  if (block.type === "text") {
    const text = block.text.trim();
    if (text) print(text, "green");
  } else if (block.type === "thinking") {
    const text = block.thinking.trim();
    if (text) print(`💭 ${text}`, "blue");
  }
}

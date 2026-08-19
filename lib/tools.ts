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
    .filter((b) => b.type === "text")
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

// 是否还要再跑一轮工具：看响应里有没有真的 tool_use block。
// stop_reason 说的是模型为什么停下，max_tokens 截断时也可能带回 tool_use block。
export function hasToolUse(response: Anthropic.Message): boolean {
  return response.content.some((block) => block.type === "tool_use");
}

// 打印助手回复的各类 block：正文 text（green）、thinking 推理独白（blue）、
// tool_use 工具调用意图 name + input（cyan）。工具的实际执行仍由调用方负责。
// input 只打前 200 字符：write_file 之类的工具参数里带整份文件内容，全量打印会刷屏。
// prefix 标注这几行来自哪个 agent（s06 起主循环之外还有 subagent 在说话，
// 不加前缀两者的输出在终端里分不开）；单 agent 的章节留空即可。
export function printProse(block: Anthropic.ContentBlock, prefix = ""): void {
  if (block.type === "text") {
    const text = block.text.trim();
    if (text) print(`${prefix}🔮 ${text}`, "green");
  } else if (block.type === "thinking") {
    const text = block.thinking.trim();
    if (text) print(`${prefix}💭 ${text}`, "blue");
  } else if (block.type === "tool_use") {
    print(
      `${prefix}🔧 ${block.name}(${preview(JSON.stringify(block.input))})`,
      "cyan",
    );
  }
}

// 超长文本截断到 limit 字符，并标出省略了多少。
export function preview(text: string, limit = 200): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}... (${text.length - limit} more chars)`;
}

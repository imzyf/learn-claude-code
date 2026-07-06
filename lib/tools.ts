import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

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
export function textOf(response: Anthropic.Message): string {
  return (
    response.content
      // `b is Anthropic.TextBlock` 是类型谓词：过滤后把联合类型收窄成 TextBlock，
      // 这样下一步 b.text 才合法。
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
  );
}

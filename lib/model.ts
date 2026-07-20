// lib/model.ts - Claude client 与 model id：agent 的 LLM 接入层
import Anthropic from "@anthropic-ai/sdk";

export const MODEL_ID: string = process.env.MODEL_ID ?? "claude-sonnet-4-6";

// agent 循环只依赖 client 的 messages.create。
// options 只暴露 maxRetries：s11 用 per-request maxRetries: 0 关掉 SDK 内置重试，
// 让自己的重试层成为唯一一层；真实 Anthropic client 接受更宽的 RequestOptions，仍可赋值。
export interface ModelClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { maxRetries?: number },
    ): Promise<Anthropic.Message>;
  };
}

// SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL 环境变量。
// 注意：base URL 不要带 /v1 后缀。
export function createClient(): Anthropic {
  return new Anthropic();
}

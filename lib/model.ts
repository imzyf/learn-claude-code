import Anthropic from "@anthropic-ai/sdk";

// SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL 环境变量。
// 注意：base URL 不要带 /v1 后缀。
export function createClient(): Anthropic {
  return new Anthropic();
}

export const MODEL_ID: string = process.env.MODEL_ID ?? "claude-sonnet-4-6";

// agent 循环只依赖 client 的 messages.create。
export interface ModelClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

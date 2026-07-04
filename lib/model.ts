import Anthropic from "@anthropic-ai/sdk";

// SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL 环境变量。
// 注意：base URL 不要带 /v1 后缀。
export const client = new Anthropic();

export const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-6";

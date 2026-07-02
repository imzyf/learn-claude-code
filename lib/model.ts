import { createAnthropic } from "@ai-sdk/anthropic";

// 环境变量约定沿用 .env.upstream：ANTHROPIC_API_KEY、MODEL_ID，
// 以及可选的 ANTHROPIC_BASE_URL（用于兼容 Anthropic 接口的其他服务商）。
// Anthropic SDK 期望 base URL 不带 /v1，而 AI SDK 的 provider 期望带 /v1，
// 这里统一在末尾拼接 /v1，让两种约定都能兼容。
const baseURL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1`
  : undefined;

export const anthropic = createAnthropic({ baseURL });

export const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-6";

export const model = anthropic(MODEL_ID);

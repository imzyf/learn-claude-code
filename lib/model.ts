import { createAnthropic } from "@ai-sdk/anthropic";

// Env convention follows .env.upstream: ANTHROPIC_API_KEY, MODEL_ID,
// and optional ANTHROPIC_BASE_URL for Anthropic-compatible providers.
// The Anthropic SDK expects a base URL without /v1, while the AI SDK
// provider expects one with /v1 — append it here so both conventions work.
const baseURL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1`
  : undefined;

export const anthropic = createAnthropic({ baseURL });

export const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-6";

export const model = anthropic(MODEL_ID);

/**
 * lib/testing.ts - 各 session 测试共用的桩对象工厂
 *
 * 只被 *.test.ts import，不进入运行时代码。
 */
import { vi, type Mock } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./model";
import type { AgentLogger } from "./logger";

export const noopLogger: AgentLogger = {
  request() {},
  response() {},
  toolResult() {},
};

export function fakeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    container: null,
    content,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

export function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: unknown,
): Anthropic.ToolUseBlock {
  return {
    type: "tool_use",
    id,
    name,
    input,
    caller: { type: "direct" },
  };
}

// create 暴露 mock 本体，供断言调用次数/参数。
export interface FakeClient {
  client: ModelClient;
  create: Mock<ModelClient["messages"]["create"]>;
}

// create 按序弹出预设响应，耗尽则抛错
export function fakeClient(...responses: Anthropic.Message[]): FakeClient {
  const create: FakeClient["create"] = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fake client ran out of responses");
    return next;
  });
  return { client: { messages: { create } }, create };
}

/**
 * lib/testing.ts - 各 session 测试共用的桩对象工厂
 *
 * 只被 *.test.ts import，不进入运行时代码。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, vi } from "vitest";
import type { SessionLogger } from "./logger";
import type { ModelClient } from "./model";

// 工具以 WORKDIR = process.cwd() 为根，临时目录必须建在仓库内。
// 在 baseDir 自己目录下的 .tmp/（已 gitignore）建一个唯一空目录，回传绝对路径。
// baseDir 传 import.meta.dirname；调用方负责清理。
export function makeTempDir(baseDir: string): string {
  const tmpRoot = path.join(baseDir, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  return fs.mkdtempSync(path.join(tmpRoot, "t-"));
}

// 每个用例前 beforeEach 建新目录、afterEach 清理，保证用例间隔离。
// onReady 在目录建好后回传其绝对路径；返回值把目录内文件转成相对 WORKDIR 的路径。
export function useTempDir(
  baseDir: string,
  onReady: (dir: string) => void,
): (name: string) => string {
  let dir = "";
  beforeEach(() => {
    dir = makeTempDir(baseDir);
    onReady(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return (name: string) => path.join(path.relative(process.cwd(), dir), name);
}

export const noopLogger: SessionLogger = {
  request() {},
  response() {},
  toolResult() {},
  console() {},
  config() {},
  section() {},
  userInput() {},
  child() {
    return noopLogger;
  },
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

// 按序弹出预设响应，耗尽则抛错。
// 返回的就是一个 ModelClient；断言时用 vi.mocked(client.messages.create)。
export function fakeClient(...responses: Anthropic.Message[]): ModelClient {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fake client ran out of responses");
    return next;
  });
  return { messages: { create } };
}

/**
 * s11_error_recovery/main.test.ts
 *
 * s11 的新增点是错误恢复层：retryDelay / errorStatus / isPromptTooLongError /
 * reactiveCompact 是纯函数；withRetry 用假 fn 验证瞬时错误退避与非瞬时重抛
 * （用 fake timers 免去真实等待）；agentLoop 用 fake client 走三条恢复路径
 * ——max_tokens 升级/续写、prompt_too_long 应急压缩、不可恢复错误落地。
 * prompt 组装 / context 推导已在 s10 覆盖，这里只验证恢复分支。
 */
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { MODEL_ID, type ModelClient } from "../lib/model";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import type { Context } from "../s10_system_prompt/main";
import {
  agentLoop,
  errorStatus,
  isPromptTooLongError,
  RecoveryState,
  reactiveCompact,
  retryDelay,
  withRetry,
} from "./main";

const memoryIndex = path.join(import.meta.dirname, "nonexistent", "MEMORY.md");

const ctx = (): Context => ({
  enabled_tools: ["bash", "read_file", "write_file"],
  workspace: "/repo",
  memories: "",
});

// status 附带在错误对象上，模拟 Anthropic SDK 的 APIError。
const apiError = (message: string, status?: number): Error =>
  Object.assign(new Error(message), status ? { status } : {});

// 第一次调用抛出 err，之后按序弹出预设响应。fakeClient 不能抛错，故自建。
function throwingThenClient(
  err: unknown,
  ...responses: Anthropic.Message[]
): ModelClient {
  let thrown = false;
  const create = vi.fn(async () => {
    if (!thrown) {
      thrown = true;
      throw err;
    }
    const next = responses.shift();
    if (!next) throw new Error("throwingThenClient ran out of responses");
    return next;
  });
  return { messages: { create } };
}

// ── retryDelay ────────────────────────────────────────────
describe("retryDelay", () => {
  it("prefers Retry-After when provided", () => {
    expect(retryDelay(3, 7)).toBe(7);
  });

  it("grows exponentially with jitter within bounds", () => {
    // attempt 0 -> base 0.5s，jitter 最多 +25%
    const d = retryDelay(0);
    expect(d).toBeGreaterThanOrEqual(0.5);
    expect(d).toBeLessThanOrEqual(0.5 * 1.25);
  });

  it("caps the base at 32s", () => {
    const d = retryDelay(20);
    expect(d).toBeGreaterThanOrEqual(32);
    expect(d).toBeLessThanOrEqual(32 * 1.25);
  });
});

// ── errorStatus ───────────────────────────────────────────
describe("errorStatus", () => {
  it("extracts a numeric status", () => {
    expect(errorStatus(apiError("rate", 429))).toBe(429);
  });

  it("returns undefined when there is no status", () => {
    expect(errorStatus(new Error("plain"))).toBeUndefined();
    expect(errorStatus("just a string")).toBeUndefined();
  });
});

// ── isPromptTooLongError ──────────────────────────────────
describe("isPromptTooLongError", () => {
  it("matches prompt-too-long shapes", () => {
    expect(isPromptTooLongError(new Error("prompt is too long"))).toBe(true);
    expect(isPromptTooLongError(new Error("context_length_exceeded"))).toBe(
      true,
    );
  });

  it("ignores unrelated errors", () => {
    expect(isPromptTooLongError(new Error("bad request"))).toBe(false);
  });
});

// ── reactiveCompact ───────────────────────────────────────
describe("reactiveCompact", () => {
  it("keeps only a notice plus the last five messages", () => {
    const messages: Anthropic.MessageParam[] = Array.from(
      { length: 8 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      }),
    );
    const compacted = reactiveCompact(messages, noopLogger);
    expect(compacted).toHaveLength(6);
    expect(compacted[0].content).toContain("[Reactive compact]");
    expect(compacted[1].content).toBe("m3");
    expect(compacted[5].content).toBe("m7");
  });
});

// ── RecoveryState ─────────────────────────────────────────
describe("RecoveryState", () => {
  it("starts on the primary model with counters at zero", () => {
    const state = new RecoveryState();
    expect(state.currentModel).toBe(MODEL_ID);
    expect(state.hasEscalated).toBe(false);
    expect(state.recoveryCount).toBe(0);
    expect(state.consecutive529).toBe(0);
    expect(state.hasAttemptedReactiveCompact).toBe(false);
  });
});

// ── withRetry ─────────────────────────────────────────────
describe("withRetry", () => {
  it("resets the 529 streak after a success", async () => {
    const state = new RecoveryState();
    state.consecutive529 = 2;
    const result = await withRetry(async () => "ok", state, noopLogger);
    expect(result).toBe("ok");
    expect(state.consecutive529).toBe(0);
  });

  it("rethrows non-transient errors without retrying", async () => {
    const fn = vi.fn(async () => {
      throw apiError("bad request", 400);
    });
    await expect(
      withRetry(fn, new RecoveryState(), noopLogger),
    ).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with backoff, then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw apiError("rate limited", 429);
      return "recovered";
    });
    const p = withRetry(fn, new RecoveryState(), noopLogger);
    await vi.runAllTimersAsync();
    expect(await p).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

// ── agentLoop：三条恢复路径 ────────────────────────────────
describe("agentLoop", () => {
  it("runs a plain tool call and returns the final text", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("escalates max_tokens 8K -> 64K before retrying", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("truncated")], "max_tokens"),
      fakeMessage([textBlock("full answer")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("full answer");
    const calls = vi.mocked(client.messages.create).mock.calls;
    expect(calls[0][0].max_tokens).toBe(8000);
    expect(calls[1][0].max_tokens).toBe(64_000);
    // 升级重试不追加被截断的输出：只有初始 user + 最终 assistant
    expect(messages).toHaveLength(2);
  });

  it("falls back to a continuation prompt when 64K still truncates", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("part 1")], "max_tokens"),
      fakeMessage([textBlock("part 2")], "max_tokens"),
      fakeMessage([textBlock("finished")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("finished");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    const continued = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("Resume"),
    );
    expect(continued).toBe(true);
  });

  it("reactively compacts once on a prompt-too-long error, then recovers", async () => {
    const client = throwingThenClient(
      apiError("prompt is too long", 400),
      fakeMessage([textBlock("recovered")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = Array.from(
      { length: 8 },
      (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      }),
    );

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("recovered");
    // 8 条被压缩成 notice + 尾部 5 条，末尾再追加最终 assistant 回复
    expect(messages[0].content).toContain("[Reactive compact]");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns an error string on an unrecoverable failure", async () => {
    const client = throwingThenClient(apiError("boom", 400));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toContain("[Error]");
    expect(result).toContain("boom");
  });
});

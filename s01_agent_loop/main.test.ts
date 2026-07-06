/**
 * s01_agent_loop/main.test.ts
 *
 * runBash：真实执行 shell，验证拦截 / 输出合并 / 截断 / 超时。
 * agentLoop：用 fake client 按序返回脚本化响应，
 *            验证「text 即停止、tool_use 即执行并回灌」这个核心循环。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { agentLoop, isDangerous, runBash } from "./main";

// ── isDangerous ───────────────────────────────────────────
// 危险字符串只喂给纯函数，永远不会到达真实 shell。
describe("isDangerous", () => {
  it("flags destructive commands", () => {
    expect(isDangerous("rm -rf / --no-preserve-root")).toBe(true);
    expect(isDangerous("sudo ls")).toBe(true);
    expect(isDangerous("shutdown now")).toBe(true);
  });

  it("allows harmless commands", () => {
    expect(isDangerous("echo hi")).toBe(false);
    expect(isDangerous("ls -la")).toBe(false);
  });
});

// ── runBash ───────────────────────────────────────────────
describe("runBash", () => {
  it("blocks before executing", () => {
    // 用无害的哨兵命令验证拦截路径，不把 rm -rf / 交给真实 shell。
    expect(runBash("sudo ls")).toBe("Error: Dangerous command blocked");
  });

  it("returns stdout of a normal command", () => {
    expect(runBash("echo hi")).toBe("hi");
  });

  it("merges stderr into the output", () => {
    expect(runBash("echo err 1>&2")).toBe("err");
  });

  it("returns placeholder when there is no output", () => {
    expect(runBash("true")).toBe("(no output)");
  });

  it("truncates output to 50k characters", () => {
    const out = runBash(`node -e "process.stdout.write('x'.repeat(60000))"`);
    expect(out).toHaveLength(50_000);
  });

  it("reports timeout when the command runs too long", () => {
    expect(runBash("sleep 5", 100)).toMatch(/^Error: Timeout/);
  });
});

// ── agentLoop ─────────────────────────────────────────────
// 桩对象工厂（fakeMessage / fakeClient 等）在 lib/testing.ts，供各 session 测试复用

describe("agentLoop", () => {
  it("returns text and stops when the model does not call a tool", async () => {
    const client = fakeClient(fakeMessage([textBlock("done")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("done");
    // assistant turn 被追加进历史
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
  });

  it("executes a tool call, feeds the result back, then returns final text", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "echo hello" })],
        "tool_use",
      ),
      fakeMessage([textBlock("all done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "run echo" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("all done");
    expect(client.messages.create).toHaveBeenCalledTimes(2);

    // 历史：user → assistant(tool_use) → user(tool_result) → assistant(text)
    expect(messages).toHaveLength(4);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(messages[2].role).toBe("user");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("tu_1");
    expect(toolResults[0].content).toBe("hello"); // 命令被真实执行

    // 第二次 API 调用带上了 tool_result
    const secondCall =
      vi.mocked(client.messages.create).mock.calls.length === 2;
    expect(secondCall).toBe(true);
  });

  it("handles multiple tool calls in one response, in order", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_a", "bash", { command: "echo first" }),
          toolUseBlock("tu_b", "bash", { command: "echo second" }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("ok")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "run both" },
    ];

    await agentLoop(messages, { client, logger: noopLogger });

    // 历史：user → assistant(tool_use ×2) → user(tool_result ×2) → assistant(text)
    // 同一次回复的多个工具，结果合并进 messages[2] 这一条 user 消息，按调用顺序排列
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["tu_a", "tu_b"]);
    expect(toolResults.map((r) => r.content)).toEqual(["first", "second"]);
  });

  it("rejects tool input that does not match the schema", async () => {
    const client = fakeClient(
      fakeMessage(
        // should be `command`
        [toolUseBlock("tu_bad", "bash", { cmd: 1 })],
        "tool_use",
      ),
    );

    await expect(
      agentLoop([{ role: "user", content: "x" }], {
        client,
        logger: noopLogger,
      }),
    ).rejects.toThrow();
  });
});

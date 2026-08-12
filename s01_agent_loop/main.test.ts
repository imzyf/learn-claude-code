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
  it("标记破坏性命令", () => {
    expect(isDangerous("rm -rf / --no-preserve-root")).toBe(true);
    expect(isDangerous("sudo ls")).toBe(true);
    expect(isDangerous("shutdown now")).toBe(true);
  });

  it("允许无害命令", () => {
    expect(isDangerous("echo hi")).toBe(false);
    expect(isDangerous("ls -la")).toBe(false);
  });
});

// ── runBash ───────────────────────────────────────────────
describe("runBash", () => {
  it("在执行前拦截命令", () => {
    // 用无害的哨兵命令验证拦截路径，不把 rm -rf / 交给真实 shell。
    expect(runBash("sudo ls")).toBe("Error: Dangerous command blocked");
  });

  it("返回普通命令的标准输出", () => {
    expect(runBash("echo hi")).toBe("hi");
  });

  it("将标准错误合并到输出中", () => {
    expect(runBash("echo err 1>&2")).toBe("err");
  });

  it("没有输出时返回占位符", () => {
    expect(runBash("true")).toBe("(no output)");
  });

  it("将输出截断为 5 万个字符", () => {
    const out = runBash(`node -e "process.stdout.write('x'.repeat(60000))"`);
    expect(out).toHaveLength(50_000);
  });

  it("命令运行过久时报告超时", () => {
    expect(runBash("sleep 5", 100)).toMatch(/^Error: Timeout/);
  });
});

// ── agentLoop ─────────────────────────────────────────────
// 桩对象工厂（fakeMessage / fakeClient 等）在 lib/testing.ts，供各 session 测试复用

describe("agentLoop", () => {
  it("模型未调用工具时返回文本并停止", async () => {
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

  it("执行工具调用并回传结果，然后返回最终文本", async () => {
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

  it("按顺序处理单次响应中的多个工具调用", async () => {
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

  it("拒绝不符合 schema 的工具输入", async () => {
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

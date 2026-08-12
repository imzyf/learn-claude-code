/**
 * s06_subagent/main.test.ts
 *
 * s06 的新增点是 subagent：spawnSubagent 用全新 messages[] 跑自己的循环，
 * 只把最后一段文本作为摘要返回，中间过程对父 agent 不可见。
 * agentLoop 通过 task 工具分发到 subagent——父子共用同一个注入的 client，
 * fake client 按序弹出「父→子→父」的响应即可验证隔离。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
import { permissionHook } from "../s05_todo_write/main";
import { agentLoop, spawnSubagent } from "./main";

// ── permissionHook ────────────────────────────────────────
describe("permissionHook", () => {
  it("拒绝列表中的 bash 命令", () => {
    expect(
      permissionHook(
        noopLogger,
        toolUseBlock("t", "bash", { command: "sudo x" }),
      ),
    ).toBe("Blocked: 'sudo' is on the deny list");
  });
});

// ── spawnSubagent ─────────────────────────────────────────
describe("spawnSubagent", () => {
  it("返回子 agent 的最终文本", async () => {
    const client = fakeClient(fakeMessage([textBlock("answer")], "end_turn"));

    const result = await spawnSubagent("do x", {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(result).toBe("answer");
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it("返回摘要前运行自己的工具循环", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("s1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("summary")], "end_turn"),
    );

    const result = await spawnSubagent("do x", {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(result).toBe("summary");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("始终未完成时回退为提示消息", async () => {
    // 30 个 tool_use 响应，永不 end_turn → 触发安全上限兜底
    const rounds = Array.from({ length: 30 }, (_, i) =>
      fakeMessage(
        [toolUseBlock(`s${i}`, "bash", { command: "echo x" })],
        "tool_use",
      ),
    );
    const client = fakeClient(...rounds);

    const result = await spawnSubagent("do x", {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(result).toBe(
      "Subagent stopped after 30 turns without a final answer.",
    );
  });
});

// ── agentLoop: task dispatches to a subagent (context isolation) ──
describe("agentLoop", () => {
  it("将 task 工具分发给子 agent 并只保留其摘要", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { prompt: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"), // subagent's own turn
      fakeMessage([textBlock("parent done")], "end_turn"), // parent resumes
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(result).toBe("parent done");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    // 父 agent 只看到 subagent 的最终摘要，看不到它的中间步骤
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });

  it("执行普通工具调用", async () => {
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

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });
});

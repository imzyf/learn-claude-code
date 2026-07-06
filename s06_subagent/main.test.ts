/**
 * s06_subagent/main.test.ts
 *
 * s06 的新增点是 subagent：spawnSubagent 用全新 messages[] 跑自己的循环，
 * 只把最后一段文本作为摘要返回，中间过程对父 agent 不可见。
 * agentLoop 通过 task 工具分发到 subagent——父子共用同一个注入的 client，
 * fake client 按序弹出「父→子→父」的响应即可验证隔离。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import {
  agentLoop,
  clearHooks,
  normalizeTodos,
  permissionHook,
  resetNagCounter,
  runTodoWrite,
  spawnSubagent,
} from "./main";

beforeEach(() => {
  clearHooks();
  resetNagCounter();
});

// ── todo helpers (same as s05) ────────────────────────────
describe("todo helpers", () => {
  it("normalizeTodos accepts an array", () => {
    expect(
      normalizeTodos([{ content: "a", status: "pending" }]).error,
    ).toBeUndefined();
  });

  it("runTodoWrite reports the count", () => {
    expect(runTodoWrite([{ content: "a", status: "pending" }])).toBe(
      "Updated 1 tasks",
    );
  });
});

// ── permissionHook ────────────────────────────────────────
describe("permissionHook", () => {
  it("denies deny-list bash commands", () => {
    expect(
      permissionHook(toolUseBlock("t", "bash", { command: "sudo x" })),
    ).toBe("Permission denied");
  });
});

// ── spawnSubagent ─────────────────────────────────────────
describe("spawnSubagent", () => {
  it("returns the subagent's final text", async () => {
    const client = fakeClient(fakeMessage([textBlock("answer")], "end_turn"));

    const result = await spawnSubagent("do x", { client, logger: noopLogger });

    expect(result).toBe("answer");
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it("runs its own tool loop before returning a summary", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("s1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("summary")], "end_turn"),
    );

    const result = await spawnSubagent("do x", { client, logger: noopLogger });

    expect(result).toBe("summary");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("falls back to a message when it never finishes", async () => {
    // 30 个 tool_use 响应，永不 end_turn → 触发安全上限兜底
    const rounds = Array.from({ length: 30 }, (_, i) =>
      fakeMessage(
        [toolUseBlock(`s${i}`, "bash", { command: "echo x" })],
        "tool_use",
      ),
    );
    const client = fakeClient(...rounds);

    const result = await spawnSubagent("do x", { client, logger: noopLogger });

    expect(result).toMatch(/stopped after 30 turns/);
  });
});

// ── agentLoop: task dispatches to a subagent (context isolation) ──
describe("agentLoop", () => {
  it("dispatches the task tool to a subagent and keeps only its summary", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { description: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"), // subagent's own turn
      fakeMessage([textBlock("parent done")], "end_turn"), // parent resumes
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("parent done");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    // 父 agent 只看到 subagent 的最终摘要，看不到它的中间步骤
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });

  it("executes a plain tool call", async () => {
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

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });
});

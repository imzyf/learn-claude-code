/**
 * s05_todo_write/main.test.ts
 *
 * todo_write 的输入归一化（normalizeTodos）与执行（runTodoWrite）纯逻辑单测。
 * agentLoop 覆盖 s05 的新增点：连续 3 轮没更新 todo 就注入 <reminder>，
 * todo_write 一旦被调用即复位计数器。每个用例各建各的 createHooks(noopLogger)
 * 实例，天然隔离；计数器用 resetNagCounter 复位。
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
import { createHooks } from "../s04_hooks/main";
import {
  agentLoop,
  normalizeTodos,
  permissionHook,
  registerDefaultHooks,
  resetNagCounter,
  runTodoWrite,
} from "./main";

beforeEach(() => {
  resetNagCounter();
});

const todo = (
  content: string,
  status: "pending" | "in_progress" | "completed",
) => ({
  content,
  status,
});

// ── normalizeTodos ────────────────────────────────────────
describe("normalizeTodos", () => {
  it("接受 todo 数组", () => {
    const { todos, error } = normalizeTodos([todo("a", "pending")]);
    expect(error).toBeUndefined();
    expect(todos).toEqual([todo("a", "pending")]);
  });

  it("解包 JSON 数组字符串", () => {
    const { todos } = normalizeTodos(JSON.stringify([todo("b", "completed")]));
    expect(todos).toEqual([todo("b", "completed")]);
  });

  it("拒绝非 JSON 字符串", () => {
    expect(normalizeTodos("not json").error).toMatch(/JSON array string/);
  });

  it("拒绝结构错误的条目", () => {
    expect(normalizeTodos([{ content: "x" }]).error).toMatch(/content, status/);
  });

  it("拒绝无效的状态值", () => {
    expect(
      normalizeTodos([{ content: "x", status: "done" }]).error,
    ).toBeDefined();
  });
});

// ── runTodoWrite ──────────────────────────────────────────
describe("runTodoWrite", () => {
  it("渲染存储的列表及进度行", () => {
    expect(
      runTodoWrite(
        [todo("a", "completed"), todo("b", "in_progress")],
        noopLogger,
      ),
    ).toBe("[x] a\n[>] b\n\n(1/2 completed)");
  });

  it("输入无效时返回错误", () => {
    expect(runTodoWrite("bad", noopLogger)).toMatch(/JSON array string/);
  });

  it("拒绝空白内容", () => {
    expect(runTodoWrite([todo("   ", "pending")], noopLogger)).toBe(
      "Error: todos[0] requires content",
    );
  });

  it("拒绝同时存在两个 in_progress 状态的 todo", () => {
    expect(
      runTodoWrite(
        [todo("a", "in_progress"), todo("b", "in_progress")],
        noopLogger,
      ),
    ).toBe("Error: Only one todo can be in_progress at a time");
  });

  it("拒绝超过 20 个 todo", () => {
    const many = Array.from({ length: 21 }, (_, i) => todo(`t${i}`, "pending"));
    expect(runTodoWrite(many, noopLogger)).toBe("Error: Max 20 todos allowed");
  });
});

// ── permissionHook ────────────────────────────────────────
describe("permissionHook", () => {
  it("拒绝列表中的 bash 命令", () => {
    expect(
      permissionHook(
        noopLogger,
        toolUseBlock("t", "bash", { command: "sudo ls" }),
      ),
    ).toBe("Blocked: 'sudo' is on the deny list");
  });

  it("允许安全命令", () => {
    expect(
      permissionHook(
        noopLogger,
        toolUseBlock("t", "bash", { command: "echo hi" }),
      ),
    ).toBeNull();
  });
});

// ── agentLoop ─────────────────────────────────────────────
describe("agentLoop", () => {
  const bashRound = (cmd: string) =>
    fakeMessage([toolUseBlock("tu", "bash", { command: cmd })], "tool_use");

  it("执行工具并返回最终文本", async () => {
    const hooks = createHooks(noopLogger);
    registerDefaultHooks(hooks);
    const client = fakeClient(
      bashRound("echo hi"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks,
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("通过权限 hook 拦截拒绝列表中的命令", async () => {
    const hooks = createHooks(noopLogger);
    registerDefaultHooks(hooks);
    const client = fakeClient(
      bashRound("sudo rm"),
      fakeMessage([textBlock("stop")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    await agentLoop(messages, { client, logger: noopLogger, hooks });

    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Blocked: 'sudo' is on the deny list");
  });

  it("连续 3 轮工具调用未使用 todo_write 后注入 <reminder>", async () => {
    const hooks = createHooks(noopLogger);
    const client = fakeClient(
      bashRound("echo 1"),
      bashRound("echo 2"),
      bashRound("echo 3"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    await agentLoop(messages, { client, logger: noopLogger, hooks });

    expect(client.messages.create).toHaveBeenCalledTimes(4);
    const reminded = messages.some(
      (m) => m.content === "<reminder>Update your todos.</reminder>",
    );
    expect(reminded).toBe(true);
  });

  it("todo_write 重置计数器后不再提醒", async () => {
    const hooks = createHooks(noopLogger);
    const client = fakeClient(
      bashRound("echo 1"),
      bashRound("echo 2"),
      fakeMessage(
        [
          toolUseBlock("tu", "todo_write", {
            todos: [todo("plan", "in_progress")],
          }),
        ],
        "tool_use",
      ),
      bashRound("echo 3"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    await agentLoop(messages, { client, logger: noopLogger, hooks });

    const reminded = messages.some(
      (m) => m.content === "<reminder>Update your todos.</reminder>",
    );
    expect(reminded).toBe(false);
  });

  it("允许 Stop hook 强制再执行一轮", async () => {
    const hooks = createHooks(noopLogger);
    let fired = false;
    const client = fakeClient(
      fakeMessage([textBlock("first")], "end_turn"),
      fakeMessage([textBlock("second")], "end_turn"),
    );
    // 只挂一个会强制续轮一次的 Stop hook
    hooks.register("Stop", () => {
      if (fired) return null;
      fired = true;
      return "keep going";
    });
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks,
    });

    expect(result).toBe("second");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});

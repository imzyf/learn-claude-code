/**
 * s05_todo_write/main.test.ts
 *
 * todo_write 的输入归一化（normalizeTodos）与执行（runTodoWrite）纯逻辑单测。
 * agentLoop 覆盖 s05 的新增点：连续 3 轮没更新 todo 就往 tool_result 里追加
 * <reminder>，todo_write 一旦被调用即复位计数器。每个用例各建各的
 * createHooks(noopLogger) 实例，计数器随 agentLoop 新建，天然隔离；
 * 只有模块级的 TODO 清单要用 resetTodos 手动复位。
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
  resetTodos,
  runTodoWrite,
} from "./main";

beforeEach(() => {
  resetTodos();
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

  it("拒绝结构错误的条目，并指明是哪一条", () => {
    expect(
      normalizeTodos([todo("ok", "pending"), { content: "x" }]).error,
    ).toBe("todos[1] has invalid status");
  });

  it("拒绝无效的状态值", () => {
    expect(normalizeTodos([{ content: "x", status: "done" }]).error).toBe(
      "todos[0] has invalid status",
    );
  });

  it("拒绝不是对象的条目", () => {
    expect(normalizeTodos(["x"]).error).toBe(
      "todos[0] must be an object with content and status",
    );
  });

  it("拒绝既不是数组也不是字符串的输入", () => {
    expect(normalizeTodos({ content: "x" }).error).toMatch(/content, status/);
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
    ).toBe("Permission denied by deny list");
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
    expect(toolResults[0].content).toBe("Permission denied by deny list");
  });

  // 提醒是挂在 tool_result 那条 user 消息末尾的 text block，不是独立消息。
  const remindedMessages = (messages: Anthropic.MessageParam[]) =>
    messages.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            b.text === "<reminder>Update your todos.</reminder>",
        ),
    );

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
    const reminded = remindedMessages(messages);
    expect(reminded).toHaveLength(1);
    // 和第 3 轮的 tool_result 同处一条消息，不额外制造相邻的 user 消息。
    const blocks = reminded[0].content as Anthropic.ContentBlockParam[];
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(
      messages.some((m, i) => i > 0 && m.role === messages[i - 1].role),
    ).toBe(false);
  });

  it("计数器不跨 agentLoop 调用残留", async () => {
    const hooks = createHooks(noopLogger);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];
    // 第一轮用掉 2 次工具调用（不足以触发提醒）。
    await agentLoop(messages, {
      client: fakeClient(
        bashRound("echo 1"),
        bashRound("echo 2"),
        fakeMessage([textBlock("done")], "end_turn"),
      ),
      logger: noopLogger,
      hooks,
    });
    // 第二轮同样只用 2 次：计数从 0 重新开始，就不该被提醒。
    messages.push({ role: "user", content: "again" });
    await agentLoop(messages, {
      client: fakeClient(
        bashRound("echo 3"),
        bashRound("echo 4"),
        fakeMessage([textBlock("done")], "end_turn"),
      ),
      logger: noopLogger,
      hooks,
    });

    expect(remindedMessages(messages)).toHaveLength(0);
  });

  it("todos 结构非法时返回错误文案，不中断循环", async () => {
    const hooks = createHooks(noopLogger);
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu", "todo_write", { todos: [{ content: "a" }] })],
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
      hooks,
    });

    expect(result).toBe("done");
    // 数组形式的结构错误在 dispatch 处的 schema 校验就被拦下。
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toContain("Invalid option");
  });

  it("todos 是 JSON 字符串时由 TodoManager 校验结构", async () => {
    // string 分支通过 schema，结构错误留到 normalizeTodos 才发现，文案形如
    // `todos[0] has invalid status`——两条路径都不中断循环。
    const hooks = createHooks(noopLogger);
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu", "todo_write", {
            todos: '[{"content": "a"}]',
          }),
        ],
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
      hooks,
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Error: todos[0] has invalid status");
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

    expect(remindedMessages(messages)).toHaveLength(0);
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

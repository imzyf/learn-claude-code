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
  it("accepts an array of todos", () => {
    const { todos, error } = normalizeTodos([todo("a", "pending")]);
    expect(error).toBeUndefined();
    expect(todos).toEqual([todo("a", "pending")]);
  });

  it("unwraps a JSON array string", () => {
    const { todos } = normalizeTodos(JSON.stringify([todo("b", "completed")]));
    expect(todos).toEqual([todo("b", "completed")]);
  });

  it("rejects a non-JSON string", () => {
    expect(normalizeTodos("not json").error).toMatch(/JSON array string/);
  });

  it("rejects items with the wrong shape", () => {
    expect(normalizeTodos([{ content: "x" }]).error).toMatch(/content, status/);
  });

  it("rejects an invalid status value", () => {
    expect(
      normalizeTodos([{ content: "x", status: "done" }]).error,
    ).toBeDefined();
  });
});

// ── runTodoWrite ──────────────────────────────────────────
describe("runTodoWrite", () => {
  it("reports how many tasks were stored", () => {
    expect(
      runTodoWrite(
        [todo("a", "pending"), todo("b", "in_progress")],
        noopLogger,
      ),
    ).toBe("Updated 2 tasks");
  });

  it("returns the error for invalid input", () => {
    expect(runTodoWrite("bad", noopLogger)).toMatch(/JSON array string/);
  });
});

// ── permissionHook ────────────────────────────────────────
describe("permissionHook", () => {
  it("denies deny-list bash commands", () => {
    expect(
      permissionHook(
        noopLogger,
        toolUseBlock("t", "bash", { command: "sudo ls" }),
      ),
    ).toBe("Blocked: 'sudo' is on the deny list");
  });

  it("allows safe commands", () => {
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

  it("executes a tool and returns final text", async () => {
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

  it("blocks deny-list commands via the permission hook", async () => {
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

  it("injects a <reminder> after 3 tool rounds without todo_write", async () => {
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

  it("does not nag when todo_write resets the counter", async () => {
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

  it("lets a Stop hook force another round", async () => {
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

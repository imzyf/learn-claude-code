/**
 * s05_todo_write/main.test.ts
 *
 * todo_write 的输入归一化（normalizeTodos）与执行（runTodoWrite）纯逻辑单测。
 * agentLoop 覆盖 s05 的新增点：连续 3 轮没更新 todo 就注入 <reminder>，
 * todo_write 一旦被调用即复位计数器。hooks 用 clearHooks 隔离，
 * 计数器用 resetNagCounter 复位。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
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
  registerDefaultHooks,
  registerHook,
  resetNagCounter,
  runTodoWrite,
} from "./main";

beforeEach(() => {
  clearHooks();
  resetNagCounter();
});

const todo = (content: string, status: "pending" | "in_progress" | "completed") => ({
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
    expect(normalizeTodos([{ content: "x", status: "done" }]).error).toBeDefined();
  });
});

// ── runTodoWrite ──────────────────────────────────────────
describe("runTodoWrite", () => {
  it("reports how many tasks were stored", () => {
    expect(runTodoWrite([todo("a", "pending"), todo("b", "in_progress")])).toBe(
      "Updated 2 tasks",
    );
  });

  it("returns the error for invalid input", () => {
    expect(runTodoWrite("bad")).toMatch(/JSON array string/);
  });
});

// ── permissionHook ────────────────────────────────────────
describe("permissionHook", () => {
  it("denies deny-list bash commands", () => {
    expect(permissionHook(toolUseBlock("t", "bash", { command: "sudo ls" }))).toBe(
      "Permission denied",
    );
  });

  it("allows safe commands", () => {
    expect(permissionHook(toolUseBlock("t", "bash", { command: "echo hi" }))).toBeNull();
  });
});

// ── agentLoop ─────────────────────────────────────────────
describe("agentLoop", () => {
  const bashRound = (cmd: string) =>
    fakeMessage([toolUseBlock("tu", "bash", { command: cmd })], "tool_use");

  it("executes a tool and returns final text", async () => {
    registerDefaultHooks();
    const client = fakeClient(bashRound("echo hi"), fakeMessage([textBlock("done")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("blocks deny-list commands via the permission hook", async () => {
    registerDefaultHooks();
    const client = fakeClient(bashRound("sudo rm"), fakeMessage([textBlock("stop")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];

    await agentLoop(messages, { client, logger: noopLogger });

    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied");
  });

  it("injects a <reminder> after 3 tool rounds without todo_write", async () => {
    const client = fakeClient(
      bashRound("echo 1"),
      bashRound("echo 2"),
      bashRound("echo 3"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];

    await agentLoop(messages, { client, logger: noopLogger });

    expect(client.messages.create).toHaveBeenCalledTimes(4);
    const reminded = messages.some(
      (m) => m.content === "<reminder>Update your todos.</reminder>",
    );
    expect(reminded).toBe(true);
  });

  it("does not nag when todo_write resets the counter", async () => {
    const client = fakeClient(
      bashRound("echo 1"),
      bashRound("echo 2"),
      fakeMessage(
        [toolUseBlock("tu", "todo_write", { todos: [todo("plan", "in_progress")] })],
        "tool_use",
      ),
      bashRound("echo 3"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];

    await agentLoop(messages, { client, logger: noopLogger });

    const reminded = messages.some(
      (m) => m.content === "<reminder>Update your todos.</reminder>",
    );
    expect(reminded).toBe(false);
  });

  it("lets a Stop hook force another round", async () => {
    let fired = false;
    const client = fakeClient(
      fakeMessage([textBlock("first")], "end_turn"),
      fakeMessage([textBlock("second")], "end_turn"),
    );
    // 只挂一个会强制续轮一次的 Stop hook
    registerHook("Stop", () => {
      if (fired) return null;
      fired = true;
      return "keep going";
    });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("second");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });
});

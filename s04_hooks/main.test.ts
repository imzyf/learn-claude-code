/**
 * s04_hooks/main.test.ts
 *
 * Hook 注册表（registerHook / triggerHooks）的核心语义：按序执行、
 * 第一个非 null 返回值即中断。permissionHook 通过工厂注入 Confirm，
 * 测试用 fake 确认函数覆盖 allow / deny，无需真实 stdin。
 * clearHooks 在每个用例前重置全局注册表，隔离用例。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import {
  agentLoop,
  type Confirm,
  clearHooks,
  contextInjectHook,
  largeOutputHook,
  logHook,
  makePermissionHook,
  registerHook,
  summaryHook,
  triggerHooks,
} from "./main";

const grant: Confirm = async () => true;
const refuse: Confirm = async () => false;

beforeEach(() => {
  clearHooks();
});

// ── registry: registerHook / triggerHooks ─────────────────
describe("triggerHooks", () => {
  it("returns null when every hook returns null", async () => {
    registerHook("PreToolUse", () => null);
    registerHook("PreToolUse", () => null);
    expect(await triggerHooks("PreToolUse", {})).toBeNull();
  });

  it("returns the first non-null result and stops there", async () => {
    const first = vi.fn(() => null);
    const blocking = vi.fn(() => "blocked");
    const after = vi.fn(() => "never");
    registerHook("PreToolUse", first);
    registerHook("PreToolUse", blocking);
    registerHook("PreToolUse", after);

    expect(await triggerHooks("PreToolUse", {})).toBe("blocked");
    expect(first).toHaveBeenCalledOnce();
    expect(blocking).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled(); // short-circuited
  });

  it("awaits async hooks", async () => {
    registerHook("PreToolUse", async () => "async-block");
    expect(await triggerHooks("PreToolUse", {})).toBe("async-block");
  });
});

// ── makePermissionHook (via injected Confirm) ─────────────
describe("makePermissionHook", () => {
  const bash = (command: string) => toolUseBlock("t", "bash", { command });

  it("blocks deny-list commands without asking", async () => {
    const confirm = vi.fn(grant);
    const hook = makePermissionHook(confirm);
    expect(await hook(bash("sudo ls"))).toBe("Permission denied by deny list");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks on destructive commands and allows when confirmed", async () => {
    const hook = makePermissionHook(grant);
    expect(await hook(bash("rm foo"))).toBeNull();
  });

  it("asks on destructive commands and denies when refused", async () => {
    const hook = makePermissionHook(refuse);
    expect(await hook(bash("rm foo"))).toBe("Permission denied by user");
  });

  it("asks before writing outside the workspace", async () => {
    const hook = makePermissionHook(refuse);
    const call = toolUseBlock("t", "write_file", {
      path: "../escape.txt",
      content: "x",
    });
    expect(await hook(call)).toBe("Permission denied by user");
  });

  it("does not ask for a safe command", async () => {
    const confirm = vi.fn(grant);
    const hook = makePermissionHook(confirm);
    expect(await hook(bash("echo hi"))).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ── pure hooks ────────────────────────────────────────────
describe("pure hooks return null (non-blocking)", () => {
  const call = toolUseBlock("t", "bash", { command: "echo hi" });

  it("logHook", () => {
    expect(logHook(call)).toBeNull();
  });

  it("largeOutputHook", () => {
    expect(largeOutputHook(call, "small")).toBeNull();
    expect(largeOutputHook(call, "x".repeat(200_000))).toBeNull();
  });

  it("contextInjectHook", () => {
    expect(contextInjectHook("hello")).toBeNull();
  });

  it("summaryHook", () => {
    expect(summaryHook([])).toBeNull();
  });
});

// ── agentLoop: hooks wired into the loop ──────────────────
describe("agentLoop", () => {
  it("blocks a tool call when a PreToolUse hook returns a message", async () => {
    registerHook("PreToolUse", makePermissionHook(grant));
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "sudo ls" })],
        "tool_use",
      ),
      fakeMessage([textBlock("stopped")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("stopped");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied by deny list");
  });

  it("runs PostToolUse after a tool executes", async () => {
    const post = vi.fn(() => null);
    registerHook("PostToolUse", post);
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
    expect(post).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("lets a Stop hook force another round", async () => {
    let fired = false;
    registerHook("Stop", () => {
      if (fired) return null;
      fired = true;
      return "keep going"; // 第一次强制续一轮，第二次放行
    });
    const client = fakeClient(
      fakeMessage([textBlock("first")], "end_turn"),
      fakeMessage([textBlock("second")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("second");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    // Stop hook 的返回值作为一条 user 消息注入，触发了续轮
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("keep going");
  });
});

/**
 * s04_hooks/main.test.ts
 *
 * Hook 注册表（hooks.register / hooks.trigger）的核心语义：按序执行、
 * 第一个非 null 返回值即中断，triggerSkippingPermission 只跳过 permissionHook。
 * permissionHook 通过工厂注入 Confirm，测试用 fake 确认函数覆盖 allow / deny，
 * 无需真实 stdin。
 * 每个用例各建各的 createHooks(noopLogger) 实例，天然隔离。
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
import type { Confirm } from "../s03_permission/main";
import {
  agentLoop,
  contextInjectHook,
  createHooks,
  largeOutputHook,
  logHook,
  makePermissionHook,
  summaryHook,
} from "./main";

const grant: Confirm = async () => true;
const refuse: Confirm = async () => false;

// ── registry: hooks.register / hooks.trigger ──────────────
describe("hooks.trigger", () => {
  it("所有 hook 都返回 null 时返回 null", async () => {
    const hooks = createHooks(noopLogger);
    hooks.register("PreToolUse", () => null);
    hooks.register("PreToolUse", () => null);
    expect(await hooks.trigger("PreToolUse", {})).toBeNull();
  });

  it("返回第一个非 null 结果并停止", async () => {
    const hooks = createHooks(noopLogger);
    const first = vi.fn(() => null);
    const blocking = vi.fn(() => "blocked");
    const after = vi.fn(() => "never");
    hooks.register("PreToolUse", first);
    hooks.register("PreToolUse", blocking);
    hooks.register("PreToolUse", after);

    expect(await hooks.trigger("PreToolUse", {})).toBe("blocked");
    expect(first).toHaveBeenCalledOnce();
    expect(blocking).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled(); // short-circuited
  });

  it("等待异步 hook 完成", async () => {
    const hooks = createHooks(noopLogger);
    hooks.register("PreToolUse", async () => "async-block");
    expect(await hooks.trigger("PreToolUse", {})).toBe("async-block");
  });

  it("triggerSkippingPermission 跳过 permissionHook，其余照常跑", async () => {
    const hooks = createHooks(noopLogger);
    const confirm = vi.fn(refuse);
    const other = vi.fn(() => null);
    hooks.register("PreToolUse", makePermissionHook(confirm));
    hooks.register("PreToolUse", other);
    // rm 会命中破坏性命令规则：permissionHook 跑起来就会问 confirm 并拦截。
    const call = toolUseBlock("t", "bash", { command: "rm notes.txt" });

    expect(
      await hooks.triggerSkippingPermission("PreToolUse", call),
    ).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();

    // 普通 trigger 仍然会问、会拦。
    expect(await hooks.trigger("PreToolUse", call)).toBe(
      "Permission denied by user",
    );
    expect(confirm).toHaveBeenCalledOnce();
  });
});

// ── makePermissionHook (via injected Confirm) ─────────────
describe("makePermissionHook", () => {
  const bash = (command: string) => toolUseBlock("t", "bash", { command });

  it("无需询问便拦截拒绝列表中的命令", async () => {
    const confirm = vi.fn(grant);
    const hook = makePermissionHook(confirm);
    expect(await hook(noopLogger, bash("sudo ls"))).toBe(
      "Permission denied by deny list",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("遇到破坏性命令时询问并在确认后允许", async () => {
    const hook = makePermissionHook(grant);
    expect(await hook(noopLogger, bash("rm foo"))).toBeNull();
  });

  it("遇到破坏性命令时询问并在拒绝后拦截", async () => {
    const hook = makePermissionHook(refuse);
    expect(await hook(noopLogger, bash("rm foo"))).toBe(
      "Permission denied by user",
    );
  });

  it("写入工作区外部前先询问", async () => {
    const hook = makePermissionHook(refuse);
    const call = toolUseBlock("t", "write_file", {
      path: "../escape.txt",
      content: "x",
    });
    expect(await hook(noopLogger, call)).toBe("Permission denied by user");
  });

  it("读取工作区外部内容前先询问", async () => {
    const hook = makePermissionHook(refuse);
    const call = toolUseBlock("t", "read_file", { path: "/etc/passwd" });
    expect(await hook(noopLogger, call)).toBe("Permission denied by user");
  });

  it("安全命令无需询问", async () => {
    const confirm = vi.fn(grant);
    const hook = makePermissionHook(confirm);
    expect(await hook(noopLogger, bash("echo hi"))).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ── pure hooks ────────────────────────────────────────────
describe("pure hooks return null (non-blocking)", () => {
  const call = toolUseBlock("t", "bash", { command: "echo hi" });

  it("执行日志 hook", () => {
    expect(logHook(noopLogger, call)).toBeNull();
  });

  it("执行大输出 hook", () => {
    expect(largeOutputHook(noopLogger, call, "small")).toBeNull();
    expect(largeOutputHook(noopLogger, call, "x".repeat(200_000))).toBeNull();
  });

  it("执行上下文注入 hook", () => {
    expect(contextInjectHook(noopLogger, "hello")).toBeNull();
  });

  it("执行摘要 hook", () => {
    expect(summaryHook(noopLogger, [])).toBeNull();
  });
});

// ── agentLoop: hooks wired into the loop ──────────────────
describe("agentLoop", () => {
  it("PreToolUse hook 返回消息时拦截工具调用", async () => {
    const hooks = createHooks(noopLogger);
    hooks.register("PreToolUse", makePermissionHook(grant));
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

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks,
    });

    expect(result).toBe("stopped");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied by deny list");
  });

  it("工具执行后运行 PostToolUse", async () => {
    const hooks = createHooks(noopLogger);
    const post = vi.fn(() => null);
    hooks.register("PostToolUse", post);
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
      hooks,
    });

    expect(result).toBe("done");
    expect(post).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("允许 Stop hook 强制再执行一轮", async () => {
    const hooks = createHooks(noopLogger);
    let fired = false;
    hooks.register("Stop", () => {
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

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks,
    });

    expect(result).toBe("second");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    // Stop hook 的返回值作为一条 user 消息注入，触发了续轮
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("keep going");
  });
});

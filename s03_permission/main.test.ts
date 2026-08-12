/**
 * s03_permission/main.test.ts
 *
 * 三道关卡各自的纯逻辑（checkDenyList / checkRules）直接单测。
 * checkPermission / agentLoop 把「问用户」抽象成注入的 Confirm，
 * 测试用 fake 版本模拟 allow / deny，无需真实 stdin。
 * makeConfirm 的自记日志用 fake readline 单独覆盖。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
  useTempDir,
} from "../lib/testing";
import {
  agentLoop,
  type Confirm,
  checkDenyList,
  checkPermission,
  checkRules,
  makeConfirm,
} from "./main";

let tmp: string;
const rel = useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

const grant: Confirm = async () => true;
const refuse: Confirm = async () => false;

// ── Gate 1: checkDenyList ─────────────────────────────────
describe("checkDenyList", () => {
  it("拦截拒绝列表中的命令", () => {
    expect(checkDenyList("sudo rm x")).toMatch(/deny list/);
    expect(checkDenyList("rm -rf / now")).toMatch(/deny list/);
  });

  it("安全命令返回 null", () => {
    expect(checkDenyList("echo hi")).toBeNull();
  });
});

// ── Gate 2: checkRules ────────────────────────────────────
describe("checkRules", () => {
  it("标记所有访问工作区外部的文件工具", () => {
    expect(checkRules("write_file", { path: "../escape.txt" })).toBe(
      "Access outside workspace",
    );
    expect(checkRules("edit_file", { path: "/etc/hosts" })).toBe(
      "Access outside workspace",
    );
    expect(checkRules("read_file", { path: "/etc/passwd" })).toBe(
      "Access outside workspace",
    );
  });

  it("允许工作区内的文件工具", () => {
    expect(checkRules("write_file", { path: "sub/ok.txt" })).toBeNull();
    expect(checkRules("read_file", { path: "sub/ok.txt" })).toBeNull();
  });

  it("标记可能具有破坏性的 bash 命令", () => {
    expect(checkRules("bash", { command: "rm foo" })).toBe(
      "Potentially destructive command",
    );
    expect(checkRules("bash", { command: "chmod 777 x" })).toBe(
      "Potentially destructive command",
    );
  });

  it("安全的 bash 命令返回 null", () => {
    expect(checkRules("bash", { command: "echo hi" })).toBeNull();
  });

  it("没有匹配规则的工具返回 null", () => {
    expect(checkRules("glob", { pattern: "**/*.ts" })).toBeNull();
  });
});

// ── Gate pipeline: checkPermission ────────────────────────
describe("checkPermission", () => {
  const bash = (command: string) => toolUseBlock("t", "bash", { command });

  it("无需询问用户便拒绝列表中的命令", async () => {
    const ask = vi.fn(grant);
    expect(await checkPermission(bash("sudo ls"), ask, noopLogger)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("规则匹配时询问用户并遵循允许决定", async () => {
    const ask = vi.fn(grant);
    expect(await checkPermission(bash("rm foo"), ask, noopLogger)).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      bash("rm foo"),
      "Potentially destructive command",
    );
  });

  it("规则匹配时询问用户并遵循拒绝决定", async () => {
    const ask = vi.fn(refuse);
    expect(await checkPermission(bash("rm foo"), ask, noopLogger)).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("无需询问便允许安全命令", async () => {
    const ask = vi.fn(grant);
    expect(await checkPermission(bash("echo hi"), ask, noopLogger)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("将拒绝列表拦截记录为权限拒绝", async () => {
    const logger = { ...noopLogger, section: vi.fn() };
    await checkPermission(bash("sudo ls"), vi.fn(grant), logger);
    expect(logger.section).toHaveBeenCalledWith(
      "PERMISSION",
      expect.stringMatching(
        /deny list[\s\S]*Tool: bash\({"command":"sudo ls"}\)[\s\S]*Decision: deny/,
      ),
    );
  });

  // 规则匹配时的放行/拦截日志由 confirm 自己负责（见 makeConfirm），
  // 注入 fake confirm 的 checkPermission 不再记这条。
  it("不记录规则路径本身（该日志由 confirm 负责）", async () => {
    const logger = { ...noopLogger, section: vi.fn() };
    await checkPermission(bash("rm foo"), vi.fn(refuse), logger);
    expect(logger.section).not.toHaveBeenCalled();
  });

  it("没有触发权限门禁时不记录日志", async () => {
    const logger = { ...noopLogger, section: vi.fn() };
    await checkPermission(bash("echo hi"), vi.fn(grant), logger);
    expect(logger.section).not.toHaveBeenCalled();
  });
});

// ── makeConfirm: 自记日志的真实确认实现 ────────────────────
describe("makeConfirm", () => {
  const call = toolUseBlock("t", "bash", { command: "rm foo" });
  const fakeRl = (answer: string) =>
    ({ question: async () => answer }) as unknown as readline.Interface;

  it("用户同意时返回 true 并记录允许日志", async () => {
    const logger = { ...noopLogger, section: vi.fn() };
    const confirm = makeConfirm(fakeRl("y"), logger);
    expect(await confirm(call, "danger")).toBe(true);
    expect(logger.section).toHaveBeenCalledWith(
      "PERMISSION",
      'danger\nTool: bash({"command":"rm foo"})\nDecision: allow',
    );
  });

  it("用户拒绝时返回 false 并记录拒绝日志", async () => {
    const logger = { ...noopLogger, section: vi.fn() };
    const confirm = makeConfirm(fakeRl("n"), logger);
    expect(await confirm(call, "danger")).toBe(false);
    expect(logger.section).toHaveBeenCalledWith(
      "PERMISSION",
      'danger\nTool: bash({"command":"rm foo"})\nDecision: deny',
    );
  });
});

// ── agentLoop: permission wired into the loop ─────────────
describe("agentLoop", () => {
  it("拒绝执行拒绝列表中的工具调用", async () => {
    const ask = vi.fn(grant);
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
      confirm: ask,
    });

    expect(result).toBe("stopped");
    expect(ask).not.toHaveBeenCalled();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied by rule or user.");
  });

  it("用户拒绝时不执行匹配规则的调用", async () => {
    const ask = vi.fn(refuse);
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "write_file", {
            path: "../escape.txt",
            content: "x",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("ok")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    await agentLoop(messages, { client, logger: noopLogger, confirm: ask });

    expect(ask).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied by rule or user.");
    // 越界写入被拦下，文件没有真的创建
    expect(fs.existsSync(path.join(process.cwd(), "escape.txt"))).toBe(false);
  });

  it("无需询问便执行安全工具", async () => {
    const ask = vi.fn(grant);
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
      confirm: ask,
    });

    expect(result).toBe("done");
    expect(ask).not.toHaveBeenCalled();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("用户允许后执行匹配规则的调用", async () => {
    fs.writeFileSync(path.join(tmp, "perm.txt"), "x");
    const ask = vi.fn(grant);
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "bash", {
            command: `chmod 777 ${rel("perm.txt")}`,
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
      confirm: ask,
    });

    expect(result).toBe("done");
    expect(ask).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("(no output)"); // chmod 成功执行
  });
});

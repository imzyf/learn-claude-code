/**
 * s03_permission/main.test.ts
 *
 * 三道关卡各自的纯逻辑（checkDenyList / checkRules）直接单测。
 * checkPermission / agentLoop 把「问用户」抽象成注入的 AskUser，
 * 测试用 fake 版本模拟 allow / deny，无需真实 stdin。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  checkDenyList,
  checkPermission,
  checkRules,
  type AskUser,
} from "./main";

// 工具以 WORKDIR = process.cwd() 为根，临时目录必须建在仓库内。
// 统一放在 .tmp/（已 gitignore）下，各 session 的测试共用这个约定。
let tmp: string;
let rel: (name: string) => string;

beforeAll(() => {
  fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
  tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp", "s03-"));
  rel = (name) => path.join(path.relative(process.cwd(), tmp), name);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const allow: AskUser = async () => "allow";
const deny: AskUser = async () => "deny";

// ── Gate 1: checkDenyList ─────────────────────────────────
describe("checkDenyList", () => {
  it("blocks commands on the deny list", () => {
    expect(checkDenyList("sudo rm x")).toMatch(/deny list/);
    expect(checkDenyList("rm -rf / now")).toMatch(/deny list/);
  });

  it("returns null for a safe command", () => {
    expect(checkDenyList("echo hi")).toBeNull();
  });
});

// ── Gate 2: checkRules ────────────────────────────────────
describe("checkRules", () => {
  it("flags writing outside the workspace", () => {
    expect(checkRules("write_file", { path: "../escape.txt" })).toBe(
      "Writing outside workspace",
    );
    expect(checkRules("edit_file", { path: "/etc/hosts" })).toBe(
      "Writing outside workspace",
    );
  });

  it("allows writing inside the workspace", () => {
    expect(checkRules("write_file", { path: "sub/ok.txt" })).toBeNull();
  });

  it("flags potentially destructive bash commands", () => {
    expect(checkRules("bash", { command: "rm foo" })).toBe(
      "Potentially destructive command",
    );
    expect(checkRules("bash", { command: "chmod 777 x" })).toBe(
      "Potentially destructive command",
    );
  });

  it("returns null for a safe bash command", () => {
    expect(checkRules("bash", { command: "echo hi" })).toBeNull();
  });

  it("returns null for tools with no matching rule", () => {
    expect(checkRules("read_file", { path: "anything" })).toBeNull();
  });
});

// ── Gate pipeline: checkPermission ────────────────────────
describe("checkPermission", () => {
  const bash = (command: string) => toolUseBlock("t", "bash", { command });

  it("denies deny-list commands without asking the user", async () => {
    const ask = vi.fn(allow);
    expect(await checkPermission(bash("sudo ls"), ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks the user when a rule matches, and honors allow", async () => {
    const ask = vi.fn(allow);
    expect(await checkPermission(bash("rm foo"), ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      "bash",
      { command: "rm foo" },
      "Potentially destructive command",
    );
  });

  it("asks the user when a rule matches, and honors deny", async () => {
    const ask = vi.fn(deny);
    expect(await checkPermission(bash("rm foo"), ask)).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("allows a safe command without asking", async () => {
    const ask = vi.fn(allow);
    expect(await checkPermission(bash("echo hi"), ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

// ── agentLoop: permission wired into the loop ─────────────
describe("agentLoop", () => {
  it("denies a deny-list tool call without executing it", async () => {
    const ask = vi.fn(allow);
    const { client } = fakeClient(
      fakeMessage([toolUseBlock("tu_1", "bash", { command: "sudo ls" })], "tool_use"),
      fakeMessage([textBlock("stopped")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      askUser: ask,
    });

    expect(result).toBe("stopped");
    expect(ask).not.toHaveBeenCalled();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied.");
  });

  it("denies a rule-matched call when the user says no", async () => {
    const ask = vi.fn(deny);
    const { client } = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "write_file", { path: "../escape.txt", content: "x" })],
        "tool_use",
      ),
      fakeMessage([textBlock("ok")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    await agentLoop(messages, { client, logger: noopLogger, askUser: ask });

    expect(ask).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Permission denied.");
    // 越界写入被拦下，文件没有真的创建
    expect(fs.existsSync(path.join(process.cwd(), "escape.txt"))).toBe(false);
  });

  it("executes a safe tool without asking", async () => {
    const ask = vi.fn(allow);
    const { client } = fakeClient(
      fakeMessage([toolUseBlock("tu_1", "bash", { command: "echo hi" })], "tool_use"),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      askUser: ask,
    });

    expect(result).toBe("done");
    expect(ask).not.toHaveBeenCalled();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("executes a rule-matched call after the user allows it", async () => {
    fs.writeFileSync(path.join(tmp, "perm.txt"), "x");
    const ask = vi.fn(allow);
    const { client } = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: `chmod 777 ${rel("perm.txt")}` })],
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
      askUser: ask,
    });

    expect(result).toBe("done");
    expect(ask).toHaveBeenCalledOnce();
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("(no output)"); // chmod 成功执行
  });
});

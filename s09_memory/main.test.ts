/**
 * s09_memory/main.test.ts
 *
 * s09 只新增记忆系统，其余（工具表 / hook / nag / 技能层 / 压缩）整套沿用 s07/s08
 * 的装配，由各自的测试覆盖。这里聚焦记忆函数：接受目录参数，指向临时目录读写真实文件验证往返；
 * selectRelevantMemories 用 fake client 走 LLM 挑选，client 抛错时回退关键词匹配。
 * agentLoop 指向空的临时记忆目录：loadMemories 无文件即短路，末尾 extractMemories
 * 收到 "[]" 不写盘。
 */
import * as fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
  useTempDir,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
// nag 计数器是 s05 的模块级状态，每个测试前复位（同 s08 的做法）。
import { resetNagCounter } from "../s05_todo_write/main";
import {
  agentLoop,
  listMemoryFiles,
  memoryFilenames,
  messageText,
  readMemoryFile,
  readMemoryIndex,
  selectRelevantMemories,
  writeMemoryFile,
} from "./main";

let tmp = "";

useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

beforeEach(() => {
  resetNagCounter();
});

// 记忆函数与 agentLoop 共用 s06 的 Deps（client + logger + hooks）；测试用裸 hook 实例。
const baseDeps = () => ({
  logger: noopLogger,
  hooks: createHooks(noopLogger),
});

// ── parseFrontmatter / messageText (pure) ─────────────────
describe("pure helpers", () => {
  it("messageText reads string content and text blocks", () => {
    expect(messageText({ role: "user", content: "plain" })).toBe("plain");
    expect(
      messageText({
        role: "assistant",
        content: [textBlock("a"), textBlock("b")],
      }),
    ).toBe("a b");
  });
});

// ── memory file round-trip (real temp dir) ────────────────
describe("memory files", () => {
  it("writes a file, rebuilds the index, and reads it back", () => {
    writeMemoryFile(
      tmp,
      "User Tabs",
      "user",
      "prefers tabs over spaces",
      "Use tabs everywhere.",
    );

    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]); // slug 化文件名，排除 MEMORY.md
    expect(readMemoryIndex(tmp)).toContain(
      "- [User Tabs](user-tabs.md) — prefers tabs over spaces",
    );

    const [file] = listMemoryFiles(tmp);
    expect(file).toMatchObject({
      name: "User Tabs",
      description: "prefers tabs over spaces",
      type: "user",
    });
    expect(readMemoryFile(tmp, "user-tabs.md")).toContain(
      "Use tabs everywhere.",
    );
  });

  it("round-trips a description with YAML-special characters", () => {
    writeMemoryFile(tmp, "DB Config", "project", 'host: localhost "x"', "...");
    const [file] = listMemoryFiles(tmp);
    expect(file.description).toBe('host: localhost "x"');
  });

  it("returns null for a missing file and empty index for an empty dir", () => {
    expect(readMemoryFile(tmp, "nope.md")).toBeNull();
    expect(readMemoryIndex(tmp)).toBe("");
    expect(memoryFilenames(tmp)).toEqual([]);
  });
});

// ── selectRelevantMemories (LLM pick + keyword fallback) ──
describe("selectRelevantMemories", () => {
  beforeEach(() => {
    writeMemoryFile(
      tmp,
      "database-config",
      "project",
      "postgres connection settings",
      "...",
    );
    writeMemoryFile(tmp, "editor-prefs", "user", "tabs not spaces", "...");
  });

  it("returns the filenames the model selects by index", async () => {
    const client = fakeClient(fakeMessage([textBlock("[0]")], "end_turn"));

    const selected = await selectRelevantMemories(
      tmp,
      [{ role: "user", content: "help with the database" }],
      { ...baseDeps(), client },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("falls back to keyword matching when the model call fails", async () => {
    const client = fakeClient(); // 无预设响应 → create 抛错 → 走关键词兜底

    const selected = await selectRelevantMemories(
      tmp,
      [{ role: "user", content: "tell me about the database setup" }],
      { ...baseDeps(), client },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("returns nothing when there are no memory files", async () => {
    const client = fakeClient();
    const empty = makeTempDir(import.meta.dirname);

    const selected = await selectRelevantMemories(
      empty,
      [{ role: "user", content: "anything" }],
      { ...baseDeps(), client },
    );

    expect(selected).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled(); // 无记忆文件即提前短路，不发任何 API
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

// ── agentLoop (empty memory dir) ──────────────────────────
describe("agentLoop", () => {
  // skills 为空 registry：SYSTEM 里技能清单为 "(no skills found)"，不影响分发。
  const loopDeps = () => ({
    ...baseDeps(),
    skills: {},
    memoryDir: tmp,
  });

  it("executes a plain tool call, then extraction finds nothing new", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage([textBlock("[]")], "end_turn"), // extractMemories：无新记忆
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { ...loopDeps(), client });

    expect(result).toBe("done");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
    expect(memoryFilenames(tmp)).toEqual([]); // 未写入任何记忆
  });

  it("dispatches task to a subagent and keeps only its summary", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { description: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"),
      fakeMessage([textBlock("parent done")], "end_turn"),
      fakeMessage([textBlock("[]")], "end_turn"), // extractMemories
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { ...loopDeps(), client });

    expect(result).toBe("parent done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });
});

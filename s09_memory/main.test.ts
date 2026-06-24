/**
 * s09_memory/main.test.ts
 *
 * s09 的新增点是记忆系统。记忆函数都接受一个目录参数（analogous to s07 的
 * scanSkills(dir)），测试指向一个临时目录，读写真实文件验证往返；
 * selectRelevantMemories 用 fake client 走 LLM 挑选，client 抛错时回退关键词匹配。
 * agentLoop 指向空的临时记忆目录：loadMemories 无文件即短路，末尾 extractMemories
 * 收到 "[]" 不写盘。压缩预处理器/subagent 复用 s08。
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
import {
  agentLoop,
  collectToolResults,
  listMemoryFiles,
  memoryFilenames,
  messageText,
  microCompact,
  parseFrontmatter,
  readMemoryFile,
  readMemoryIndex,
  selectRelevantMemories,
  snipCompact,
  spawnSubagent,
  summarizeHistory,
  writeMemoryFile,
} from "./main";

let tmp = "";

useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

// ── parseFrontmatter / messageText (pure) ─────────────────
describe("pure helpers", () => {
  it("parseFrontmatter keeps a later '---' in the body", () => {
    const { meta, body } = parseFrontmatter(
      "---\nname: x\n---\nabove\n---\nbelow",
    );
    expect(meta.name).toBe("x");
    expect(body).toBe("above\n---\nbelow");
  });

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

    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]); // slug, excludes MEMORY.md
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
      { client, logger: noopLogger },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("falls back to keyword matching when the model call fails", async () => {
    const client = fakeClient(); // no responses → create throws → fallback

    const selected = await selectRelevantMemories(
      tmp,
      [{ role: "user", content: "tell me about the database setup" }],
      { client, logger: noopLogger },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("returns nothing when there are no memory files", async () => {
    const client = fakeClient();
    const empty = makeTempDir(import.meta.dirname);

    const selected = await selectRelevantMemories(
      empty,
      [{ role: "user", content: "anything" }],
      { client, logger: noopLogger },
    );

    expect(selected).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled(); // short-circuits before any API call
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

// ── compaction preprocessors (pure) ───────────────────────
describe("compaction", () => {
  it("snipCompact leaves short histories untouched", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(snipCompact(messages, 50)).toBe(messages);
  });

  it("microCompact compacts old long results, keeps recent ones", () => {
    const round = (id: string, out: string): Anthropic.MessageParam[] => [
      {
        role: "assistant",
        content: [toolUseBlock(id, "bash", { command: "echo" })],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: out }],
      },
    ];
    const messages: Anthropic.MessageParam[] = [
      ...round("t1", "x".repeat(200)),
      ...round("t2", "r1"),
      ...round("t3", "r2"),
      ...round("t4", "r3"),
    ];
    microCompact(messages);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe("[Earlier tool result compacted.]");
    expect(results[3].content).toBe("r3");
  });
});

// ── summarizeHistory (fake client) ────────────────────────
describe("summarizeHistory", () => {
  it("returns the model's summary text", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("short summary")], "end_turn"),
    );
    const summary = await summarizeHistory(
      [{ role: "user", content: "history" }],
      {
        client,
        logger: noopLogger,
      },
    );
    expect(summary).toBe("short summary");
  });
});

// ── spawnSubagent ─────────────────────────────────────────
describe("spawnSubagent", () => {
  it("returns the subagent's final text", async () => {
    const client = fakeClient(fakeMessage([textBlock("answer")], "end_turn"));
    const result = await spawnSubagent("do x", { client, logger: noopLogger });
    expect(result).toBe("answer");
  });
});

// ── agentLoop (empty memory dir) ──────────────────────────
describe("agentLoop", () => {
  it("executes a plain tool call, then extraction finds nothing new", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage([textBlock("[]")], "end_turn"), // extractMemories → nothing
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      memoryDir: tmp,
    });

    expect(result).toBe("done");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
    expect(memoryFilenames(tmp)).toEqual([]); // no memory written
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

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      memoryDir: tmp,
    });

    expect(result).toBe("parent done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });
});

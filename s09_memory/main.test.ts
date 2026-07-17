/**
 * s09_memory/main.test.ts
 *
 * s09 只新增记忆系统，其余（工具表 / hook / nag / 技能层 / 压缩）整套沿用 s07/s08
 * 的装配，由各自的测试覆盖。这里聚焦记忆函数：接受目录参数，指向临时目录读写真实文件验证往返；
 * selectRelevantMemories 用 fake client 走 LLM 挑选，client 抛错时回退关键词匹配；
 * extractMemories / consolidateMemories 验证写盘、非法条目过滤，以及出错时不动旧文件。
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
  buildSystem,
  consolidateMemories,
  extractMemories,
  listMemoryFiles,
  loadMemories,
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

// ── buildSystem (STEP 1: memory index into SYSTEM) ────────
describe("buildSystem", () => {
  it("appends the memory index when memories exist", () => {
    writeMemoryFile(tmp, "editor-prefs", "user", "tabs not spaces", "...");

    const system = buildSystem({}, tmp, noopLogger);

    expect(system).toContain("Memories available:");
    expect(system).toContain(
      "- [editor-prefs](editor-prefs.md) — tabs not spaces",
    );
  });

  it("omits the memories section for an empty dir", () => {
    const system = buildSystem({}, tmp, noopLogger);

    expect(system).not.toContain("Memories available:");
    expect(system).toContain("Relevant memories are injected below.");
  });
});

// ── loadMemories (STEP 2: wrap selected contents) ─────────
describe("loadMemories", () => {
  it("wraps selected memory contents in <relevant_memories>", async () => {
    writeMemoryFile(
      tmp,
      "database-config",
      "project",
      "postgres settings",
      "Use port 5432.",
    );
    const client = fakeClient(fakeMessage([textBlock("[0]")], "end_turn"));

    const content = await loadMemories(
      tmp,
      [{ role: "user", content: "help with the database" }],
      { ...baseDeps(), client },
    );

    expect(content).toMatch(/^<relevant_memories>/);
    expect(content).toMatch(/<\/relevant_memories>$/);
    expect(content).toContain("Use port 5432.");
  });

  it("returns an empty string when nothing is selected", async () => {
    writeMemoryFile(tmp, "editor-prefs", "user", "tabs not spaces", "...");
    const client = fakeClient(fakeMessage([textBlock("[]")], "end_turn"));

    const content = await loadMemories(
      tmp,
      [{ role: "user", content: "unrelated topic" }],
      { ...baseDeps(), client },
    );

    expect(content).toBe("");
  });
});

// ── extractMemories (STEP 4: write path + guards) ─────────
describe("extractMemories", () => {
  const dialogue: Anthropic.MessageParam[] = [
    { role: "user", content: "I prefer tabs, remember that" },
  ];

  it("writes extracted memories and narrows invalid types", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          textBlock(
            JSON.stringify([
              {
                name: "user-tabs",
                type: "banana",
                description: "prefers tabs",
                body: "Use tabs.",
              },
            ]),
          ),
        ],
        "end_turn",
      ),
    );

    await extractMemories(tmp, dialogue, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]);
    const [file] = listMemoryFiles(tmp);
    expect(file.type).toBe("user"); // 非法 type 收窄回 "user"
    expect(readMemoryIndex(tmp)).toContain("user-tabs.md");
  });

  it("skips items missing description or body", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          textBlock(
            JSON.stringify([
              { name: "valid", type: "project", description: "d", body: "b" },
              { name: "no-body", type: "project", description: "d" },
            ]),
          ),
        ],
        "end_turn",
      ),
    );

    await extractMemories(tmp, dialogue, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toEqual(["valid.md"]);
  });

  it("swallows client errors without writing", async () => {
    const client = fakeClient(); // 无预设响应 → create 抛错

    await expect(
      extractMemories(tmp, dialogue, { ...baseDeps(), client }),
    ).resolves.toBeUndefined();

    expect(memoryFilenames(tmp)).toEqual([]);
  });

  it("skips the API call entirely for an empty dialogue", async () => {
    const client = fakeClient();

    await extractMemories(tmp, [{ role: "user", content: "   " }], {
      ...baseDeps(),
      client,
    });

    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

// ── consolidateMemories (STEP 5: threshold + rewrite) ─────
describe("consolidateMemories", () => {
  // 阈值 CONSOLIDATE_THRESHOLD = 10（main.ts 内部常量）。
  const seedFiles = (count: number) => {
    for (let i = 0; i < count; i++) {
      writeMemoryFile(tmp, `mem-${i}`, "project", `desc ${i}`, `body ${i}`);
    }
  };

  it("does nothing below the threshold", async () => {
    seedFiles(2);
    const client = fakeClient();

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(client.messages.create).not.toHaveBeenCalled();
    expect(memoryFilenames(tmp)).toHaveLength(2);
  });

  it("replaces old files with the consolidated result at the threshold", async () => {
    seedFiles(10);
    const client = fakeClient(
      fakeMessage(
        [
          textBlock(
            JSON.stringify([
              {
                name: "merged",
                type: "project",
                description: "all in one",
                body: "merged body",
              },
            ]),
          ),
        ],
        "end_turn",
      ),
    );

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toEqual(["merged.md"]);
    expect(readMemoryIndex(tmp)).toBe("- [merged](merged.md) — all in one");
  });

  it("keeps old files intact when the client call fails", async () => {
    seedFiles(10);
    const client = fakeClient();

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toHaveLength(10);
  });

  it("keeps old files intact when the response has no JSON array", async () => {
    seedFiles(10);
    const client = fakeClient(
      fakeMessage([textBlock("cannot consolidate")], "end_turn"),
    );

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toHaveLength(10);
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

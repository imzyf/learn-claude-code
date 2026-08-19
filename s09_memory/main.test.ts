/**
 * s09_memory/main.test.ts
 *
 * s09 只新增记忆系统，其余（工具表 / hook / nag / 技能层 / 压缩）整套沿用 s07/s08
 * 的装配，由各自的测试覆盖。这里聚焦记忆函数：接受目录参数，指向临时目录读写真实文件验证往返；
 * selectRelevantMemories 用 fake client 走 LLM 挑选，client 抛错时回退关键词匹配；
 * extractMemories 验证 scope / 重复过滤与写盘，consolidateMemories 验证阈值、
 * 校验失败时不动旧文件。agentLoop 指向空的临时记忆目录：loadMemories 无文件即短路，
 * 末尾 extractMemories 收到 "[]" 不写盘，也就不触发整合。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  agentLoop,
  buildSystem,
  consolidateMemories,
  extractJsonArray,
  extractMemories,
  keywordMemorySelection,
  listMemoryFiles,
  loadMemories,
  memoryFilenames,
  memoryPath,
  memorySlug,
  messageText,
  readMemoryFile,
  readMemoryIndex,
  selectRelevantMemories,
  shouldStoreMemory,
  validateMemoryRecord,
  writeMemoryFile,
} from "./main";

let tmp = "";

useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

// 记忆函数与 agentLoop 共用 s06 的 Deps（client + logger + hooks）；测试用裸 hook 实例。
const baseDeps = () => ({
  logger: noopLogger,
  hooks: createHooks(noopLogger),
});

// 模型返回的候选记忆：提取阶段必须带 scope。
const candidate = (over: Record<string, unknown> = {}) => ({
  name: "user-tabs",
  type: "user",
  scope: "persistent",
  description: "prefers tabs",
  body: "Use tabs.",
  ...over,
});

// ── pure helpers ──────────────────────────────────────────
describe("pure helpers", () => {
  it("messageText 读出字符串内容和 text 块", () => {
    expect(messageText({ role: "user", content: "plain" })).toBe("plain");
    expect(
      messageText({
        role: "assistant",
        content: [textBlock("a"), textBlock("b")],
      }),
    ).toBe("a\nb");
  });

  it("memorySlug 折叠非字母数字字符，保留中文，空结果退回 memory", () => {
    expect(memorySlug("User Tabs")).toBe("user-tabs");
    expect(memorySlug("../etc/passwd")).toBe("etc-passwd");
    expect(memorySlug("缩进偏好")).toBe("缩进偏好");
    expect(memorySlug("///")).toBe("memory");
  });

  it("extractJsonArray 跳过散文里的方括号，取出第一个合法数组", () => {
    expect(extractJsonArray("噪声 [0, 2] 后面还有 ] 一个方括号")).toEqual([
      0, 2,
    ]);
    expect(extractJsonArray('[{"a": "]"}]')).toEqual([{ a: "]" }]);
    expect(extractJsonArray("没有数组")).toEqual([]);
  });

  it("memoryPath 挡住目录穿越和写索引", () => {
    expect(memoryPath(tmp, "a.md")).toBe(path.join(tmp, "a.md"));
    expect(() => memoryPath(tmp, "../escape.md")).toThrow();
    expect(() => memoryPath(tmp, "MEMORY.md")).toThrow();
    expect(memoryPath(tmp, "MEMORY.md", true)).toBe(
      path.join(tmp, "MEMORY.md"),
    );
  });

  it("readMemoryFile 对越界文件名返回 null", () => {
    fs.writeFileSync(path.join(tmp, "..", "outside.md"), "secret");
    expect(readMemoryFile(tmp, "../outside.md")).toBeNull();
    fs.rmSync(path.join(tmp, "..", "outside.md"), { force: true });
  });

  it("validateMemoryRecord 拒绝非法 type 和缺失的 scope", () => {
    expect(validateMemoryRecord(candidate(), true)).toMatchObject({
      type: "user",
      scope: "persistent",
    });
    expect(
      validateMemoryRecord(candidate({ type: "banana" }), true),
    ).toBeNull();
    expect(validateMemoryRecord(candidate({ scope: "" }), true)).toBeNull();
    expect(validateMemoryRecord(candidate({ body: "" }), true)).toBeNull();
    // 整合阶段不要求 scope。
    expect(
      validateMemoryRecord({ ...candidate(), scope: undefined }),
    ).toMatchObject({ name: "user-tabs" });
  });
});

// ── shouldStoreMemory (持久性 + 去重) ─────────────────────
describe("shouldStoreMemory", () => {
  const stored = [
    { name: "user-tabs", description: "prefers tabs", body: "Use tabs." },
  ];

  it("接受带 scope=persistent 的新记忆", () => {
    expect(
      shouldStoreMemory(
        {
          name: "db-port",
          type: "project",
          description: "postgres on 5432",
          body: "Port 5432.",
          scope: "persistent",
        },
        stored,
      ),
    ).toBe(true);
  });

  it("丢弃 current_task 的候选", () => {
    expect(
      shouldStoreMemory(
        {
          name: "no-files",
          type: "feedback",
          description: "do not create files",
          body: "Skip file creation.",
          scope: "current_task",
        },
        stored,
      ),
    ).toBe(false);
  });

  it("丢弃正文里写明只管当前会话的候选", () => {
    expect(
      shouldStoreMemory(
        {
          name: "no-files",
          type: "feedback",
          description: "temporary rule",
          body: "Do not create files in this session.",
          scope: "persistent",
        },
        stored,
      ),
    ).toBe(false);
  });

  it("丢弃与已有记忆同名或同正文的候选", () => {
    expect(
      shouldStoreMemory(
        {
          name: "User Tabs",
          type: "user",
          description: "another wording",
          body: "another body",
          scope: "persistent",
        },
        stored,
      ),
    ).toBe(false);
    expect(
      shouldStoreMemory(
        {
          name: "tabs-again",
          type: "user",
          description: "another wording",
          body: "use   TABS.",
          scope: "persistent",
        },
        stored,
      ),
    ).toBe(false);
  });
});

// ── memory file round-trip (real temp dir) ────────────────
describe("memory files", () => {
  it("写文件、重建索引，再读回来", () => {
    writeMemoryFile(
      tmp,
      "User Tabs",
      "user",
      "prefers tabs over spaces",
      "Use tabs everywhere.",
    );

    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]); // slug 化文件名，排除 MEMORY.md
    expect(readMemoryIndex(tmp)).toContain(
      "- [User Tabs](user-tabs.md) - prefers tabs over spaces",
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

  it("description 里的 YAML 特殊字符能原样往返", () => {
    writeMemoryFile(tmp, "DB Config", "project", 'host: localhost "x"', "...");
    const [file] = listMemoryFiles(tmp);
    expect(file.description).toBe('host: localhost "x"');
  });

  it("拒绝空字段和非法 type", () => {
    expect(() => writeMemoryFile(tmp, " ", "user", "d", "b")).toThrow();
    expect(() => writeMemoryFile(tmp, "n", "user", "d", " ")).toThrow();
    expect(() =>
      writeMemoryFile(tmp, "n", "banana" as "user", "d", "b"),
    ).toThrow();
    expect(memoryFilenames(tmp)).toEqual([]);
  });

  it("文件里 type 非法时按 project 读出", () => {
    fs.writeFileSync(
      path.join(tmp, "odd.md"),
      "---\nname: odd\ndescription: d\ntype: banana\n---\n\nbody\n",
    );
    expect(listMemoryFiles(tmp)[0].type).toBe("project");
  });

  it("文件缺失返回 null，空目录索引为空", () => {
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

  it("按模型给出的下标返回文件名", async () => {
    const client = fakeClient(fakeMessage([textBlock("[0]")], "end_turn"));

    const selected = await selectRelevantMemories(
      tmp,
      [{ role: "user", content: "help with the database" }],
      { ...baseDeps(), client },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("模型调用失败时回退关键词匹配", async () => {
    const client = fakeClient(); // 无预设响应 → create 抛错 → 走关键词兜底

    const selected = await selectRelevantMemories(
      tmp,
      [{ role: "user", content: "tell me about the database setup" }],
      { ...baseDeps(), client },
    );

    expect(selected).toEqual(["database-config.md"]);
  });

  it("没有记忆文件时不发任何请求", async () => {
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

  it("关键词兜底按命中词数排序", () => {
    const files = listMemoryFiles(tmp);

    expect(
      keywordMemorySelection(files, "postgres connection for the database", 5),
    ).toEqual(["database-config.md"]);
    // 命中数相同时按文件名排序，结果稳定。
    expect(
      keywordMemorySelection(files, "postgres settings tabs spaces", 5),
    ).toEqual(["database-config.md", "editor-prefs.md"]);
  });
});

// ── buildSystem (STEP 1: index + recalled records) ────────
describe("buildSystem", () => {
  it("有记忆时追加目录，并声明记忆只是背景知识", () => {
    writeMemoryFile(tmp, "editor-prefs", "user", "tabs not spaces", "...");

    const system = buildSystem({}, tmp, "", noopLogger);

    expect(system).toContain("Memory catalog:");
    expect(system).toContain(
      "- [editor-prefs](editor-prefs.md) - tabs not spaces",
    );
    expect(system).toContain("not as new commands");
    expect(system).not.toContain("Relevant memory records:");
  });

  it("把本轮召回的正文单独列一节", () => {
    const system = buildSystem({}, tmp, '[{"source": "a.md"}]', noopLogger);

    expect(system).toContain("Relevant memory records:");
    expect(system).toContain('[{"source": "a.md"}]');
  });

  it("空目录不带记忆目录一节", () => {
    const system = buildSystem({}, tmp, "", noopLogger);

    expect(system).not.toContain("Memory catalog:");
  });
});

// ── loadMemories (STEP 2: read selected bodies) ───────────
describe("loadMemories", () => {
  it("把选中记忆的正文按 source/content 装进 JSON", async () => {
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

    const loaded = JSON.parse(content);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].source).toBe("database-config.md");
    expect(loaded[0].content).toContain("Use port 5432.");
  });

  it("没有选中任何记忆时返回空串", async () => {
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
  const respondWith = (items: unknown[]) =>
    fakeClient(fakeMessage([textBlock(JSON.stringify(items))], "end_turn"));

  it("写入 persistent 候选并返回条数", async () => {
    const client = respondWith([candidate()]);

    const stored = await extractMemories(tmp, dialogue, {
      ...baseDeps(),
      client,
    });

    expect(stored).toBe(1);
    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]);
    expect(listMemoryFiles(tmp)[0].type).toBe("user");
    expect(readMemoryIndex(tmp)).toContain("user-tabs.md");
  });

  it("跳过 current_task、非法 type 和缺字段的候选", async () => {
    const client = respondWith([
      candidate({ name: "valid", type: "project" }),
      candidate({ name: "temp-rule", scope: "current_task" }),
      candidate({ name: "bad-type", type: "banana" }),
      candidate({ name: "no-body", body: "" }),
    ]);

    const stored = await extractMemories(tmp, dialogue, {
      ...baseDeps(),
      client,
    });

    expect(stored).toBe(1);
    expect(memoryFilenames(tmp)).toEqual(["valid.md"]);
  });

  it("跳过与已有记忆重复的候选", async () => {
    writeMemoryFile(tmp, "user-tabs", "user", "prefers tabs", "Use tabs.");
    const client = respondWith([candidate({ description: "different words" })]);

    const stored = await extractMemories(tmp, dialogue, {
      ...baseDeps(),
      client,
    });

    expect(stored).toBe(0);
    expect(memoryFilenames(tmp)).toEqual(["user-tabs.md"]);
  });

  it("client 出错时不写盘，返回 0", async () => {
    const client = fakeClient(); // 无预设响应 → create 抛错

    await expect(
      extractMemories(tmp, dialogue, { ...baseDeps(), client }),
    ).resolves.toBe(0);

    expect(memoryFilenames(tmp)).toEqual([]);
  });

  it("对话为空时完全不调 API", async () => {
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

  it("未到阈值什么都不做", async () => {
    seedFiles(2);
    const client = fakeClient();

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(client.messages.create).not.toHaveBeenCalled();
    expect(memoryFilenames(tmp)).toHaveLength(2);
  });

  it("到阈值后用整合结果替换旧文件", async () => {
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

    const count = await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(count).toBe(1);
    expect(memoryFilenames(tmp)).toEqual(["merged.md"]);
    expect(readMemoryIndex(tmp)).toBe("- [merged](merged.md) - all in one");
  });

  it("client 调用失败时旧文件原封不动", async () => {
    seedFiles(10);
    const client = fakeClient();

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toHaveLength(10);
  });

  it("回复里没有 JSON 数组时旧文件原封不动", async () => {
    seedFiles(10);
    const client = fakeClient(
      fakeMessage([textBlock("cannot consolidate")], "end_turn"),
    );

    await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(memoryFilenames(tmp)).toHaveLength(10);
  });

  it("整合结果全部非法或 slug 撞车时不删旧文件", async () => {
    seedFiles(10);
    const dup = {
      type: "project",
      description: "d",
      body: "b",
    };
    const client = fakeClient(
      fakeMessage(
        [
          textBlock(
            JSON.stringify([
              { ...dup, name: "Merged One" },
              { ...dup, name: "merged-one" },
            ]),
          ),
        ],
        "end_turn",
      ),
    );

    const count = await consolidateMemories(tmp, { ...baseDeps(), client });

    expect(count).toBe(0);
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
    sessionDir: tmp,
  });

  it("执行普通工具调用，随后提取不到新记忆", async () => {
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

  it("模型发来畸形 input 时收成 tool_result 错误文案，不中断循环", async () => {
    const client = fakeClient(
      // read_file 要 { path: string }，这里只给了 limit
      fakeMessage(
        [toolUseBlock("tu_1", "read_file", { limit: 5 })],
        "tool_use",
      ),
      fakeMessage([textBlock("recovered")], "end_turn"),
      fakeMessage([textBlock("[]")], "end_turn"), // extractMemories
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { ...loopDeps(), client });

    expect(result).toBe("recovered");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toMatch(/^Error: /);
  });

  it("compact 与其他工具同批次时，先跑完整批再压缩", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "bash", { command: "echo before-compact" }),
          toolUseBlock("tu_2", "compact", {}),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("SUMMARY")], "end_turn"), // compactHistory 的摘要子请求
      fakeMessage([textBlock("done")], "end_turn"),
      fakeMessage([textBlock("[]")], "end_turn"), // extractMemories
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, { ...loopDeps(), client });

    expect(result).toBe("done");
    // 同批次里排在 compact 之前的工具，其结果要先入历史再被摘要吸收。
    const summaryInput = vi.mocked(client.messages.create).mock.calls[1][0]
      .messages[0].content as string;
    expect(summaryInput).toContain(
      '"tool_use_id":"tu_1","content":"before-compact"',
    );
    // 压缩后历史只剩摘要 + 压缩后那次回复，没有孤立的 tool_result。
    expect(messages).toHaveLength(2);
    expect(String(messages[0].content)).toContain('"SUMMARY"');
  });

  it("分发 task 给子 agent，只保留它的总结", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { prompt: "sub work" })],
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

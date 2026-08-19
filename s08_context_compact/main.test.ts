/**
 * s08_context_compact/main.test.ts
 *
 * s08 的新增点是四层压缩流水线。三个预处理器（snip/micro/budget）不发 API，
 * 直接单测最合适；写盘的路径（snip 存档）把 sessionDir 指到临时目录，
 * L3 只测 under-budget 的 no-op 路径；summarizeHistory 用 fake client 验证摘要提取。
 * agentLoop 复用 s07 的分发骨架：load_skill / task / 普通工具。
 * 其余（技能层、permissionHook、subagent 隔离）沿用 s05/s06/s07，其测试不在此重复。
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
import { createHooks } from "../s04_hooks/main";
// s05/s06/s07 的层沿用旧实现，各自的测试不在此重复。
import type { SkillRegistry } from "../s07_skill_loading/main";
import {
  agentLoop,
  collectToolResults,
  estimateSize,
  microCompact,
  persistLargeOutput,
  reactiveCompact,
  replaceMessages,
  snipCompact,
  summarizeHistory,
  toolResultBudget,
} from "./main";

// 压缩层的落盘产物以 sessionDir 为根，测试注入临时目录，避免写进 s08 自己的目录。
let tmp = "";

useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

// 内存 registry：load_skill 分发无需碰文件系统。
const registry: SkillRegistry = {
  "code-review": {
    name: "code-review",
    description: "Review a diff.",
    content: "FULL code-review content",
  },
};

// tool_use / tool_result 成对的一轮，供压缩函数构造测试消息。
function toolRound(id: string, output: string): Anthropic.MessageParam[] {
  return [
    {
      role: "assistant",
      content: [toolUseBlock(id, "bash", { command: "echo" })],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: output }],
    },
  ];
}

// 并行调用的一轮：一条 assistant 带多个 tool_use + 一条 user 带多个 tool_result。
function parallelToolRound(
  ids: string[],
  outputOf: (id: string) => string,
): Anthropic.MessageParam[] {
  return [
    {
      role: "assistant",
      content: ids.map((id) => toolUseBlock(id, "bash", { command: "echo" })),
    },
    {
      role: "user",
      content: ids.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: outputOf(id),
      })),
    },
  ];
}

// ── compaction preprocessors (pure, no I/O) ───────────────
describe("snipCompact", () => {
  it("历史条数没超上限时原样返回", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(snipCompact(messages, 50, noopLogger, tmp)).toBe(messages);
  });

  it("超上限时裁掉中间，保留头尾并落盘存档", () => {
    const messages: Anthropic.MessageParam[] = Array.from(
      { length: 20 },
      (_, i) => ({
        role: "user",
        content: `m${i}`,
      }),
    );
    const out = snipCompact(messages, 10, noopLogger, tmp);
    expect(out.length).toBe(11); // head(3) + 1 placeholder + tail(7)
    expect(out[0]).toBe(messages[0]); // head kept
    expect(out[out.length - 1]).toBe(messages[19]); // tail kept
    // 占位符指向存档，被裁掉的 10 条仍可从磁盘读回。
    const placeholder = out[3].content as string;
    expect(placeholder).toMatch(/^\[10 messages archived at .+\]$/);
    const archived = fs
      .readFileSync(placeholder.slice("[10 messages archived at ".length, -1))
      .toString()
      .trim()
      .split("\n");
    expect(archived).toHaveLength(20);
  });
});

describe("microCompact", () => {
  it("保留最近几条结果，只压缩更早的长结果", () => {
    const messages: Anthropic.MessageParam[] = [
      ...toolRound("t1", "x".repeat(200)), // old + long → compacted
      ...toolRound("t2", "seen-1"),
      ...toolRound("t3", "seen-2"),
      ...toolRound("t4", "seen-3"),
      ...toolRound("t5", "unseen"), // 最后一轮模型还没看到
    ];
    microCompact(messages, noopLogger);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe(
      "[Earlier tool result compacted. Re-run if needed.]",
    );
    expect(results[3].content).toBe("seen-3"); // within KEEP_RECENT
    expect(results[4].content).toBe("unseen");
  });

  it("结果已被 L3 落盘时，占位符保留磁盘路径", () => {
    const persisted = `<persisted-output>\nFull output: ${tmp}/out.txt\nPreview:\n${"x".repeat(200)}\n</persisted-output>`;
    const messages: Anthropic.MessageParam[] = [
      ...toolRound("t1", persisted),
      ...toolRound("t2", "seen-1"),
      ...toolRound("t3", "seen-2"),
      ...toolRound("t4", "seen-3"),
      ...toolRound("t5", "unseen"),
    ];
    microCompact(messages, noopLogger);
    expect(collectToolResults(messages)[0].content).toBe(
      `[Earlier tool result saved at ${tmp}/out.txt]`,
    );
  });

  it("结果条数太少时什么都不做", () => {
    const messages: Anthropic.MessageParam[] = toolRound("t1", "y".repeat(200));
    microCompact(messages, noopLogger);
    expect(collectToolResults(messages)[0].content).toBe("y".repeat(200));
  });

  it("最新一轮并行结果整轮不压", () => {
    const ids = ["p1", "p2", "p3", "p4"];
    const messages: Anthropic.MessageParam[] = [
      ...toolRound("t1", "x".repeat(200)), // old + long → compacted
      ...toolRound("t2", "seen-1"),
      ...toolRound("t3", "seen-2"),
      ...toolRound("t4", "seen-3"),
      ...parallelToolRound(ids, (id) => `${id}-`.padEnd(200, "z")),
    ];
    microCompact(messages, noopLogger);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe(
      "[Earlier tool result compacted. Re-run if needed.]",
    );
    // 并行的这一轮结果都在最后一次 assistant 回复之后，一条都不动。
    const lastRound = results.slice(-ids.length);
    for (const [i, id] of ids.entries())
      expect(lastRound[i].content).toBe(`${id}-`.padEnd(200, "z"));
  });

  it("全部结果都属于最新一轮时什么都不做", () => {
    const messages: Anthropic.MessageParam[] = parallelToolRound(
      ["p1", "p2", "p3", "p4"],
      () => "w".repeat(200),
    );
    microCompact(messages, noopLogger);
    for (const part of collectToolResults(messages))
      expect(part.content).toBe("w".repeat(200));
  });

  // Stop hook 的 force 会在工具结果之后再追加一条 user 消息，最新一轮仍算没看过。
  it("末尾跟着普通 user 消息时仍能保住最新一轮", () => {
    const messages: Anthropic.MessageParam[] = [
      ...parallelToolRound(["p1", "p2", "p3", "p4"], () => "w".repeat(200)),
      { role: "user", content: "keep going" },
    ];
    microCompact(messages, noopLogger);
    for (const part of collectToolResults(messages))
      expect(part.content).toBe("w".repeat(200));
  });
});

describe("toolResultBudget", () => {
  it("最新一轮在预算内时不落盘", () => {
    const messages: Anthropic.MessageParam[] = toolRound("t1", "small output");
    expect(toolResultBudget(messages, 200_000, noopLogger, tmp)).toBe(messages);
  });
});

describe("persistLargeOutput", () => {
  it("短输出原样返回，不碰磁盘", () => {
    expect(persistLargeOutput("id1", "short", tmp)).toBe("short");
  });

  it("tool_use_id 里的路径分隔符被清洗，存档不会写出目录", () => {
    const resultsDir = path.join(tmp, ".task_outputs", "tool-results");
    const placeholder = persistLargeOutput(
      "../../escape/id",
      "x".repeat(40_000),
      tmp,
    );

    const saved = placeholder
      .split("\n")
      .find((line) => line.startsWith("Full output: "))
      ?.slice("Full output: ".length) as string;
    expect(path.dirname(saved)).toBe(resultsDir);
    expect(path.basename(saved)).toMatch(/^[\d-T]+_\.\._\.\._escape_id\.txt$/);
    expect(fs.readFileSync(saved).toString()).toHaveLength(40_000);
  });
});

describe("estimateSize / replaceMessages", () => {
  it("estimateSize 随内容变长而增大", () => {
    const small = estimateSize([{ role: "user", content: "a" }]);
    const big = estimateSize([{ role: "user", content: "a".repeat(1000) }]);
    expect(big).toBeGreaterThan(small);
  });

  it("replaceMessages 原地替换内容，引用不变", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "old" },
    ];
    replaceMessages(messages, [{ role: "user", content: "new" }]);
    expect(messages).toEqual([{ role: "user", content: "new" }]);
  });
});

// ── summarizeHistory (LLM summary, fake client) ───────────
describe("summarizeHistory", () => {
  it("返回模型给出的摘要文本", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("a compact summary")], "end_turn"),
    );

    const summary = await summarizeHistory(
      [{ role: "user", content: "long history" }],
      {
        client,
        logger: noopLogger,
        hooks: createHooks(noopLogger),
      },
    );

    expect(summary).toBe("a compact summary");
  });

  it("模型没返回文本时给出兜底文案", async () => {
    const client = fakeClient(fakeMessage([], "end_turn"));

    const summary = await summarizeHistory([{ role: "user", content: "x" }], {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
    });

    expect(summary).toBe("[no text in response]");
  });
});

// ── reactiveCompact (prompt_too_long 应急路径) ─────────────
describe("reactiveCompact", () => {
  const compactDeps = (client: ReturnType<typeof fakeClient>) => ({
    client,
    logger: noopLogger,
    hooks: createHooks(noopLogger),
    sessionDir: tmp,
    activeRequest: "current ask",
  });

  // 摘要子请求的输入（summaryInput 序列化后的整段历史）。
  const summaryInputOf = (client: ReturnType<typeof fakeClient>): string =>
    vi.mocked(client.messages.create).mock.calls[0][0].messages[0]
      .content as string;

  it("历史比尾部保留数还短时，摘要整段并只留摘要", async () => {
    const client = fakeClient(fakeMessage([textBlock("S")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "one huge request" },
      { role: "assistant", content: [textBlock("ok")] },
    ];

    const out = await reactiveCompact(messages, compactDeps(client));

    // 留尾会把全部历史原样留下，等于没压缩，重试的 prompt 只会更长。
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('"S"');
    // 摘要的输入是整段历史，不是空数组。
    expect(summaryInputOf(client)).toContain("one huge request");
  });

  it("历史够长时摘要头部、原样保留尾部", async () => {
    const client = fakeClient(fakeMessage([textBlock("S")], "end_turn"));
    const messages: Anthropic.MessageParam[] = Array.from(
      { length: 8 },
      (_, i) => ({ role: "user", content: `m${i}` }),
    );

    const out = await reactiveCompact(messages, compactDeps(client));

    expect(out).toHaveLength(6); // 1 条摘要 + 尾部 5 条
    expect(out[out.length - 1]).toBe(messages[7]);
    // 只有尾部之前的 m0~m2 进了摘要。
    expect(summaryInputOf(client)).toContain("m0");
    expect(summaryInputOf(client)).not.toContain("m3");
  });
});

// ── agentLoop dispatch ────────────────────────────────────
describe("agentLoop", () => {
  // 函数而非常量：tmp 在 beforeEach 才拿到值。
  const loopDeps = () => ({
    client: undefined as never,
    logger: noopLogger,
    hooks: createHooks(noopLogger),
    skills: registry,
    system: "S",
    sessionDir: tmp,
  });

  it("分发 load_skill 并注入技能全文", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "load_skill", { name: "code-review" })],
        "tool_use",
      ),
      fakeMessage([textBlock("used it")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "review" },
    ];

    const result = await agentLoop(messages, { ...loopDeps(), client });

    expect(result).toBe("used it");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("FULL code-review content");
  });

  it("分发 task 给子 agent，只保留它的总结", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { prompt: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"),
      fakeMessage([textBlock("parent done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      ...loopDeps(),
      client,
      skills: {},
    });

    expect(result).toBe("parent done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });

  it("模型发来畸形 input 时收成 tool_result 错误文案，不中断循环", async () => {
    const client = fakeClient(
      // read_file 要 { path: string }，这里只给了 limit
      fakeMessage(
        [toolUseBlock("tu_1", "read_file", { limit: 5 })],
        "tool_use",
      ),
      fakeMessage([textBlock("recovered")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      ...loopDeps(),
      client,
      skills: {},
    });

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
      fakeMessage([textBlock("SUMMARY")], "end_turn"), // 摘要子请求
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      ...loopDeps(),
      client,
      skills: {},
    });

    expect(result).toBe("done");
    // 同批次里排在 compact 之前的工具，其结果要先入历史再被摘要吸收 ——
    // 提前 break 的话这次 bash 白跑，模型看不到输出。
    const summaryInput = vi.mocked(client.messages.create).mock.calls[1][0]
      .messages[0].content as string;
    expect(summaryInput).toContain(
      '"tool_use_id":"tu_1","content":"before-compact"',
    );
    expect(summaryInput).toContain(
      "Compaction requested after this tool batch.",
    );
    // 压缩后历史只剩摘要 + 压缩后那次回复，没有孤立的 tool_result。
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('"SUMMARY"');
    expect(collectToolResults(messages)).toHaveLength(0);
  });

  it("执行普通工具调用", async () => {
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
      ...loopDeps(),
      client,
      skills: {},
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });
});

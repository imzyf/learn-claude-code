/**
 * s08_context_compact/main.test.ts
 *
 * s08 的新增点是四层压缩流水线。三个预处理器（snip/micro/budget）不发 API，
 * 直接单测最合适；写盘的路径（snip 存档）把 sessionDir 指到临时目录，
 * L3 只测 under-budget 的 no-op 路径；summarizeHistory 用 fake client 验证摘要提取。
 * agentLoop 复用 s07 的分发骨架：load_skill / task / 普通工具。
 * 其余（技能层、permissionHook、subagent 隔离、todo）沿用 s05/s06/s07，其测试不在此重复。
 */

import * as fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
  useTempDir,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
// s05/s06/s07 的层沿用旧实现，各自的测试不在此重复；这里只借 resetNagCounter 做 setup。
import { resetNagCounter } from "../s05_todo_write/main";
import type { SkillRegistry } from "../s07_skill_loading/main";
import {
  agentLoop,
  collectToolResults,
  estimateSize,
  microCompact,
  persistLargeOutput,
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

beforeEach(() => {
  resetNagCounter();
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
      ...toolRound("t2", "recent-1"),
      ...toolRound("t3", "recent-2"),
      ...toolRound("t4", "recent-3"),
    ];
    microCompact(messages, noopLogger);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe(
      "[Earlier tool result compacted. Re-run if needed.]",
    );
    expect(results[3].content).toBe("recent-3"); // within KEEP_RECENT
  });

  it("结果已被 L3 落盘时，占位符保留磁盘路径", () => {
    const persisted = `<persisted-output>\nFull output: ${tmp}/out.txt\nPreview:\n${"x".repeat(200)}\n</persisted-output>`;
    const messages: Anthropic.MessageParam[] = [
      ...toolRound("t1", persisted),
      ...toolRound("t2", "recent-1"),
      ...toolRound("t3", "recent-2"),
      ...toolRound("t4", "recent-3"),
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
      ...parallelToolRound(ids, (id) => `${id}-`.padEnd(200, "z")),
    ];
    microCompact(messages, noopLogger);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe(
      "[Earlier tool result compacted. Re-run if needed.]",
    );
    for (const [i, id] of ids.entries())
      expect(results[i + 1].content).toBe(`${id}-`.padEnd(200, "z"));
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

  it("末尾跟着 reminder 时仍能保住最新一轮", () => {
    const messages: Anthropic.MessageParam[] = [
      ...parallelToolRound(["p1", "p2", "p3", "p4"], () => "w".repeat(200)),
      { role: "user", content: "<reminder>Update your todos.</reminder>" },
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

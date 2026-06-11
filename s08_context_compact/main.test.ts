/**
 * s08_context_compact/main.test.ts
 *
 * s08 的新增点是四层压缩流水线。三个预处理器（snip/micro/budget）是纯函数，
 * 不发 API 也不写盘（只测 under-budget 的 no-op 路径，避免落 .transcripts/），
 * 直接单测最合适；summarizeHistory 用 fake client 验证摘要提取。
 * agentLoop 复用 s07 的分发骨架：load_skill / task / 普通工具。
 * 其余（技能层、permissionHook、subagent 隔离、todo）沿用 s05/s06/s07，其测试不在此重复。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { clearHooks } from "../s04_hooks/main";
// s05/s06/s07 的层沿用旧实现，各自的测试不在此重复；这里只借 resetNagCounter 做 setup。
import { resetNagCounter } from "../s05_todo_write/main";
import type { SkillRegistry } from "../s07_skill_loading/main";
import {
  agentLoop,
  collectToolResults,
  estimateSize,
  microCompact,
  persistLargeOutput,
  setMessages,
  snipCompact,
  summarizeHistory,
  toolResultBudget,
} from "./main";

beforeEach(() => {
  clearHooks();
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

// ── compaction preprocessors (pure, no I/O) ───────────────
describe("snipCompact", () => {
  it("leaves short histories untouched", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(snipCompact(messages, 50)).toBe(messages);
  });

  it("trims the middle when over the limit, keeping head and tail", () => {
    const messages: Anthropic.MessageParam[] = Array.from(
      { length: 20 },
      (_, i) => ({
        role: "user",
        content: `m${i}`,
      }),
    );
    const out = snipCompact(messages, 10);
    expect(out.length).toBe(11); // head(3) + 1 placeholder + tail(7)
    expect(out[0]).toBe(messages[0]); // head kept
    expect(out[out.length - 1]).toBe(messages[19]); // tail kept
    expect(out[3]).toEqual({ role: "user", content: "[snipped 10 messages]" });
  });
});

describe("microCompact", () => {
  it("keeps the most recent results and compacts older long ones", () => {
    const messages: Anthropic.MessageParam[] = [
      ...toolRound("t1", "x".repeat(200)), // old + long → compacted
      ...toolRound("t2", "recent-1"),
      ...toolRound("t3", "recent-2"),
      ...toolRound("t4", "recent-3"),
    ];
    microCompact(messages);
    const results = collectToolResults(messages);
    expect(results[0].content).toBe(
      "[Earlier tool result compacted. Re-run if needed.]",
    );
    expect(results[3].content).toBe("recent-3"); // within KEEP_RECENT
  });

  it("does nothing when there are few results", () => {
    const messages: Anthropic.MessageParam[] = toolRound("t1", "y".repeat(200));
    microCompact(messages);
    expect(collectToolResults(messages)[0].content).toBe("y".repeat(200));
  });
});

describe("toolResultBudget", () => {
  it("is a no-op when the last turn is within budget", () => {
    const messages: Anthropic.MessageParam[] = toolRound("t1", "small output");
    expect(toolResultBudget(messages, 200_000)).toBe(messages);
  });
});

describe("persistLargeOutput", () => {
  it("returns short output unchanged without touching disk", () => {
    expect(persistLargeOutput("id1", "short")).toBe("short");
  });
});

describe("estimateSize / setMessages", () => {
  it("estimateSize grows with content", () => {
    const small = estimateSize([{ role: "user", content: "a" }]);
    const big = estimateSize([{ role: "user", content: "a".repeat(1000) }]);
    expect(big).toBeGreaterThan(small);
  });

  it("setMessages replaces contents in place (same reference)", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "old" },
    ];
    setMessages(messages, [{ role: "user", content: "new" }]);
    expect(messages).toEqual([{ role: "user", content: "new" }]);
  });
});

// ── summarizeHistory (LLM summary, fake client) ───────────
describe("summarizeHistory", () => {
  it("returns the model's summary text", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("a compact summary")], "end_turn"),
    );

    const summary = await summarizeHistory(
      [{ role: "user", content: "long history" }],
      {
        client,
        logger: noopLogger,
      },
    );

    expect(summary).toBe("a compact summary");
  });

  it("falls back when the model returns no text", async () => {
    const client = fakeClient(fakeMessage([], "end_turn"));

    const summary = await summarizeHistory([{ role: "user", content: "x" }], {
      client,
      logger: noopLogger,
    });

    expect(summary).toBe("[no text in response]");
  });
});

// ── agentLoop dispatch ────────────────────────────────────
describe("agentLoop", () => {
  const loopDeps = {
    client: undefined as never,
    logger: noopLogger,
    skills: registry,
    system: "S",
  };

  it("dispatches load_skill and injects the full content", async () => {
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

    const result = await agentLoop(messages, { ...loopDeps, client });

    expect(result).toBe("used it");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("FULL code-review content");
  });

  it("dispatches task to a subagent and keeps only its summary", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { description: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"),
      fakeMessage([textBlock("parent done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      ...loopDeps,
      client,
      skills: {},
    });

    expect(result).toBe("parent done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });

  it("executes a plain tool call", async () => {
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
      ...loopDeps,
      client,
      skills: {},
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });
});

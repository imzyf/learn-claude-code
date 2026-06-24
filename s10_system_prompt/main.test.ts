/**
 * s10_system_prompt/main.test.ts
 *
 * s10 的新增点是运行时组装 + 缓存的 system prompt。assembleSystemPrompt/contextKey
 * 是纯函数；getSystemPrompt 带进程内缓存，用 resetPromptCache 隔离缓存命中/未命中。
 * updateContext 依据真实状态（工具表 + MEMORY.md 是否存在）推导 context，测试用
 * 临时索引文件验证。agentLoop 用 fake client 验证工具分发与轮末重新组装。
 */
import * as fs from "node:fs";
import * as path from "node:path";
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
import {
  agentLoop,
  assembleSystemPrompt,
  type Context,
  contextKey,
  getSystemPrompt,
  resetPromptCache,
  updateContext,
} from "./main";

const ctx = (memories = ""): Context => ({
  enabled_tools: ["bash", "read_file", "write_file"],
  workspace: "/repo",
  memories,
});

beforeEach(() => {
  resetPromptCache();
});

// ── assembleSystemPrompt ──────────────────────────────────
describe("assembleSystemPrompt", () => {
  it("always includes identity, tools, and workspace", () => {
    const prompt = assembleSystemPrompt(ctx());
    expect(prompt).toContain("You are a coding agent");
    expect(prompt).toContain("Available tools");
    expect(prompt).not.toContain("Relevant memories:");
  });

  it("appends a memories section only when memories are present", () => {
    expect(assembleSystemPrompt(ctx("- [a](a.md) — x"))).toContain(
      "Relevant memories:\n- [a](a.md) — x",
    );
  });
});

// ── contextKey ────────────────────────────────────────────
describe("contextKey", () => {
  it("is stable regardless of key insertion order", () => {
    const a: Context = {
      enabled_tools: ["bash"],
      workspace: "/r",
      memories: "",
    };
    const b = {
      memories: "",
      workspace: "/r",
      enabled_tools: ["bash"],
    } as Context;
    expect(contextKey(a)).toBe(contextKey(b));
  });

  it("differs when context content differs", () => {
    expect(contextKey(ctx())).not.toBe(contextKey(ctx("something")));
  });
});

// ── getSystemPrompt cache ─────────────────────────────────
describe("getSystemPrompt", () => {
  it("returns a cached identical string for an unchanged context", () => {
    const first = getSystemPrompt(ctx());
    const second = getSystemPrompt(ctx()); // equal-but-rebuilt context → still a hit
    expect(second).toBe(first);
  });

  it("reassembles when the context changes", () => {
    const withoutMem = getSystemPrompt(ctx());
    const withMem = getSystemPrompt(ctx("- [a](a.md) — x"));
    expect(withMem).not.toBe(withoutMem);
    expect(withMem).toContain("Relevant memories:");
  });
});

// ── updateContext (real state) ────────────────────────────
describe("updateContext", () => {
  let tmp = "";

  useTempDir(import.meta.dirname, (dir) => {
    tmp = dir;
  });

  it("reports the enabled tools and empty memories when no index exists", () => {
    const context = updateContext(path.join(tmp, "MEMORY.md"));
    expect(context.enabled_tools).toEqual(["bash", "read_file", "write_file"]);
    expect(context.memories).toBe("");
  });

  it("loads memory index content when the file exists", () => {
    const indexPath = path.join(tmp, "MEMORY.md");
    fs.writeFileSync(indexPath, "- [a](a.md) — remembered\n");
    expect(updateContext(indexPath).memories).toBe("- [a](a.md) — remembered");
  });
});

// ── agentLoop ─────────────────────────────────────────────
describe("agentLoop", () => {
  const memoryIndex = path.join(
    import.meta.dirname,
    "nonexistent",
    "MEMORY.md",
  );

  it("executes a plain tool call and returns the final text", async () => {
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

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("done");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });

  it("returns immediately when the first response needs no tools", async () => {
    const client = fakeClient(
      fakeMessage([textBlock("just text")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex,
    });

    expect(result).toBe("just text");
  });
});

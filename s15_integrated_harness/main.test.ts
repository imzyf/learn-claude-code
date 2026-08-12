/**
 * s15_integrated_harness/main.test.ts
 *
 * s15 只做集成，测试也只覆盖集成层新增的东西：
 *   - 工具池：25 个内置工具 + s14 的 MCP 工具合并、schema 覆盖、callTool 分发
 *   - system prompt：固定段 + 每轮变化的 skills / 记忆 / MCP 段
 *   - 错误恢复：错误分类、退避重试、连续 529 切 fallback、超限后放弃
 *   - agentLoop：工具轮、hook 拦截、compact 拦截、后台派发与通知回收、
 *     cron 注入与销账 / 失败撤回、max_tokens 升配额与续写、reactive compact
 * 各机制自身（压缩、记忆、任务板、队友、cron 队列、MCP 边界）已在 s08~s14 覆盖，
 * 这里不重复，只验证它们接进同一个循环后的行为。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../lib/model";
import {
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { createHooks, type HookSystem } from "../s04_hooks/main";
import { resetNagCounter } from "../s05_todo_write/main";
import { BackgroundManager } from "../s11_background_tasks/main";
import { createCronState, scheduleJob } from "../s12_cron_scheduler/main";
import { createTeamState } from "../s13_agent_teams/main";
import {
  connectMcp,
  createMcpState,
  MCPClient,
  McpState,
} from "../s14_mcp_plugin/main";
import {
  agentLoop,
  assembleSystemPrompt,
  assembleToolPool,
  BUILTIN_TOOLS,
  CONTINUATION_PROMPT,
  callTool,
  classifyApiError,
  type Deps,
  hasToolUse,
  MAX_RETRIES,
  makeHarnessHandlers,
  RecoveryState,
  retryDelay,
  TOOL_SCHEMAS,
  withRetry,
} from "./main";

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
  // 唠叨计数器是 s05 的模块级状态，用例之间要复位，否则会被上一个用例
  // 攒下的轮数带出一条 <reminder>。
  resetNagCounter();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 主循环的响应按序弹出；记忆召回 / 提取、压缩摘要这类子请求不带 tools，
// 统一回一个空 JSON 数组，不消耗主循环的预设响应。
// 数组里放 Error 表示这次调用抛错（用来测恢复路径）。
function harnessClient(...responses: (Anthropic.Message | Error)[]): {
  client: ModelClient;
  mainCalls: () => Anthropic.MessageCreateParamsNonStreaming[];
} {
  const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create = vi.fn(
    async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      if (!params.tools) return fakeMessage([textBlock("[]")], "end_turn");
      seen.push(params);
      const next = responses.shift();
      if (!next) throw new Error("fake client ran out of responses");
      if (next instanceof Error) throw next;
      return next;
    },
  );
  return { client: { messages: { create } }, mainCalls: () => seen };
}

// 全部跨轮状态都落在临时目录，用例之间互不影响。
function makeDeps(client: ModelClient, hooks?: HookSystem): Deps {
  return {
    client,
    logger: noopLogger,
    hooks: hooks ?? createHooks(noopLogger),
    skills: {},
    team: createTeamState(dir),
    cron: createCronState(dir),
    mcp: createMcpState(),
    background: new BackgroundManager(),
    memoryDir: path.join(dir, ".memory"),
    sessionDir: dir,
    activeRequest: "hi",
  };
}

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const toolResults = (
  message: Anthropic.MessageParam,
): Anthropic.ToolResultBlockParam[] =>
  message.content as Anthropic.ToolResultBlockParam[];

// ── 工具池 ────────────────────────────────────────────────
describe("工具池", () => {
  it("内置工具是 code.py 的那 25 个，名字不重复", () => {
    const names = BUILTIN_TOOLS.map((tool) => tool.name);
    expect(names).toHaveLength(25);
    expect(new Set(names).size).toBe(25);
    // 各章的代表工具都在：s05 / s06 / s07 / s08 / s10 / s12 / s13 / s14。
    expect(names).toEqual(
      expect.arrayContaining([
        "todo_write",
        "task",
        "load_skill",
        "compact",
        "claim_task",
        "schedule_cron",
        "spawn_teammate",
        "create_worktree",
        "connect_mcp",
      ]),
    );
  });

  it("bash 带 run_in_background，compact 之外的工具都有 schema", () => {
    const bash = BUILTIN_TOOLS.find((tool) => tool.name === "bash");
    expect(Object.keys(bash?.input_schema.properties ?? {})).toContain(
      "run_in_background",
    );
    // compact 由 agentLoop 拦截，不走 dispatch，所以不进 schema 表。
    const missing = BUILTIN_TOOLS.map((tool) => tool.name).filter(
      (name) => name !== "compact" && !TOOL_SCHEMAS[name],
    );
    expect(missing).toEqual([]);
    expect(TOOL_SCHEMAS.compact).toBeUndefined();
  });

  it("连接后把 mcp__server__tool 叠到内置工具之上", async () => {
    const mcp = createMcpState();
    expect(assembleToolPool(mcp, {}).tools).toHaveLength(25);

    connectMcp("docs", mcp);
    const pool = assembleToolPool(mcp, { bash: () => "builtin" });
    expect(pool.tools.map((tool) => tool.name)).toEqual([
      ...BUILTIN_TOOLS.map((tool) => tool.name),
      "mcp__docs__search",
      "mcp__docs__get_version",
    ]);
    // 宿主策略由 s14 的组装过程重建，MCP 权限 hook 靠它判断是否要确认。
    expect(mcp.toolPolicies.get("mcp__docs__search")).toBe("allow");
    // MCP 工具在 TOOL_SCHEMAS 里查不到，参数校验留在 MCPClient 那一侧。
    const call = toolUseBlock("t", "mcp__docs__search", { query: "loop" });
    expect(await callTool(call, pool.handlers)).toBe(
      "[docs] Found 3 results for 'loop'",
    );
  });

  it("规范化后撞名时整份工具池组装失败", () => {
    const first = new MCPClient("docs.one");
    first.register([{ name: "search" }], { search: () => "one" });
    const second = new MCPClient("docs_one");
    second.register([{ name: "search" }], { search: () => "two" });
    const mcp = new McpState({
      "docs.one": () => first,
      docs_one: () => second,
    });
    connectMcp("docs.one", mcp);
    connectMcp("docs_one", mcp);
    expect(() => assembleToolPool(mcp, {})).toThrow(
      "MCP tool name collision after normalization",
    );
  });

  it("callTool 校验参数、并对未知工具回可读文本", async () => {
    const handlers = makeHarnessHandlers(makeDeps(harnessClient().client));
    expect(await callTool(toolUseBlock("t", "list_tasks", {}), handlers)).toBe(
      "No tasks. Use create_task to add some.",
    );
    expect(
      await callTool(toolUseBlock("t", "bash", { command: 1 }), handlers),
    ).toMatch(/^Error: /);
    expect(await callTool(toolUseBlock("t", "nope", {}), handlers)).toBe(
      "Unknown tool: nope",
    );
  });
});

// ── system prompt ─────────────────────────────────────────
describe("assembleSystemPrompt", () => {
  it("固定段常在，记忆与 MCP 段按当前状态出现", () => {
    const mcp = createMcpState();
    const base = assembleSystemPrompt({
      skills: {},
      memoryIndex: "",
      memories: "",
      mcp,
    });
    expect(base).toContain("You are a coding agent. Act, don't explain.");
    expect(base).toContain("Working directory: ");
    expect(base).toContain("Skills catalog:");
    expect(base).not.toContain("Memory catalog:");
    expect(base).not.toContain("Connected MCP servers:");

    connectMcp("docs", mcp);
    const full = assembleSystemPrompt({
      skills: {
        review: { name: "review", description: "code review", content: "..." },
      },
      memoryIndex: "- [tabs](tabs.md) - 用户偏好 tab",
      memories: '[{"source":"tabs.md"}]',
      mcp,
    });
    expect(full).toContain("- review: code review");
    expect(full).toContain("Memory catalog:\n- [tabs](tabs.md)");
    expect(full).toContain("Relevant memory records:");
    expect(full).toContain("Connected MCP servers: docs");
  });
});

// ── 错误恢复 ──────────────────────────────────────────────
describe("错误恢复", () => {
  it("按名字、status 和文案分类 API 错误", () => {
    expect(
      classifyApiError(Object.assign(new Error("slow down"), { status: 429 })),
    ).toBe("rate_limit");
    expect(classifyApiError(new Error("Overloaded"))).toBe("overloaded");
    expect(classifyApiError(new Error("prompt is too long"))).toBe("too_long");
    expect(classifyApiError(new Error("prompt_too_long"))).toBe("too_long");
    expect(classifyApiError(new Error("boom"))).toBe("other");
  });

  it("退避随重试次数递增并封顶", () => {
    expect(retryDelay(0)).toBeGreaterThanOrEqual(500);
    expect(retryDelay(0)).toBeLessThan(retryDelay(4));
    expect(retryDelay(20)).toBeLessThanOrEqual(32_000 * 1.25);
  });

  it("429 重试后成功，非限流错误原样抛出", async () => {
    const state = new RecoveryState();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("429 rate limit");
        return "ok";
      },
      state,
      noopLogger,
      { delay: () => 0 },
    );
    expect([result, calls]).toEqual(["ok", 2]);

    await expect(
      withRetry(
        async () => {
          throw new Error("boom");
        },
        new RecoveryState(),
        noopLogger,
        { delay: () => 0 },
      ),
    ).rejects.toThrow("boom");
  });

  it("连续 529 切到 fallback model，重试用完则放弃", async () => {
    const state = new RecoveryState();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw new Error("529 overloaded");
        return "ok";
      },
      state,
      noopLogger,
      { delay: () => 0, fallbackModel: "backup-model" },
    );
    expect(state.currentModel).toBe("backup-model");
    // 切换后计数复位，成功一次也复位。
    expect(state.consecutive529).toBe(0);

    await expect(
      withRetry(
        async () => {
          throw new Error("429 rate limit");
        },
        new RecoveryState(),
        noopLogger,
        { delay: () => 0 },
      ),
    ).rejects.toThrow(`Max retries (${MAX_RETRIES}) exceeded`);
  });
});

// ── agentLoop ─────────────────────────────────────────────
describe("agentLoop", () => {
  it("跑一轮工具再收尾，system prompt 每轮带上集成状态", async () => {
    const { client, mainCalls } = harnessClient(
      fakeMessage(
        [toolUseBlock("t1", "create_task", { subject: "ship it" })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "建个任务" },
    ];

    expect(await agentLoop(messages, makeDeps(client))).toBe("done");
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(String(toolResults(messages[2])[0].content)).toMatch(
      /^Created task_/,
    );
    expect(String(mainCalls()[0].system)).toContain("Available tools: bash");
    expect(mainCalls()[0].tools).toHaveLength(25);
  });

  it("hasToolUse 决定是否再跑一轮工具", () => {
    expect(hasToolUse(fakeMessage([textBlock("hi")], "end_turn"))).toBe(false);
    expect(
      hasToolUse(
        fakeMessage([toolUseBlock("t", "list_tasks", {})], "end_turn"),
      ),
    ).toBe(true);
  });

  it("PreToolUse hook 拦截时把拦截文案当成 tool_result", async () => {
    const hooks = createHooks(noopLogger);
    hooks.register("PreToolUse", () => "Permission denied by deny list");
    const { client } = harnessClient(
      fakeMessage(
        [toolUseBlock("t1", "bash", { command: "sudo rm -rf /" })],
        "tool_use",
      ),
      fakeMessage([textBlock("stopped")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "清理" },
    ];

    await agentLoop(messages, makeDeps(client, hooks));
    expect(toolResults(messages[2])[0].content).toBe(
      "Permission denied by deny list",
    );
  });

  it("compact 工具用摘要重写历史，且不追加孤立的 tool_result", async () => {
    const { client } = harnessClient(
      fakeMessage([toolUseBlock("t1", "compact", {})], "tool_use"),
      fakeMessage([textBlock("compacted")], "end_turn"),
    );
    const request = "太长了，压缩一下";
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: request },
    ];

    const deps = { ...makeDeps(client), activeRequest: request };
    expect(await agentLoop(messages, deps)).toBe("compacted");
    // 压缩后历史只剩摘要那一条（加上压缩后新产生的 assistant 回复）。
    expect(messages).toHaveLength(2);
    expect(String(messages[0].content)).toContain("[Compacted]");
    expect(String(messages[0].content)).toContain("太长了，压缩一下");
    expect(messages.some((m) => JSON.stringify(m).includes("t1"))).toBe(false);
  });

  it("后台 bash 先回占位结果，完成后以 task_notification 回到对话", async () => {
    const deps = makeDeps(
      harnessClient(
        fakeMessage(
          [
            toolUseBlock("t1", "bash", {
              command: "echo integrated",
              run_in_background: true,
            }),
          ],
          "tool_use",
        ),
        fakeMessage([textBlock("派发完成")], "end_turn"),
      ).client,
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "后台跑一下" },
    ];

    await agentLoop(messages, deps);
    expect(String(toolResults(messages[2])[0].content)).toContain(
      "[Background task bg_0001 started]",
    );

    // 命令跑完后，下一轮开局把结果注入对话。
    await waitFor(() =>
      Object.values(deps.background.tasks).some((t) => t.status !== "running"),
    );
    const next = harnessClient(fakeMessage([textBlock("收到")], "end_turn"));
    await agentLoop(messages, { ...deps, client: next.client });
    const notification = JSON.stringify(messages);
    expect(notification).toContain("<task_notification>");
    expect(notification).toContain("integrated");
  });

  it("cron 到期的 prompt 注入本轮，模型接收后一次性任务销账", async () => {
    const deps = makeDeps(
      harnessClient(fakeMessage([textBlock("跑完了")], "end_turn")).client,
    );
    const job = scheduleJob(
      deps.cron,
      "* * * * *",
      "run tests",
      false,
      false,
      noopLogger,
    );
    if (typeof job === "string") throw new Error(job);
    deps.cron.cronQueue.push(job);

    const messages: Anthropic.MessageParam[] = [];
    await agentLoop(messages, deps);
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Scheduled] run tests",
    });
    expect(deps.cron.scheduledJobs.has(job.id)).toBe(false);
  });

  it("模型调用失败时撤回注入的 cron 消息并把任务放回队列", async () => {
    const deps = makeDeps(harnessClient(new Error("boom")).client);
    const job = scheduleJob(
      deps.cron,
      "* * * * *",
      "run tests",
      true,
      false,
      noopLogger,
    );
    if (typeof job === "string") throw new Error(job);
    deps.cron.cronQueue.push(job);

    const messages: Anthropic.MessageParam[] = [];
    expect(await agentLoop(messages, deps)).toContain("[Error]");
    expect(JSON.stringify(messages)).not.toContain("[Scheduled]");
    expect(deps.cron.cronQueue.map((j) => j.id)).toEqual([job.id]);
  });

  it("max_tokens 先升配额，再要求续写", async () => {
    const { client, mainCalls } = harnessClient(
      fakeMessage([textBlock("一半")], "max_tokens"),
      fakeMessage([textBlock("还是一半")], "max_tokens"),
      fakeMessage([textBlock("写完了")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "写一篇长文" },
    ];

    expect(await agentLoop(messages, makeDeps(client))).toBe("写完了");
    expect(mainCalls().map((call) => call.max_tokens)).toEqual([
      8000, 16_000, 16_000,
    ]);
    expect(messages[2]).toEqual({ role: "user", content: CONTINUATION_PROMPT });
  });

  it("prompt 超长触发一次 reactive compact 后重试", async () => {
    const { client, mainCalls } = harnessClient(
      new Error("prompt is too long"),
      fakeMessage([textBlock("重试成功")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "很长的历史" },
    ];

    expect(await agentLoop(messages, makeDeps(client))).toBe("重试成功");
    expect(mainCalls()).toHaveLength(2);
    expect(String(messages[0].content)).toContain("[Reactive compact]");
  });
});

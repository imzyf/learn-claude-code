/**
 * s13_background_tasks/main.test.ts
 *
 * s13 的新增点是后台任务层，测试只聚焦这一层：
 *   - isSlowOperation / shouldRunBackground 的判定（纯函数）
 *   - runBashAsync 的输出与非零退出时的输出保留
 *   - startBackgroundTask 派发 + collectBackgroundResults 收集通知的生命周期
 *   - bash 工具覆盖后仍带 run_in_background，且 s12 的任务工具仍在
 *   - agentLoop 端到端派发一次后台 bash，回传占位符
 * 任务系统 / prompt 组装 / context 推导已在 s12 / s10 覆盖，这里不再重复。
 */
import * as fs from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import type { Context } from "../s10_system_prompt/main";
import {
  agentLoop,
  BackgroundState,
  collectBackgroundResults,
  isSlowOperation,
  runBashAsync,
  shouldRunBackground,
  startBackgroundTask,
  TOOL_SCHEMAS,
  tools,
} from "./main";

const ctx = (): Context => ({
  enabled_tools: ["bash", "read_file", "write_file"],
  workspace: "/repo",
  memories: "",
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// 轮询等待后台 worker 完成（游离 Promise，无法直接 await）。
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── isSlowOperation：启发式判定 ────────────────────────────
describe("isSlowOperation", () => {
  it("flags slow bash commands by keyword", () => {
    expect(isSlowOperation("bash", { command: "npm install" })).toBe(true);
    expect(isSlowOperation("bash", { command: "pytest tests/" })).toBe(true);
    expect(isSlowOperation("bash", { command: "make build" })).toBe(true);
  });

  it("leaves fast bash commands in the foreground", () => {
    expect(isSlowOperation("bash", { command: "ls -la" })).toBe(false);
    expect(isSlowOperation("bash", { command: "echo hi" })).toBe(false);
  });

  it("never backgrounds non-bash tools", () => {
    expect(isSlowOperation("read_file", { command: "make" })).toBe(false);
  });
});

// ── shouldRunBackground：显式请求优先 ──────────────────────
describe("shouldRunBackground", () => {
  it("honors an explicit run_in_background flag over the heuristic", () => {
    expect(
      shouldRunBackground("bash", { command: "ls", run_in_background: true }),
    ).toBe(true);
  });

  it("falls back to the heuristic when the flag is absent", () => {
    expect(shouldRunBackground("bash", { command: "npm run build" })).toBe(
      true,
    );
    expect(shouldRunBackground("bash", { command: "ls" })).toBe(false);
  });
});

// ── runBashAsync ──────────────────────────────────────────
describe("runBashAsync", () => {
  it("returns trimmed stdout", async () => {
    expect(await runBashAsync("echo hello", noopLogger)).toBe("hello");
  });

  it("preserves captured output on a non-zero exit", async () => {
    expect(await runBashAsync("echo boom && exit 1", noopLogger)).toContain(
      "boom",
    );
  });

  it("reports empty output as a placeholder", async () => {
    expect(await runBashAsync("true", noopLogger)).toBe("(no output)");
  });
});

// ── 后台生命周期：派发 -> 完成 -> 收集通知 ─────────────────
describe("startBackgroundTask / collectBackgroundResults", () => {
  it("dispatches a bash task and collects it once complete", async () => {
    const state = new BackgroundState();
    const backgroundId = startBackgroundTask(
      state,
      {},
      "bash",
      "tu_1",
      { command: "echo done-bg" },
      noopLogger,
    );
    expect(backgroundId).toBe("background_0001");
    expect(state.tasks[backgroundId].status).toBe("running");

    await waitFor(() => state.tasks[backgroundId]?.status === "completed");
    const notes = collectBackgroundResults(state, noopLogger);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("<task_id>background_0001</task_id>");
    expect(notes[0]).toContain("<status>completed</status>");
    expect(notes[0]).toContain("echo done-bg");
    expect(notes[0]).toContain("done-bg");
    // 收集后从 state 中清除。
    expect(state.tasks[backgroundId]).toBeUndefined();
    expect(state.results[backgroundId]).toBeUndefined();
  });

  it("routes a non-bash tool through its handler", async () => {
    const state = new BackgroundState();
    const handlers = { list_tasks: () => "task list output" };
    const backgroundId = startBackgroundTask(
      state,
      handlers,
      "list_tasks",
      "tu_2",
      {},
      noopLogger,
    );
    await waitFor(() => state.tasks[backgroundId]?.status === "completed");
    expect(state.results[backgroundId]).toBe("task list output");
  });

  it("does not collect tasks that are still running", () => {
    const state = new BackgroundState();
    state.tasks.background_0001 = {
      toolCallId: "tu_1",
      command: "sleep 9",
      status: "running",
    };
    expect(collectBackgroundResults(state, noopLogger)).toHaveLength(0);
    expect(state.tasks.background_0001).toBeDefined();
  });
});

// ── 工具覆盖：bash 加了 run_in_background，任务工具仍在 ─────
describe("tools override", () => {
  it("bash schema accepts run_in_background", () => {
    expect(
      TOOL_SCHEMAS.bash?.parse({ command: "ls", run_in_background: true }),
    ).toEqual({
      command: "ls",
      run_in_background: true,
    });
  });

  it("keeps the base and task tools from s12", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("create_task");
    expect(names).toContain("complete_task");
  });
});

// ── agentLoop：后台派发返回占位符 ──────────────────────────
describe("agentLoop", () => {
  it("dispatches a background bash call and returns a placeholder tool_result", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "bash", {
            command: "echo bg",
            run_in_background: true,
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("kicked off")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "run it in the background" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex: "nonexistent/MEMORY.md",
      tasksDir: dir,
      background: new BackgroundState(),
    });

    expect(result).toBe("kicked off");
    const toolResults = messages[2].content as Anthropic.ContentBlockParam[];
    const first = toolResults[0] as Anthropic.ToolResultBlockParam;
    expect(first.content).toContain(
      "[Background task background_0001 started]",
    );
  });
});

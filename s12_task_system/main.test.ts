/**
 * s12_task_system/main.test.ts
 *
 * s12 的新增点是任务图：createTask/save/load 往返、canStart 的依赖判定、
 * claimTask(pending -> in_progress)、completeTask 完成并汇报下游解除阻塞。
 * 每个用例用临时 .tasks 目录隔离（目录作为参数显式传入）。agentLoop 只验证
 * 任务工具已并入 dispatch 并能端到端跑通——prompt 组装 / context 推导已在
 * s10 覆盖，这里不再重复。
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
  canStart,
  claimTask,
  completeTask,
  createTask,
  listTasks,
  loadTask,
  runCreateTask,
  runGetTask,
  runListTasks,
} from "./main";

const ctx = (): Context => ({
  enabled_tools: ["bash", "read_file", "write_file"],
  workspace: "/repo",
  memories: "",
});

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 持久化往返 ────────────────────────────────────────────
describe("createTask / loadTask", () => {
  it("persists a pending task with no owner", () => {
    const task = createTask(dir, "write docs", "add README", []);
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();

    const loaded = loadTask(dir, task.id);
    expect(loaded.subject).toBe("write docs");
    expect(loaded.description).toBe("add README");
  });
});

// ── canStart：依赖判定 ─────────────────────────────────────
describe("canStart", () => {
  it("is startable when there are no dependencies", () => {
    const task = createTask(dir, "standalone");
    expect(canStart(dir, task.id)).toBe(true);
  });

  it("is blocked while a dependency is not completed", () => {
    const dep = createTask(dir, "dep");
    const task = createTask(dir, "needs dep", "", [dep.id]);
    expect(canStart(dir, task.id)).toBe(false);
  });

  it("becomes startable once the dependency completes", () => {
    const dep = createTask(dir, "dep");
    const task = createTask(dir, "needs dep", "", [dep.id]);
    claimTask(dir, dep.id, noopLogger);
    completeTask(dir, dep.id, noopLogger);
    expect(canStart(dir, task.id)).toBe(true);
  });

  it("treats a missing dependency as blocking", () => {
    const task = createTask(dir, "needs ghost", "", ["task_missing"]);
    expect(canStart(dir, task.id)).toBe(false);
  });
});

// ── claimTask ─────────────────────────────────────────────
describe("claimTask", () => {
  it("moves a pending task to in_progress and sets the owner", () => {
    const task = createTask(dir, "do it");
    const msg = claimTask(dir, task.id, noopLogger, "worker-1");
    expect(msg).toContain("Claimed");
    const loaded = loadTask(dir, task.id);
    expect(loaded.status).toBe("in_progress");
    expect(loaded.owner).toBe("worker-1");
  });

  it("refuses to claim a task that is not pending", () => {
    const task = createTask(dir, "do it");
    claimTask(dir, task.id, noopLogger);
    const msg = claimTask(dir, task.id, noopLogger);
    expect(msg).toContain("cannot claim");
  });

  it("reports the blockers when dependencies are unmet", () => {
    const dep = createTask(dir, "dep");
    const task = createTask(dir, "needs dep", "", [dep.id]);
    const msg = claimTask(dir, task.id, noopLogger);
    expect(msg).toContain("Blocked by");
    expect(msg).toContain(dep.id);
    expect(loadTask(dir, task.id).status).toBe("pending");
  });
});

// ── completeTask ──────────────────────────────────────────
describe("completeTask", () => {
  it("completes an in-progress task", () => {
    const task = createTask(dir, "do it");
    claimTask(dir, task.id, noopLogger);
    const msg = completeTask(dir, task.id, noopLogger);
    expect(msg).toContain("Completed");
    expect(loadTask(dir, task.id).status).toBe("completed");
  });

  it("refuses to complete a task that is not in_progress", () => {
    const task = createTask(dir, "do it");
    const msg = completeTask(dir, task.id, noopLogger);
    expect(msg).toContain("cannot complete");
  });

  it("reports downstream tasks unblocked by completion", () => {
    const dep = createTask(dir, "dep");
    createTask(dir, "downstream", "", [dep.id]);
    claimTask(dir, dep.id, noopLogger);
    const msg = completeTask(dir, dep.id, noopLogger);
    expect(msg).toContain("Unblocked");
    expect(msg).toContain("downstream");
  });
});

// ── runCreateTask ─────────────────────────────────────────
describe("runCreateTask", () => {
  it("creates a task and reports its id and subject", () => {
    const msg = runCreateTask(dir, "write docs", "add README", undefined, noopLogger);
    expect(msg).toContain("Created");
    expect(msg).toContain("write docs");
    expect(listTasks(dir)).toHaveLength(1);
  });

  it("reports blockedBy dependencies in the message", () => {
    const dep = createTask(dir, "dep");
    const msg = runCreateTask(dir, "needs dep", "", [dep.id], noopLogger);
    expect(msg).toContain("blockedBy");
    expect(msg).toContain(dep.id);
    const created = listTasks(dir).find((t) => t.subject === "needs dep");
    expect(created?.blockedBy).toEqual([dep.id]);
  });
});

// ── runGetTask ────────────────────────────────────────────
describe("runGetTask", () => {
  it("returns the task JSON for an existing task", () => {
    const task = createTask(dir, "inspect me");
    const out = runGetTask(dir, task.id);
    expect(out).toContain(task.id);
    expect(out).toContain("inspect me");
  });

  it("reports an error for a missing task", () => {
    expect(runGetTask(dir, "task_missing")).toContain("not found");
  });
});

// ── runListTasks ──────────────────────────────────────────
describe("runListTasks", () => {
  it("prompts to create tasks when none exist", () => {
    expect(runListTasks(dir)).toContain("No tasks");
  });

  it("renders each task with a status icon", () => {
    createTask(dir, "alpha");
    const out = runListTasks(dir);
    expect(out).toContain("alpha");
    expect(out).toContain("[pending]");
    expect(out).toContain("○");
  });
});

// ── agentLoop：任务工具已并入 dispatch ─────────────────────
describe("agentLoop", () => {
  it("runs a task tool end to end and returns the final text", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "create_task", { subject: "ship it" })],
        "tool_use",
      ),
      fakeMessage([textBlock("created")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "make a task" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex: "nonexistent/MEMORY.md",
      tasksDir: dir,
    });

    expect(result).toBe("created");
    // 工具确实落盘了一个任务，且回传的 tool_result 报告了创建。
    expect(listTasks(dir)).toHaveLength(1);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toContain("Created");
  });
});

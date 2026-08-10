/**
 * s10_task_system/main.test.ts
 *
 * s10 的新增点是任务系统，测试只聚焦它：
 *   - TaskStore 的持久化往返、ID 校验、subject / 依赖的合法性检查
 *   - canStart 的依赖判定（未完成、缺失都算阻塞）
 *   - claimTask（pending -> in_progress）、completeTask（owner 校验 + 汇报解除阻塞）
 *   - runCreateTask / runListTasks 的回报文本
 *   - 任务工具已并入 tools 与 dispatch，agentLoop 端到端跑通一次 create_task
 * 每个用例用临时 .tasks 目录隔离。工具层与 hook 层已在 s02-s04 覆盖，这里不再重复。
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
import { createHooks } from "../s04_hooks/main";
import {
  agentLoop,
  canStart,
  claimTask,
  completeTask,
  getTask,
  runCreateTask,
  runListTasks,
  TaskStore,
  tools,
} from "./main";

let dir = "";
let tasks: TaskStore;
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
  tasks = new TaskStore(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 持久化往返 ────────────────────────────────────────────
describe("TaskStore", () => {
  it("persists a pending task with no owner", () => {
    const task = tasks.create("write docs", "add README");
    expect(task.id).toMatch(/^task_[0-9a-f]{8}$/);
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();

    const loaded = tasks.load(task.id);
    expect(loaded.subject).toBe("write docs");
    expect(loaded.description).toBe("add README");
  });

  it("lists tasks and reports an empty store before anything is created", () => {
    expect(tasks.list()).toEqual([]);
    tasks.create("alpha");
    tasks.create("beta");
    expect(
      tasks
        .list()
        .map((t) => t.subject)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("rejects an empty subject", () => {
    expect(() => tasks.create("   ")).toThrow("cannot be empty");
  });

  it("rejects a dependency that does not exist", () => {
    expect(() => tasks.create("needs ghost", "", ["task_deadbeef"])).toThrow(
      "Dependency not found",
    );
  });

  it("deduplicates blockedBy", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id, dep.id]);
    expect(task.blockedBy).toEqual([dep.id]);
  });

  it("rejects an ID that is not task_ + 8 hex chars", () => {
    expect(() => tasks.load("task_missing")).toThrow("Invalid task ID");
    expect(() => tasks.load("../escape")).toThrow("Invalid task ID");
  });
});

// ── canStart：依赖判定 ─────────────────────────────────────
describe("canStart", () => {
  it("is startable when there are no dependencies", () => {
    const task = tasks.create("standalone");
    expect(canStart(tasks, task.id)).toBe(true);
  });

  it("is blocked while a dependency is not completed", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    expect(canStart(tasks, task.id)).toBe(false);
  });

  it("becomes startable once the dependency completes", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    claimTask(tasks, dep.id, noopLogger);
    completeTask(tasks, dep.id, noopLogger);
    expect(canStart(tasks, task.id)).toBe(true);
  });

  it("treats a dependency whose file is gone as blocking", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    fs.rmSync(`${dir}/${dep.id}.json`);
    expect(canStart(tasks, task.id)).toBe(false);
  });
});

// ── claimTask ─────────────────────────────────────────────
describe("claimTask", () => {
  it("moves a pending task to in_progress and sets the owner", () => {
    const task = tasks.create("do it");
    const msg = claimTask(tasks, task.id, noopLogger, "worker-1");
    expect(msg).toContain("Claimed");
    const loaded = tasks.load(task.id);
    expect(loaded.status).toBe("in_progress");
    expect(loaded.owner).toBe("worker-1");
  });

  it("refuses to claim a task that is not pending", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger);
    expect(claimTask(tasks, task.id, noopLogger)).toContain("cannot claim");
  });

  it("reports the blockers when dependencies are unmet", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    const msg = claimTask(tasks, task.id, noopLogger);
    expect(msg).toContain("Blocked by");
    expect(msg).toContain(dep.id);
    expect(tasks.load(task.id).status).toBe("pending");
  });
});

// ── completeTask ──────────────────────────────────────────
describe("completeTask", () => {
  it("completes an in-progress task", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger);
    expect(completeTask(tasks, task.id, noopLogger)).toContain("Completed");
    expect(tasks.load(task.id).status).toBe("completed");
  });

  it("refuses to complete a task that is not in_progress", () => {
    const task = tasks.create("do it");
    expect(completeTask(tasks, task.id, noopLogger)).toContain(
      "cannot complete",
    );
  });

  it("refuses to complete a task claimed by someone else", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger, "worker-1");
    const msg = completeTask(tasks, task.id, noopLogger, "worker-2");
    expect(msg).toContain("owned by worker-1");
    expect(tasks.load(task.id).status).toBe("in_progress");
  });

  it("reports downstream tasks unblocked by completion", () => {
    const dep = tasks.create("dep");
    tasks.create("downstream", "", [dep.id]);
    claimTask(tasks, dep.id, noopLogger);
    const msg = completeTask(tasks, dep.id, noopLogger);
    expect(msg).toContain("Unblocked");
    expect(msg).toContain("downstream");
  });

  it("does not re-report tasks that were already unblocked", () => {
    const first = tasks.create("first");
    const second = tasks.create("second");
    tasks.create("downstream", "", [first.id]);
    claimTask(tasks, first.id, noopLogger);
    completeTask(tasks, first.id, noopLogger);
    // downstream 在 first 完成时就已就绪，完成 second 不该再汇报一次。
    claimTask(tasks, second.id, noopLogger);
    expect(completeTask(tasks, second.id, noopLogger)).not.toContain(
      "Unblocked",
    );
  });
});

// ── 工具 handler 的回报文本 ────────────────────────────────
describe("runCreateTask / runListTasks / getTask", () => {
  it("creates a task and reports its id and subject", () => {
    const msg = runCreateTask(
      tasks,
      "write docs",
      "add README",
      undefined,
      noopLogger,
    );
    expect(msg).toContain("Created");
    expect(msg).toContain("write docs");
    expect(tasks.list()).toHaveLength(1);
  });

  it("reports blockedBy dependencies in the message", () => {
    const dep = tasks.create("dep");
    const msg = runCreateTask(tasks, "needs dep", "", [dep.id], noopLogger);
    expect(msg).toContain("blockedBy");
    expect(msg).toContain(dep.id);
  });

  it("prompts to create tasks when none exist", () => {
    expect(runListTasks(tasks)).toContain("No tasks");
  });

  it("renders each task with a status marker", () => {
    tasks.create("alpha");
    const out = runListTasks(tasks);
    expect(out).toContain("alpha");
    expect(out).toContain("[pending]");
    expect(out).toContain("[ ]");
  });

  it("returns the full task JSON", () => {
    const task = tasks.create("inspect me", "with details");
    const out = getTask(tasks, task.id);
    expect(out).toContain(task.id);
    expect(out).toContain("with details");
  });
});

// ── 工具集：基础五工具 + 五个任务工具 ──────────────────────
describe("tools", () => {
  it("merges the task tools onto the five base tools", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "create_task",
      "list_tasks",
      "get_task",
      "claim_task",
      "complete_task",
    ]);
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

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      tasks,
    });

    expect(result).toBe("created");
    // 工具确实写了一个任务文件，且回传的 tool_result 报告了创建。
    expect(tasks.list()).toHaveLength(1);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toContain("Created");
  });

  it("turns a bad task ID into an error tool_result instead of throwing", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "get_task", { task_id: "nope" })],
        "tool_use",
      ),
      fakeMessage([textBlock("no such task")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "show me task nope" },
    ];

    await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      tasks,
    });

    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toContain("Invalid task ID");
  });
});

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
  it("持久化没有负责人的待处理任务", () => {
    const task = tasks.create("write docs", "add README");
    expect(task.id).toMatch(/^task_[0-9a-f]{8}$/);
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();

    const loaded = tasks.load(task.id);
    expect(loaded.subject).toBe("write docs");
    expect(loaded.description).toBe("add README");
  });

  it("列出任务，并在尚未创建任务时报告存储为空", () => {
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

  it("拒绝空主题", () => {
    expect(() => tasks.create("   ")).toThrow("cannot be empty");
  });

  it("拒绝不存在的依赖项", () => {
    expect(() => tasks.create("needs ghost", "", ["task_deadbeef"])).toThrow(
      "Dependency not found",
    );
  });

  it("对 blockedBy 去重", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id, dep.id]);
    expect(task.blockedBy).toEqual([dep.id]);
  });

  it("拒绝不符合 task_ 加 8 位十六进制字符格式的 ID", () => {
    expect(() => tasks.load("task_missing")).toThrow("Invalid task ID");
    expect(() => tasks.load("../escape")).toThrow("Invalid task ID");
  });
});

// ── canStart：依赖判定 ─────────────────────────────────────
describe("canStart", () => {
  it("没有依赖项时可以开始", () => {
    const task = tasks.create("standalone");
    expect(canStart(tasks, task.id)).toBe(true);
  });

  it("依赖项未完成时保持阻塞", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    expect(canStart(tasks, task.id)).toBe(false);
  });

  it("依赖项完成后可以开始", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    claimTask(tasks, dep.id, noopLogger);
    completeTask(tasks, dep.id, noopLogger);
    expect(canStart(tasks, task.id)).toBe(true);
  });

  it("依赖文件消失时视为阻塞", () => {
    const dep = tasks.create("dep");
    const task = tasks.create("needs dep", "", [dep.id]);
    fs.rmSync(`${dir}/${dep.id}.json`);
    expect(canStart(tasks, task.id)).toBe(false);
  });
});

// ── claimTask ─────────────────────────────────────────────
describe("claimTask", () => {
  it("将待处理任务改为 in_progress 并设置负责人", () => {
    const task = tasks.create("do it");
    const msg = claimTask(tasks, task.id, noopLogger, "worker-1");
    expect(msg).toContain("Claimed");
    const loaded = tasks.load(task.id);
    expect(loaded.status).toBe("in_progress");
    expect(loaded.owner).toBe("worker-1");
  });

  it("拒绝认领非待处理状态的任务", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger);
    expect(claimTask(tasks, task.id, noopLogger)).toContain("cannot claim");
  });

  it("依赖项未满足时报告阻塞项", () => {
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
  it("完成进行中的任务", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger);
    expect(completeTask(tasks, task.id, noopLogger)).toContain("Completed");
    expect(tasks.load(task.id).status).toBe("completed");
  });

  it("拒绝完成非 in_progress 状态的任务", () => {
    const task = tasks.create("do it");
    expect(completeTask(tasks, task.id, noopLogger)).toContain(
      "cannot complete",
    );
  });

  it("拒绝完成由其他人认领的任务", () => {
    const task = tasks.create("do it");
    claimTask(tasks, task.id, noopLogger, "worker-1");
    const msg = completeTask(tasks, task.id, noopLogger, "worker-2");
    expect(msg).toContain("owned by worker-1");
    expect(tasks.load(task.id).status).toBe("in_progress");
  });

  it("报告因任务完成而解除阻塞的下游任务", () => {
    const dep = tasks.create("dep");
    tasks.create("downstream", "", [dep.id]);
    claimTask(tasks, dep.id, noopLogger);
    const msg = completeTask(tasks, dep.id, noopLogger);
    expect(msg).toContain("Unblocked");
    expect(msg).toContain("downstream");
  });

  it("不重复报告已经解除阻塞的任务", () => {
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
  it("创建任务并报告其 ID 和主题", () => {
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

  it("在消息中报告 blockedBy 依赖项", () => {
    const dep = tasks.create("dep");
    const msg = runCreateTask(tasks, "needs dep", "", [dep.id], noopLogger);
    expect(msg).toContain("blockedBy");
    expect(msg).toContain(dep.id);
  });

  it("没有任务时提示创建任务", () => {
    expect(runListTasks(tasks)).toContain("No tasks");
  });

  it("渲染每个任务及其状态标记", () => {
    tasks.create("alpha");
    const out = runListTasks(tasks);
    expect(out).toContain("alpha");
    expect(out).toContain("[pending]");
    expect(out).toContain("[ ]");
  });

  it("返回完整的任务 JSON", () => {
    const task = tasks.create("inspect me", "with details");
    const out = getTask(tasks, task.id);
    expect(out).toContain(task.id);
    expect(out).toContain("with details");
  });
});

// ── 工具集：基础五工具 + 五个任务工具 ──────────────────────
describe("tools", () => {
  it("在五个基础工具上合并任务工具", () => {
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
  it("端到端运行任务工具并返回最终文本", async () => {
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

  it("将无效任务 ID 转为错误 tool_result 而不是抛出异常", async () => {
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

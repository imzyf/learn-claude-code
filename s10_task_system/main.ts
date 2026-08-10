/**
 * s10_task_system/main.ts - 任务系统
 *
 * 带 blockedBy 依赖的任务图，每个任务一份 JSON，跨会话可恢复。
 *
 *     .tasks/
 *       task_a1b2c3d4.json  {status: completed, blockedBy: []}
 *       task_e5f6a7b8.json  {status: pending,   blockedBy: [task_a1b2c3d4]}
 *       task_11223344.json  {status: pending,   blockedBy: [task_e5f6a7b8]}
 *
 *     +-----------+      +-----------+      +-----------+
 *     | schema    | ---> | API       | ---> | tests     |
 *     | completed |      | pending   |      | pending   |
 *     +-----------+      +-----------+      +-----------+
 *
 *     canStart(API) 为 true，因为 schema 已 completed。
 *     生命周期：pending --claimTask--> in_progress --completeTask--> completed
 *
 * 相比 s04 的变化：
 *   工具层与 hook 层直接复用，不再内联：tools / TOOL_SCHEMAS 复用 s02，
 *   TOOL_HANDLERS 复用 s03，hook 系统（loadHooks / HookSystem / Deps）复用 s04。
 *   本文件只新增任务系统这一层：
 *   + Task 类型（id、subject、description、status、owner、blockedBy）
 *   + TaskStore：校验任务 ID、读写 <dir>/task_xxxxxxxx.json，目录不得越出工作区
 *   + tasksDirFor(sessionDir) = <session>/.tasks/
 *   + incompleteDependencies / canStart：依赖缺失或未完成即视为被阻塞
 *   + claimTask：设置 owner，pending -> in_progress
 *   + completeTask：校验 owner，置为 completed，并汇报刚被解除阻塞的下游任务
 *   + 5 个任务工具，合并进 s02 的 tools / TOOL_SCHEMAS 与 s03 的 dispatch 表
 *
 * TS 特有说明：
 *   - code.py 用模块级的 TASKS = TaskStore(TASKS_DIR)；这里把 store 经 deps 传入
 *     （同 s09 的风格），入口用 tasksDirFor(import.meta.dirname) 落到各自的 session
 *     目录，测试注入临时目录做隔离。
 *   - 任务 handler 需要 logger 打印状态迁移、store 定位存储，用 makeTaskHandlers
 *     工厂闭包捕获二者，再与 s03 的纯基础分发表合并（基础工具不依赖 logger）。
 *   - ID 用 crypto.randomBytes(4) 生成 8 位十六进制；写文件用 "wx" 排他标志，
 *     撞到已存在的 ID 就重试，对应 Python 的 open(..., "x")。
 *
 * 基于 s04（hooks）构建。Usage:
 *
 *     pnpm dev s10_task_system/main.ts
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）+ errMsg。
import {
  errMsg,
  type Handlers,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
  tools as s02Tools,
} from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）+ 权限确认抽象（makeConfirm）。
import {
  makeConfirm,
  TOOL_HANDLERS as S03_TOOL_HANDLERS,
} from "../s03_permission/main";
// 来自 s04：hook 系统（装配 + 触发）与 Deps（client + logger + hooks）。
import { loadHooks, type Deps as S04Deps } from "../s04_hooks/main";

const WORKDIR = process.cwd();
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  `Use task tools to track dependencies and progress.`;

// deps 与 s04 一致，另加 tasks：任务存储由 session 持有并跨轮传入。
export type Deps = S04Deps & { tasks: TaskStore };

// ═══════════════════════════════════════════════════════════
//  s10 新增：任务记录与存储
// ═══════════════════════════════════════════════════════════

// 存储目录名（仿照 logger 的 .log/）；具体目录由 tasksDirFor 决定，
// 目录作为参数显式传入（同 s09 的风格），测试传入临时目录做隔离。
export const TASKS_DIR_NAME = ".tasks";

// 按 session 目录定位 .tasks/，让每个 session 的任务落在自己目录下。
export function tasksDirFor(sessionDir: string): string {
  return path.join(sessionDir, TASKS_DIR_NAME);
}

// 任务状态机：pending -> in_progress -> completed
export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type Task = {
  // 任务唯一标识，形如 task_a1b2c3d4
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null; // agent 名（多 agent 场景）
  blockedBy: string[]; // 依赖的任务 ID
};

// 任务 ID 只允许 task_ + 8 位十六进制：它会被拼进文件名，
// 校验放在拼路径之前，`..` 之类的输入连文件名都构不成。
const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

// 一份 .tasks/ 目录的读写封装：校验 ID、拼路径、序列化 JSON。
export class TaskStore {
  constructor(readonly directory: string) {}

  // 存储根目录；create 时才建目录，读路径上不产生副作用。
  // 目录本身也要待在工作区内，否则任务文件会写到工作区之外。
  private root(create = false): string {
    if (create) fs.mkdirSync(this.directory, { recursive: true });
    const root = path.resolve(WORKDIR, this.directory);
    if (root !== WORKDIR && !root.startsWith(WORKDIR + path.sep)) {
      throw new Error("Task store escapes the workspace");
    }
    return root;
  }

  private taskPath(taskId: string, createRoot = false): string {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`Invalid task ID: ${taskId}`);
    }
    return path.join(this.root(createRoot), `${taskId}.json`);
  }

  exists(taskId: string): boolean {
    return fs.existsSync(this.taskPath(taskId));
  }

  // 创建任务并立即落盘。subject 不能为空，依赖必须已经存在，
  // 否则任务图一开始就指向一个永远不会完成的 ID。
  create(subject: string, description = "", blockedBy: string[] = []): Task {
    const trimmed = subject.trim();
    if (!trimmed) throw new Error("Task subject cannot be empty");

    const dependencies = [...new Set(blockedBy)];
    for (const dependency of dependencies) {
      if (!this.exists(dependency)) {
        throw new Error(`Dependency not found: ${dependency}`);
      }
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task: Task = {
        id: `task_${randomBytes(4).toString("hex")}`,
        subject: trimmed,
        description,
        status: "pending",
        owner: null,
        blockedBy: dependencies,
      };
      try {
        // "wx" = 排他创建：文件已存在就抛 EEXIST，换个 ID 重试。
        fs.writeFileSync(
          this.taskPath(task.id, true),
          JSON.stringify(task, null, 2),
          { flag: "wx" },
        );
        return task;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw new Error("Could not allocate a unique task ID");
  }

  // 保存任务，覆盖原有内容。
  save(task: Task): void {
    fs.writeFileSync(
      this.taskPath(task.id, true),
      JSON.stringify(task, null, 2),
    );
  }

  // 读取任务；文件不存在、ID 对不上、状态不合法都抛错，
  // 由调用方（callTool / incompleteDependencies）决定怎么收敛。
  load(taskId: string): Task {
    const task = JSON.parse(
      fs.readFileSync(this.taskPath(taskId), "utf8"),
    ) as Task;
    if (task.id !== taskId) {
      throw new Error(`Task file ID does not match ${taskId}`);
    }
    if (!TASK_STATUSES.includes(task.status)) {
      throw new Error(`Invalid task status: ${task.status}`);
    }
    return task;
  }

  // 列出所有任务，按文件名排序（ID 随机，顺序稳定但与创建时间无关）。
  list(): Task[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs
      .readdirSync(this.root())
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort()
      .map((f) => this.load(path.basename(f, ".json")));
  }
}

// ── 依赖判定与状态迁移 ─────────────────────────────────────

// 任务的 JSON 字符串表示，供 get_task 返回完整细节。
export function getTask(tasks: TaskStore, taskId: string): string {
  return JSON.stringify(tasks.load(taskId), null, 2);
}

// 还没完成的前置任务；依赖文件缺失或读不出来，同样算作阻塞。
export function incompleteDependencies(tasks: TaskStore, task: Task): string[] {
  const incomplete: string[] = [];
  for (const dependency of task.blockedBy) {
    try {
      if (tasks.load(dependency).status !== "completed") {
        incomplete.push(dependency);
      }
    } catch {
      incomplete.push(dependency);
    }
  }
  return incomplete;
}

// 所有 blockedBy 都已完成时才能开始。
export function canStart(tasks: TaskStore, taskId: string): boolean {
  return incompleteDependencies(tasks, tasks.load(taskId)).length === 0;
}

// 认领任务：设置 owner，pending -> in_progress。
export function claimTask(
  tasks: TaskStore,
  taskId: string,
  logger: SessionLogger,
  owner = "agent",
): string {
  const task = tasks.load(taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  const dependencies = incompleteDependencies(tasks, task);
  if (dependencies.length) {
    return `Blocked by: [${dependencies.join(", ")}]`;
  }
  task.owner = owner;
  task.status = "in_progress";
  tasks.save(task);
  logger.console(
    `  [claim] ${task.subject} -> in_progress (owner: ${owner})`,
    "cyan",
  );
  return `Claimed ${task.id} (${task.subject})`;
}

// 完成任务：只有认领它的 owner 能完成，完成后汇报刚被解除阻塞的下游任务。
// 「刚被解除」= 完成前不可开始、完成后可开始，所以先记下完成前已就绪的集合。
export function completeTask(
  tasks: TaskStore,
  taskId: string,
  logger: SessionLogger,
  owner = "agent",
): string {
  const task = tasks.load(taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  if (task.owner !== owner) {
    return `Task ${taskId} is owned by ${task.owner}, not ${owner}`;
  }

  const readyBefore = new Set(
    tasks
      .list()
      .filter(
        (t) =>
          t.status === "pending" && t.blockedBy.length && canStart(tasks, t.id),
      )
      .map((t) => t.id),
  );
  task.status = "completed";
  tasks.save(task);
  const unblocked = tasks
    .list()
    .filter(
      (t) =>
        t.status === "pending" &&
        t.blockedBy.length &&
        !readyBefore.has(t.id) &&
        canStart(tasks, t.id),
    )
    .map((t) => t.subject);

  logger.console(`  [complete] ${task.subject}`, "green");
  let message = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    message += `\nUnblocked: ${unblocked.join(", ")}`;
    logger.console(`  [unblocked] ${unblocked.join(", ")}`, "yellow");
  }
  return message;
}

// ── 任务工具的 handler ─────────────────────────────────────

// 创建任务，回报 ID、subject 与（去重后的）依赖。
export function runCreateTask(
  tasks: TaskStore,
  subject: string,
  description: string,
  blockedBy: string[] | undefined,
  logger: SessionLogger,
): string {
  const task = tasks.create(subject, description, blockedBy ?? []);
  const deps = task.blockedBy.length
    ? ` (blockedBy: ${task.blockedBy.join(", ")})`
    : "";
  logger.console(`  [create] ${task.subject}${deps}`, "blue");
  return `Created ${task.id}: ${task.subject}${deps}`;
}

// 列出所有任务：状态标记 + owner + 依赖，一任务一行。
export function runListTasks(tasks: TaskStore): string {
  const all = tasks.list();
  if (!all.length) return "No tasks. Use create_task to add some.";
  const markers: Record<TaskStatus, string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
  };
  return all
    .map((t) => {
      const marker = markers[t.status] ?? "[?]";
      const deps = t.blockedBy.length
        ? ` (blockedBy: ${t.blockedBy.join(", ")})`
        : "";
      const owner = t.owner ? ` [${t.owner}]` : "";
      return `${marker} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
    })
    .join("\n");
}

// 任务 handler 需要 logger 打印状态迁移、store 定位存储，用工厂闭包捕获二者，
// 再与 s03 的纯基础分发表合并。
export function makeTaskHandlers(
  tasks: TaskStore,
  logger: SessionLogger,
): Handlers {
  return {
    create_task: ({ subject, description, blockedBy }) =>
      runCreateTask(tasks, subject, description ?? "", blockedBy, logger),
    list_tasks: () => runListTasks(tasks),
    // 任务不存在直接抛错，由 callTool 收敛成 tool_result 里的错误文本。
    get_task: ({ task_id }) => getTask(tasks, task_id),
    claim_task: ({ task_id }) => claimTask(tasks, task_id, logger),
    complete_task: ({ task_id }) => completeTask(tasks, task_id, logger),
  };
}

// ═══════════════════════════════════════════════════════════
//  s10 新增：任务工具定义，合并进 s02 的工具集
// ═══════════════════════════════════════════════════════════

const createTaskSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
});
const listTasksSchema = z.object({});
const getTaskSchema = z.object({ task_id: z.string() });
const claimTaskSchema = z.object({ task_id: z.string() });
const completeTaskSchema = z.object({ task_id: z.string() });

const taskTools: Anthropic.Tool[] = [
  zodTool(
    "create_task",
    "Create a task with optional dependencies.",
    createTaskSchema,
  ),
  zodTool(
    "list_tasks",
    "List tasks with status, owner, and dependencies.",
    listTasksSchema,
  ),
  zodTool("get_task", "Get a task by ID.", getTaskSchema),
  zodTool(
    "claim_task",
    "Claim a pending task whose dependencies are complete.",
    claimTaskSchema,
  ),
  zodTool(
    "complete_task",
    "Complete the task claimed by this agent.",
    completeTaskSchema,
  ),
];

// 基础工具 + 任务工具：tools / TOOL_SCHEMAS 都是纯数据，模块级静态合并。
export const tools: Anthropic.Tool[] = [...s02Tools, ...taskTools];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
  create_task: createTaskSchema,
  list_tasks: listTasksSchema,
  get_task: getTaskSchema,
  claim_task: claimTaskSchema,
  complete_task: completeTaskSchema,
};

// ═══════════════════════════════════════════════════════════
//  工具执行 —— 和 s04 一样：PreToolUse -> handler -> PostToolUse
// ═══════════════════════════════════════════════════════════

// 查表 + schema 校验，异常收敛成错误文本回给模型
//（任务工具的 ID 校验、依赖缺失都走这条路）。
export function callTool(
  block: Anthropic.ToolUseBlock,
  handlers: Handlers,
): string {
  const handler = handlers[block.name];
  const schema = TOOL_SCHEMAS[block.name];
  if (!handler || !schema) return `Unknown: ${block.name}`;
  try {
    return handler(schema.parse(block.input));
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export async function executeTool(
  block: Anthropic.ToolUseBlock,
  handlers: Handlers,
  deps: Deps,
): Promise<string> {
  const { logger, hooks } = deps;
  const blocked = await hooks.trigger("PreToolUse", block);
  if (blocked) return blocked;

  const output = callTool(block, handlers);
  logger.toolResult(block.name, output);

  await hooks.trigger("PostToolUse", block, output);
  return output;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 结构同 s04，只是 dispatch 表多了 5 个任务工具
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks, tasks } = deps;
  // 基础工具（无需 logger）+ 任务工具（闭包捕获 store + logger）。
  const handlers: Handlers = {
    ...S03_TOOL_HANDLERS,
    ...makeTaskHandlers(tasks, logger),
  };

  while (true) {
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system: SYSTEM,
      messages,
      tools,
      max_tokens: 8000,
    });
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: await executeTool(block, handlers, deps),
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const hooks = loadHooks(logger, makeConfirm(rl, logger));

  print("s10: Task System — 带依赖的持久化任务图", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  // 任务存储一个 session 一份，跨轮复用；.tasks/ 留在磁盘上，下次还能接着做。
  const tasks = new TaskStore(tasksDirFor(import.meta.dirname));
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s10 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, {
      client,
      logger,
      hooks,
      tasks,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

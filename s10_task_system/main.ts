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
 *   + updateDependencies：两阶段建图的第二步，加边时校验存在性、自依赖与成环
 *   + incompleteDependencies / canStart：依赖缺失或未完成即视为被阻塞
 *   + claimTask：设置 owner，pending -> in_progress
 *   + completeTask：校验 owner，置为 completed，并汇报刚被解除阻塞的下游任务
 *   + 6 个任务工具，合并进 s02 的 tools / TOOL_SCHEMAS 与 s03 的 dispatch 表
 *
 * 任务图分两阶段构建：先 create_task 建出所有节点，再用返回的 ID 调 update_task
 *   加边。模型可以在一条回复里并行发出多个 create_task，这些同级调用在任何
 *   tool result 回传之前就已经定稿，所以某个 create_task 拿不到兄弟调用刚生成的
 *   ID，边只能等 ID 回来之后再补。
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
import { hasToolUse, printProse, textOf, zodTool } from "../lib/tools";
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
  `Use task tools to track dependencies and progress. Create all task nodes ` +
  `first. After create_task returns runtime-generated IDs, use update_task ` +
  `with those exact IDs to add dependencies.`;

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

// 磁盘上的任务文件可能被手改或来自旧版本，读回来时整份校验，
// 缺字段、状态非法都在 load 处就报错，而不是拖到用 blockedBy 时才炸。
// 用 looseObject 保留未知字段：后续章节（s13）会在 Task 上加自己的字段，
// 它们共用这个 store，校验不该把这些字段洗掉。
const TaskSchema = z.looseObject({
  id: z.string().regex(TASK_ID_PATTERN),
  subject: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  owner: z.string().nullable(),
  blockedBy: z.array(z.string()),
});

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

  // 创建任务并立即落盘。新任务的 blockedBy 恒为空：建图的第二阶段
  // 才由 updateDependencies 用返回的 ID 加边。
  create(subject: string, description = ""): Task {
    const trimmed = subject.trim();
    if (!trimmed) throw new Error("Task subject cannot be empty");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task: Task = {
        id: `task_${randomBytes(4).toString("hex")}`,
        subject: trimmed,
        description,
        status: "pending",
        owner: null,
        blockedBy: [],
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

  // taskId 沿 blockedBy 走下去能否到达 targetId。加边前用它判环：
  // 要给 A 加依赖 B，而 B 已经（间接）依赖 A，这条边就会成环。
  private dependsOn(taskId: string, targetId: string): boolean {
    const pending = [taskId];
    const visited = new Set<string>();
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...this.load(current).blockedBy);
    }
    return false;
  }

  // 建图第二阶段：给已存在的任务加依赖边。先整轮校验再统一保存，
  // 中途抛错不会留下改了一半的任务文件。
  updateDependencies(taskId: string, addBlockedBy: string[]): Task {
    const task = this.load(taskId);
    // 已认领或已开工的任务不再改依赖，否则 canStart 的判定会在中途反悔。
    if (task.status !== "pending" || task.owner !== null) {
      throw new Error(
        `Task ${taskId} dependencies can only be updated while ` +
          "pending and unowned",
      );
    }

    const dependencies = [...new Set(addBlockedBy)];
    for (const dependency of dependencies) {
      if (dependency === taskId) {
        throw new Error("Task cannot depend on itself");
      }
      if (!this.exists(dependency)) {
        throw new Error(`Dependency not found: ${dependency}`);
      }
      // 已经存在的边不必判环：它当初加进来时就查过了。
      if (
        !task.blockedBy.includes(dependency) &&
        this.dependsOn(dependency, taskId)
      ) {
        throw new Error(
          `Dependency cycle detected: ${taskId} -> ${dependency}`,
        );
      }
    }

    // 重复添加已有依赖是安全的，不产生重复边。
    task.blockedBy.push(
      ...dependencies.filter((d) => !task.blockedBy.includes(d)),
    );
    this.save(task);
    return task;
  }

  // 保存任务，覆盖原有内容。
  save(task: Task): void {
    fs.writeFileSync(
      this.taskPath(task.id, true),
      JSON.stringify(task, null, 2),
    );
  }

  // 读取任务；文件不存在、内容不合 schema、ID 对不上都抛错，
  // 由调用方（callTool / incompleteDependencies）决定怎么收敛。
  load(taskId: string): Task {
    const task = TaskSchema.parse(
      JSON.parse(fs.readFileSync(this.taskPath(taskId), "utf8")),
    );
    if (task.id !== taskId) {
      throw new Error(`Task file ID does not match ${taskId}`);
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

// 创建任务，回报运行时生成的 ID，模型据此在第二阶段加边。
export function runCreateTask(
  tasks: TaskStore,
  subject: string,
  description: string,
  logger: SessionLogger,
): string {
  const task = tasks.create(subject, description);
  logger.console(`  [create] ${task.subject}`, "blue");
  return `Created ${task.id}: ${task.subject}`;
}

// 加依赖边，回报这个任务当前完整的 blockedBy。
export function runUpdateTask(
  tasks: TaskStore,
  taskId: string,
  addBlockedBy: string[],
  logger: SessionLogger,
): string {
  const task = tasks.updateDependencies(taskId, addBlockedBy);
  const deps = task.blockedBy.join(", ") || "(none)";
  logger.console(`  [update] ${task.subject} blockedBy: ${deps}`, "blue");
  return `Updated ${task.id} blockedBy: ${deps}`;
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
      const marker = markers[t.status];
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
    create_task: ({ subject, description }) =>
      runCreateTask(tasks, subject, description ?? "", logger),
    // 依赖不存在、自依赖、成环都抛错，同样收敛成 tool_result 里的错误文本。
    update_task: ({ task_id, addBlockedBy }) =>
      runUpdateTask(tasks, task_id, addBlockedBy, logger),
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

// 建图这两个工具用 strictObject（JSON Schema 里就是 additionalProperties: false）
// 并把 ID 格式写进 pattern：约束直接摆在模型看得到的 schema 里，
// 比等 handler 抛错再让模型重试少绕一圈。
const createTaskSchema = z.strictObject({
  subject: z.string(),
  description: z.string().optional(),
});
const updateTaskSchema = z.strictObject({
  task_id: z.string().regex(TASK_ID_PATTERN),
  addBlockedBy: z.array(z.string().regex(TASK_ID_PATTERN)).min(1),
});
const listTasksSchema = z.object({});
const getTaskSchema = z.object({ task_id: z.string() });
const claimTaskSchema = z.object({ task_id: z.string() });
const completeTaskSchema = z.object({ task_id: z.string() });

const taskTools: Anthropic.Tool[] = [
  zodTool(
    "create_task",
    "Create a task and return its runtime-generated ID.",
    createTaskSchema,
  ),
  zodTool(
    "update_task",
    "Add dependencies using IDs returned by create_task.",
    updateTaskSchema,
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
  update_task: updateTaskSchema,
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
//  agentLoop —— 结构同 s04，只是 dispatch 表多了 6 个任务工具
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

    if (!hasToolUse(response)) {
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;
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

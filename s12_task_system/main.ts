/**
 * s12_task_system/main.ts - 任务系统
 *
 * 带 blockedBy 依赖关系、持久化到文件的任务图。
 *
 * 相比 s11 的变化：
 *   工具层、prompt 组装、context 推导继续直接复用，不再内联：
 *     基础工具 tools / TOOL_SCHEMAS 复用 s02，TOOL_HANDLERS 复用 s03，
 *     getSystemPrompt / updateContext / Context 复用 s10，MEMORY_INDEX 复用 s09。
 *   s11 的错误恢复（RecoveryState、退避、升级、应急压缩、备用模型）在此省略——
 *   任务系统与 withRetry 是两个可自然组合的独立层，这里只聚焦前者。
 *   本文件只新增任务系统这一层：
 *   + Task 类型（id、subject、description、status、owner、blockedBy）
 *   + TASKS_DIR = .tasks/，持久化为每任务一份 JSON
 *   + createTask / saveTask / loadTask / listTasks / getTask
 *   + canStart：检查 blockedBy 是否全部完成（依赖缺失即视为被阻塞）
 *   + claimTask：设置 owner，pending -> in_progress
 *   + completeTask：设置 completed，并汇报下游被解除阻塞的任务
 *   + 5 个新工具，合并进基础工具的 tools / TOOL_SCHEMAS / TOOL_HANDLERS
 *
 * TS 特有说明：
 *   - 任务工具的 handler 需要 logger 打印状态迁移，所以用 makeTaskHandlers(logger)
 *     工厂闭包捕获 logger，再与 s03 的纯分发表合并（基础工具不依赖 logger）。
 *   - 工具集在 s12 变了（多了 5 个任务工具），system prompt 的「Available tools」
 *     也得跟上。s10 的 assembleSystemPrompt 把这行写死成基础五工具、忽略了
 *     context.enabled_tools，所以 s12 在这里接管 prompt 组装：updateContext 用
 *     合并后的工具名填 enabled_tools，getSystemPrompt 依据它组装（复用 s10 的
 *     contextKey 缓存）。s13 同名覆盖 bash、工具名不变，直接复用这里。
 *
 * Usage:
 *     pnpm dev s12_task_system/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：基础工具定义 + schema 表。
import {
  TOOL_SCHEMAS as BASE_TOOL_SCHEMAS,
  tools as baseTools,
} from "../s02_tool_use/main";
// 来自 s03：不含权限检查的基础 dispatch 表。
import { TOOL_HANDLERS as BASE_TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：记忆索引路径，s10 也复用同一份。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：复用 Context 类型、缓存 key，以及 memory/workspace 的推导逻辑
// （deriveBaseContext）。「Available tools」这行 s10 写死了，s12 在下面自己接管。
import {
  type Context,
  contextKey,
  updateContext as deriveBaseContext,
} from "../s10_system_prompt/main";

// deps 与 s10/s11 一致：client + logger，另加 memoryIndex（每轮工具后重新推导 context）。
// tasksDir 可选，默认 TASKS_DIR；测试注入临时目录做隔离。
export type Deps = { client: ModelClient; logger: SessionLogger };
export type LoopDeps = Deps & { memoryIndex: string; tasksDir?: string };

// ═══════════════════════════════════════════════════════════
//  s12 新增：任务系统
// ═══════════════════════════════════════════════════════════

// 默认存储目录，落在 s12 自己的目录下（仿照 logger 的 .log/）；
// 测试传入临时目录做隔离（目录作为参数显式传入，同 s09 的风格）。
export const TASKS_DIR = path.join(import.meta.dirname, ".tasks");
// 任务状态机：pending -> in_progress -> completed
export type TaskStatus = "pending" | "in_progress" | "completed";

export type Task = {
  // 任务唯一标识
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null; // agent 名（多 agent 场景）
  blockedBy: string[]; // 依赖的任务 ID
};

const taskPath = (dir: string, taskId: string) =>
  path.join(dir, `${taskId}.json`);

// 创建新任务，立即持久化到文件。ID 由时间戳 + 随机数生成，保证唯一性。
export function createTask(
  dir: string,
  subject: string,
  description = "",
  blockedBy: string[] = [],
): Task {
  const task: Task = {
    // eg. task_1697040000_1234
    id: `task_${Math.floor(Date.now() / 1000)}_${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
    subject,
    description,
    status: "pending",
    owner: null,
    blockedBy,
  };
  saveTask(dir, task);
  return task;
}
// 保存任务到文件，覆盖原有内容。
export function saveTask(dir: string, task: Task): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(taskPath(dir, task.id), JSON.stringify(task, null, 2));
}
// 从文件加载任务，若不存在则抛出异常。
export function loadTask(dir: string, taskId: string): Task {
  return JSON.parse(fs.readFileSync(taskPath(dir, taskId), "utf8")) as Task;
}
// 列出所有任务，按文件名排序（即按创建时间排序）。
export function listTasks(dir: string): Task[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Task);
}
// 获取任务的 JSON 字符串表示，便于打印或调试。
export function getTask(dir: string, taskId: string): string {
  return JSON.stringify(loadTask(dir, taskId), null, 2);
}
// 检查任务是否可以开始：所有 blockedBy 依赖都存在且已完成。
export function canStart(dir: string, taskId: string): boolean {
  const task = loadTask(dir, taskId);
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(taskPath(dir, depId))) return false;
    if (loadTask(dir, depId).status !== "completed") return false;
  }
  return true;
}

// ── 任务工具的 handler ─────────────────────────────────────────

// 创建任务，打印状态信息。
export function runCreateTask(
  dir: string,
  subject: string,
  description: string,
  blockedBy: string[] | undefined,
  logger: SessionLogger,
): string {
  const task = createTask(dir, subject, description, blockedBy ?? []);
  const deps = blockedBy?.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  logger.console(`  [create] ${task.subject}${deps}`, "blue");
  return `Created ${task.id}: ${task.subject}${deps}`;
}

// 列出所有任务，打印状态信息。
export function runListTasks(dir: string): string {
  const tasks = listTasks(dir);
  if (!tasks.length) return "No tasks. Use create_task to add some.";
  const icons: Record<TaskStatus, string> = {
    pending: "○",
    in_progress: "●",
    completed: "✓",
  };
  return tasks
    .map((t) => {
      const icon = icons[t.status] ?? "?";
      const deps = t.blockedBy.length
        ? ` (blockedBy: ${t.blockedBy.join(", ")})`
        : "";
      const owner = t.owner ? ` [${t.owner}]` : "";
      return `  ${icon} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
    })
    .join("\n");
}

// 获取任务详情，打印状态信息。
export function runGetTask(dir: string, taskId: string): string {
  try {
    return getTask(dir, taskId);
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

// 认领任务，设置 owner，pending -> in_progress，并返回状态信息。
export function claimTask(
  dir: string,
  taskId: string,
  logger: SessionLogger,
  owner = "agent",
): string {
  const task = loadTask(dir, taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  if (!canStart(dir, taskId)) {
    const deps = task.blockedBy.filter(
      (d) =>
        !fs.existsSync(taskPath(dir, d)) ||
        loadTask(dir, d).status !== "completed",
    );
    return `Blocked by: [${deps.join(", ")}]`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(dir, task);
  logger.console(
    `  [claim] ${task.subject} → in_progress (owner: ${owner})`,
    "cyan",
  );
  return `Claimed ${task.id} (${task.subject})`;
}

// 完成任务，设置 status = completed，并返回被解除阻塞的下游任务列表。
export function completeTask(
  dir: string,
  taskId: string,
  logger: SessionLogger,
): string {
  const task = loadTask(dir, taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  task.status = "completed";
  saveTask(dir, task);
  const unblocked = listTasks(dir)
    .filter(
      (t) =>
        t.status === "pending" && t.blockedBy.length > 0 && canStart(dir, t.id),
    )
    .map((t) => t.subject);
  logger.console(`  [complete] ${task.subject} ✓`, "green");
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    logger.console(`  [unblocked] ${unblocked.join(", ")}`, "yellow");
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  s12 新增：任务工具定义，合并进基础工具的 dispatch
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
    "Create a new task with optional blockedBy dependencies.",
    createTaskSchema,
  ),
  zodTool(
    "list_tasks",
    "List all tasks with status, owner, and dependencies.",
    listTasksSchema,
  ),
  zodTool(
    "get_task",
    "Get full details of a specific task by ID.",
    getTaskSchema,
  ),
  zodTool(
    "claim_task",
    "Claim a pending task. Sets owner, changes status to in_progress.",
    claimTaskSchema,
  ),
  zodTool(
    "complete_task",
    "Complete an in-progress task. Reports unblocked downstream tasks.",
    completeTaskSchema,
  ),
];

// 基础工具 + 任务工具：tools / TOOL_SCHEMAS 都是纯数据，模块级静态合并。
export const tools: Anthropic.Tool[] = [...baseTools, ...taskTools];
// 任务工具的 schema，合并进基础工具的 TOOL_SCHEMAS。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...BASE_TOOL_SCHEMAS,
  create_task: createTaskSchema,
  list_tasks: listTasksSchema,
  get_task: getTaskSchema,
  claim_task: claimTaskSchema,
  complete_task: completeTaskSchema,
};

// 任务 handler 需要 logger 打印状态迁移、dir 定位存储，用工厂闭包捕获二者，
// 再与 s03 的纯基础分发表合并。
export function makeTaskHandlers(
  logger: SessionLogger,
  dir: string = TASKS_DIR,
): Partial<Record<string, (input: any) => string>> {
  return {
    create_task: ({ subject, description, blockedBy }) =>
      runCreateTask(dir, subject, description ?? "", blockedBy, logger),
    list_tasks: () => runListTasks(dir),
    get_task: ({ task_id }) => runGetTask(dir, task_id),
    claim_task: ({ task_id }) => claimTask(dir, task_id, logger),
    complete_task: ({ task_id }) => completeTask(dir, task_id, logger),
  };
}

// ═══════════════════════════════════════════════════════════
//  s12 override：让 system prompt 反映合并后的工具集
// ═══════════════════════════════════════════════════════════

// 合并后的工具名（基础 + 任务）。s13 只是同名覆盖 bash，工具名与此一致，故可复用。
export const TOOL_NAMES: string[] = tools.map((t) => t.name);

// 复用 s10 的 memory/workspace 推导，只把 enabled_tools 换成合并后的工具名。
export function updateContext(memoryIndex: string): Context {
  return { ...deriveBaseContext(memoryIndex), enabled_tools: TOOL_NAMES };
}

// 进程内缓存（同 s10：context 没变就复用上次结果，只省本地拼接，不影响 API 计费）。
let lastContextKey: string | null = null;
let lastPrompt: string | null = null;

// 组装 prompt：tools 行改由 context.enabled_tools 推导，其余同 s10。
export function assembleSystemPrompt(context: Context): string {
  const sections = [
    "You are a coding agent. Act, don't explain.",
    `Available tools: ${context.enabled_tools.join(", ")}.`,
    `Working directory: ${context.workspace}`,
  ];
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }
  return sections.join("\n\n");
}

export function getSystemPrompt(context: Context): string {
  const key = contextKey(context);
  if (key === lastContextKey && lastPrompt) return lastPrompt;
  lastContextKey = key;
  lastPrompt = assembleSystemPrompt(context);
  return lastPrompt;
}

// 测试用：重置进程内缓存，隔离用例。
export function resetPromptCache(): void {
  lastContextKey = null;
  lastPrompt = null;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦任务系统（省略 s11 的错误恢复）
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, memoryIndex, tasksDir } = deps;
  let system = getSystemPrompt(context);
  // 基础工具（无需 logger）+ 任务工具（闭包捕获 logger + 存储目录）。
  const handlers = {
    ...BASE_TOOL_HANDLERS,
    ...makeTaskHandlers(logger, tasksDir),
  };

  while (true) {
    logger.section(
      "SYSTEM PROMPT",
      `enabled_tools: ${JSON.stringify(Object.keys(handlers))}` +
        `\nworkspace: ${context.workspace}` +
        `\nmemories:\n${context.memories}` +
        `\n\nPrompt:\n${system}`,
    );
    logger.request(messages, true);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages,
        tools,
        max_tokens: 8000,
      });
    } catch (e) {
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const detail = e instanceof Error ? e.message : String(e);
      const errText = `[Error] ${name}: ${detail}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }
    logger.response(response);

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") {
        continue;
      }
      const schema = TOOL_SCHEMAS[block.name];
      const handler = handlers[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    context = updateContext(memoryIndex);
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, tools });

  print("s12: Task System — 带依赖的持久化任务图", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const history: Anthropic.MessageParam[] = [];
  let context = updateContext(MEMORY_INDEX);
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s12 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, context, {
      client,
      logger,
      memoryIndex: MEMORY_INDEX,
    });
    context = updateContext(MEMORY_INDEX);
    print(finalText, "green");
    print();
  }
  rl.close();
}

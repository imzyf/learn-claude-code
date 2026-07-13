/**
 * s12_task_system/main.ts - 任务系统
 *
 * 带 blockedBy 依赖关系、持久化到文件的任务图。
 *
 * 相比 s11 的变化：
 *   + Task 类型（id、subject、description、status、owner、blockedBy）
 *   + TASKS_DIR = .tasks/，用于持久化 JSON 存储
 *   + createTask / saveTask / loadTask / listTasks / getTask
 *   + canStart：检查 blockedBy 是否全部完成（依赖缺失即视为被阻塞）
 *   + claimTask：设置 owner，pending -> in_progress
 *   + completeTask：设置 completed，并汇报下游被解除阻塞的任务
 *   + 5 个新工具：create_task、list_tasks、get_task、claim_task、complete_task
 *
 * 说明：为了聚焦任务系统本身，教学代码保留了一个基础版 agent 循环。
 * S11 完整的错误恢复机制（RecoveryState、退避、升级、应急压缩、备用模型）
 * 在此省略——在真实的 CC 中，tasks.ts 和 withRetry 是两个可以自然组合的独立层。
 *
 * Usage:
 *     pnpm dev s12_task_system/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";

const client = createClient();

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  s12 新增：任务系统
// ═══════════════════════════════════════════════════════════

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });

type TaskStatus = "pending" | "in_progress" | "completed";

type Task = {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null; // agent 名（多 agent 场景）
  blockedBy: string[]; // 依赖的任务 ID
};

const taskPath = (taskId: string) => path.join(TASKS_DIR, `${taskId}.json`);

function createTask(
  subject: string,
  description = "",
  blockedBy: string[] = [],
): Task {
  const task: Task = {
    id: `task_${Math.floor(Date.now() / 1000)}_${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
    subject,
    description,
    status: "pending",
    owner: null,
    blockedBy,
  };
  saveTask(task);
  return task;
}

function saveTask(task: Task): void {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

function loadTask(taskId: string): Task {
  return JSON.parse(fs.readFileSync(taskPath(taskId), "utf8")) as Task;
}

function listTasks(): Task[] {
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort()
    .map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task,
    );
}

// 返回任务的完整详情（JSON）。
function getTask(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

/**
 * 检查 blockedBy 依赖是否全部完成。
 * 依赖缺失即视为被阻塞。
 */
function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(taskPath(depId))) return false;
    if (loadTask(depId).status !== "completed") return false;
  }
  return true;
}

function claimTask(taskId: string, owner = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(
      (d) => !fs.existsSync(taskPath(d)) || loadTask(d).status !== "completed",
    );
    return `Blocked by: [${deps.join(", ")}]`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  print(`  [claim] ${task.subject} → in_progress (owner: ${owner})`, "cyan");
  return `Claimed ${task.id} (${task.subject})`;
}

function completeTask(taskId: string): string {
  const task = loadTask(taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  task.status = "completed";
  saveTask(task);
  const unblocked = listTasks()
    .filter(
      (t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id),
    )
    .map((t) => t.subject);
  print(`  [complete] ${task.subject} ✓`, "green");
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    print(`  [unblocked] ${unblocked.join(", ")}`, "yellow");
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  来自 s10（同步）：Prompt 组装
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Available tools: bash, read_file, write_file, " +
    "create_task, list_tasks, get_task, claim_task, complete_task.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

type Context = {
  enabled_tools: string[];
  workspace: string;
  memories: string;
};

function assembleSystemPrompt(context: Context): string {
  const sections = [
    PROMPT_SECTIONS.identity,
    PROMPT_SECTIONS.tools,
    PROMPT_SECTIONS.workspace,
  ];
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }
  return sections.join("\n\n");
}

let lastContextKey: string | null = null;
let lastPrompt: string | null = null;

const contextKey = (context: Context): string =>
  JSON.stringify(context, Object.keys(context).sort());

function getSystemPrompt(context: Context): string {
  const key = contextKey(context);
  if (key === lastContextKey && lastPrompt) {
    return lastPrompt;
  }
  lastContextKey = key;
  lastPrompt = assembleSystemPrompt(context);
  return lastPrompt;
}

// ═══════════════════════════════════════════════════════════
//  来自 s02（原样复用）：基础工具
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const r = spawnSync(command, {
    shell: true,
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return "Error: Timeout (120s)";
    return `Error: ${r.error.message}`;
  }
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return out ? out.slice(0, 50_000) : "(no output)";
}

function runRead(p: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    if (limit && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ── 任务工具 ──

function runCreateTask(
  subject: string,
  description = "",
  blockedBy?: string[],
): string {
  const task = createTask(subject, description, blockedBy ?? []);
  const deps = blockedBy?.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  print(`  [create] ${task.subject}${deps}`, "blue");
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
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

function runGetTask(taskId: string): string {
  try {
    return getTask(taskId);
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

function runClaimTask(taskId: string): string {
  return claimTask(taskId, "agent");
}

function runCompleteTask(taskId: string): string {
  return completeTask(taskId);
}

// ── 工具定义 ──

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({
  path: z.string(),
  limit: z.number().int().optional(),
});
const writeSchema = z.object({ path: z.string(), content: z.string() });
const createTaskSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
});
const listTasksSchema = z.object({});
const getTaskSchema = z.object({ task_id: z.string() });
const claimTaskSchema = z.object({ task_id: z.string() });
const completeTaskSchema = z.object({ task_id: z.string() });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
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

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  create_task: createTaskSchema,
  list_tasks: listTasksSchema,
  get_task: getTaskSchema,
  claim_task: claimTaskSchema,
  complete_task: completeTaskSchema,
};

const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  create_task: ({ subject, description, blockedBy }) =>
    runCreateTask(subject, description ?? "", blockedBy),
  list_tasks: () => runListTasks(),
  get_task: ({ task_id }) => runGetTask(task_id),
  claim_task: ({ task_id }) => runClaimTask(task_id),
  complete_task: ({ task_id }) => runCompleteTask(task_id),
};

// ── Context ──

// 由真实状态推导 context。
function updateContext(): Context {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf8").trim();
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦任务系统
// ═══════════════════════════════════════════════════════════

async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
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
      const errText = `[Error] ${e instanceof Error ? e.name : "Error"}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }
      print(`> ${block.name}`, "cyan");
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      print(output.slice(0, 300));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
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
let context = updateContext();
while (true) {
  let query: string;
  try {
    query = await rl.question(colorize("s12 >> ", "cyan"));
  } catch {
    break; // stdin 关闭（Ctrl+D）
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  print(finalText, "green");
  print();
}
rl.close();

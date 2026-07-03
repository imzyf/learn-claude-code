/**
 * s13_background_tasks/main.ts - 后台任务
 *
 * 异步后台执行 + 通知注入。
 *
 * 相比 s12 的变化：
 *   + backgroundTasks / backgroundResults 用于跟踪生命周期
 *   + shouldRunBackground：模型通过 run_in_background 参数显式请求
 *   + isSlowOperation：模型未指定时的兜底启发式判断
 *   + startBackgroundTask：分发给一个游离的异步 worker，返回后台任务 id
 *   + collectBackgroundResults：收集已完成的任务，以通知形式返回
 *   + agentLoop：慢操作 -> 后台执行 + 占位符，再注入通知
 *   + 通知使用 <task_notification> 格式，不复用原来的 tool call id
 *
 * TS 特有说明：
 *   - Python 用 threading.Thread + Lock；Node 的事件循环是单线程的，
 *     所以这里用一个游离的 Promise 代替守护线程，也不需要锁
 *   - 后台 bash 使用异步 exec（独立子进程），保证命令运行期间事件循环
 *     不被阻塞
 *   - Python 把 tool_result 和文本通知合并进同一条 user 消息；
 *     AI SDK 会区分角色，所以通知会放进单独的一条后续 user 消息里
 *
 * 说明：为了聚焦后台任务本身，教学代码保留了一个基础版 agent 循环。
 * S11 完整的错误恢复机制（RecoveryState、退避、升级、应急压缩、备用模型）
 * 在此省略。
 *
 * Usage:
 *     pnpm dev s13_background_tasks/main.ts
 */

import { exec, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { model } from "../lib/model";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════
//  FROM s12 (synced): Task System
// ═══════════════════════════════════════════════════════════

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });

type TaskStatus = "pending" | "in_progress" | "completed";

type Task = {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
};

const taskPath = (taskId: string) => path.join(TASKS_DIR, `${taskId}.json`);

function createTask(subject: string, description = "", blockedBy: string[] = []): Task {
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
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task);
}

// Return full task details as JSON.
function getTask(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

/**
 * Check if all blockedBy dependencies are completed.
 * Missing dependencies are treated as blocked.
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
  console.log(`  \x1b[36m[claim] ${task.subject} → in_progress (owner: ${owner})\x1b[0m`);
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
    .filter((t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map((t) => t.subject);
  console.log(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  \x1b[33m[unblocked] ${unblocked.join(", ")}\x1b[0m`);
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  FROM s10 (synced): Prompt Assembly
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
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
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
//  FROM s02 (unchanged): Basic tools
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// run_in_background is handled by agentLoop dispatch, not here
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

// Async variant for background execution — keeps the event loop free.
async function runBashAsync(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = (stdout + stderr).trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (e) {
    // exec rejects on non-zero exit; captured output is still on the error
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) return "Error: Timeout (120s)";
    const out = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    return out ? out.slice(0, 50_000) : `Error: ${errMsg(e)}`;
  }
}

function runRead(p: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
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

// ── Task tools ──

function runCreateTask(subject: string, description = "", blockedBy?: string[]): string {
  const task = createTask(subject, description, blockedBy ?? []);
  const deps = blockedBy?.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
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
      const deps = t.blockedBy.length ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
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

// ── Tool definitions ──

const tools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
    }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({ path: z.string(), limit: z.number().int().optional() }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  create_task: tool({
    description: "Create a new task with optional blockedBy dependencies.",
    inputSchema: z.object({
      subject: z.string(),
      description: z.string().optional(),
      blockedBy: z.array(z.string()).optional(),
    }),
  }),
  list_tasks: tool({
    description: "List all tasks with status, owner, and dependencies.",
    inputSchema: z.object({}),
  }),
  get_task: tool({
    description: "Get full details of a specific task by ID.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
  claim_task: tool({
    description: "Claim a pending task. Sets owner, changes status to in_progress.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
  complete_task: tool({
    description: "Complete an in-progress task. Reports unblocked downstream tasks.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
};

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
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

// ═══════════════════════════════════════════════════════════
//  NEW in s13: Background Tasks
// ═══════════════════════════════════════════════════════════

// Python needs threading.Lock around these; Node's single JS thread doesn't.
let bgCounter = 0;
type BgTask = { toolCallId: string; command: string; status: "running" | "completed" };
const backgroundTasks: Record<string, BgTask> = {};
const backgroundResults: Record<string, string> = {};

// Fallback heuristic: commands likely to take > 30s.
function isSlowOperation(toolName: string, toolInput: any): boolean {
  if (toolName !== "bash") return false;
  const cmd = String(toolInput.command ?? "").toLowerCase();
  const slowKeywords = [
    "install",
    "build",
    "test",
    "deploy",
    "compile",
    "docker build",
    "pip install",
    "npm install",
    "cargo build",
    "pytest",
    "make",
  ];
  return slowKeywords.some((kw) => cmd.includes(kw));
}

// Model explicit request takes priority; fallback to heuristic.
function shouldRunBackground(toolName: string, toolInput: any): boolean {
  if (toolInput.run_in_background) return true;
  return isSlowOperation(toolName, toolInput);
}

// Execute a tool call, return output.
function executeTool(toolName: string, input: any): string {
  const handler = TOOL_HANDLERS[toolName];
  if (handler) return handler(input);
  return `Unknown tool: ${toolName}`;
}

// Run tool in a detached async worker (the TS analog of a daemon thread).
// Returns background task ID.
function startBackgroundTask(toolName: string, toolCallId: string, input: any): string {
  bgCounter += 1;
  const bgId = `bg_${String(bgCounter).padStart(4, "0")}`;
  const cmd = String(input.command ?? toolName);

  backgroundTasks[bgId] = { toolCallId, command: cmd, status: "running" };
  void (async () => {
    const result =
      toolName === "bash"
        ? await runBashAsync(String(input.command ?? ""))
        : executeTool(toolName, input);
    backgroundTasks[bgId].status = "completed";
    backgroundResults[bgId] = result;
  })();

  console.log(`  \x1b[33m[background] dispatched ${bgId}: ${cmd.slice(0, 40)}\x1b[0m`);
  return bgId;
}

// Collect completed background results as task_notification messages.
function collectBackgroundResults(): string[] {
  const readyIds = Object.entries(backgroundTasks)
    .filter(([, task]) => task.status === "completed")
    .map(([id]) => id);
  const notifications: string[] = [];
  for (const bgId of readyIds) {
    const task = backgroundTasks[bgId];
    delete backgroundTasks[bgId];
    const output = backgroundResults[bgId] ?? "";
    delete backgroundResults[bgId];
    const summary = output.slice(0, 200);
    notifications.push(
      `<task_notification>\n` +
        `  <task_id>${bgId}</task_id>\n` +
        `  <status>completed</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <summary>${summary}</summary>\n` +
        `</task_notification>`,
    );
    console.log(
      `  \x1b[32m[background done] ${bgId}: ${task.command.slice(0, 40)} (${output.length} chars)\x1b[0m`,
    );
  }
  return notifications;
}

// ── Context ──

// Derive context from real state.
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
//  agentLoop — simplified, focused on background tasks
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: ModelMessage[], context: Context): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
    let result;
    try {
      result = await generateText({
        model,
        system,
        messages,
        tools,
        maxOutputTokens: 8000,
      });
    } catch (e) {
      const errText = `[Error] ${e instanceof Error ? e.name : "Error"}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }

    messages.push(...result.response.messages);
    if (result.finishReason !== "tool-calls") {
      return result.text;
    }

    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);

      if (shouldRunBackground(call.toolName, call.input)) {
        const bgId = startBackgroundTask(call.toolName, call.toolCallId, call.input);
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "text",
            value:
              `[Background task ${bgId} started] ` +
              `Command: ${(call.input as any).command ?? ""}. ` +
              `Result will be available when complete.`,
          },
        });
      } else {
        const output = executeTool(call.toolName, call.input);
        console.log(output.slice(0, 300));
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: output },
        });
      }
    }
    messages.push({ role: "tool", content: results });

    // Python merges tool_result + text notifications into one user message;
    // the AI SDK separates roles, so notifications get their own user message.
    const bgNotifications = collectBackgroundResults();
    if (bgNotifications.length) {
      messages.push({ role: "user", content: bgNotifications.join("\n") });
      console.log(`  \x1b[32m[inject] ${bgNotifications.length} background notification(s)\x1b[0m`);
    }

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── Entry point ──────────────────────────────────────────
console.log("s13: background tasks");
console.log("输入问题，回车发送。输入 q 退出。\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

const history: ModelMessage[] = [];
let context = updateContext();
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms13 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  console.log(finalText);
  console.log();
}
rl.close();

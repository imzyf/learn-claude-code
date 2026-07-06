/**
 * s14_cron_scheduler/main.ts - Cron 调度器
 *
 * 独立的定时器 + 队列处理器。
 *
 * 相比 s13 的变化：
 *   + CronJob 类型（id、cron、prompt、recurring、durable）
 *   + cronMatches：五段式 cron 表达式匹配，DOM/DOW 采用 OR 语义
 *   + scheduleJob / cancelJob：注册/移除 cron 任务（带校验）
 *   + cron 调度器：1 秒间隔的定时器，把匹配的任务触发进 cronQueue
 *   + 队列处理器：200 毫秒间隔，在 agent 空闲时投递排队中的任务
 *   + 持久化存储：.scheduled_tasks.json（重启后仍保留）
 *   + 3 个新工具：schedule_cron、list_crons、cancel_cron
 *
 * 四个层次：
 *   1. 调度器：定时器检查时间 -> 触发匹配的任务
 *   2. 队列：cronQueue 把调度器和 agent 循环解耦
 *   3. 队列处理器：当有排队任务且 agent 空闲时唤醒 agent
 *   4. 消费者：agentLoop 消费排队任务，把它们注入 messages
 *
 * TS 特有说明：
 *   - Python 的守护线程 -> setInterval(...).unref() 定时器
 *   - Python 的 agent_lock -> agentBusy 布尔值（单线程事件循环）：
 *     用户输入要等它释放，队列处理器在它被占用时会跳过
 *     （相当于 acquire(blocking=False) 的效果）
 *   - JS 的 Date.getDay() 本身就用 cron 的 Sunday=0 约定（Python 那边需要转换）
 *
 * Usage:
 *     pnpm dev s14_cron_scheduler/main.ts
 */

import { exec, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID } from "../lib/model";
import { textOf, zodTool } from "../lib/tools";

const client = createClient();

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  console.log(
    `  \x1b[36m[claim] ${task.subject} → in_progress (owner: ${owner})\x1b[0m`,
  );
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
    "create_task, list_tasks, get_task, claim_task, complete_task, " +
    "schedule_cron, list_crons, cancel_cron.",
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

// ── Task tools ──

function runCreateTask(
  subject: string,
  description = "",
  blockedBy?: string[],
): string {
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

// ═══════════════════════════════════════════════════════════
//  FROM s13 (synced): Background Tasks
// ═══════════════════════════════════════════════════════════

let bgCounter = 0;
type BgTask = {
  toolCallId: string;
  command: string;
  status: "running" | "completed";
};
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

// Run tool in a detached async worker. Returns background task ID.
function startBackgroundTask(
  toolName: string,
  toolCallId: string,
  input: any,
): string {
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

  console.log(
    `  \x1b[33m[background] dispatched ${bgId}: ${cmd.slice(0, 40)}\x1b[0m`,
  );
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

// ═══════════════════════════════════════════════════════════
//  NEW in s14: Cron Scheduler
// ═══════════════════════════════════════════════════════════

const DURABLE_PATH = path.join(WORKDIR, ".scheduled_tasks.json");

type CronJob = {
  id: string;
  cron: string; // "0 9 * * *"
  prompt: string; // message to inject when fired
  recurring: boolean; // true = recurring, false = one-shot
  durable: boolean; // true = persist to disk
};

const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFiredAt = new Map<string, string>(); // job_id → "YYYY-MM-DD HH:MM"

const isDigits = (s: string) => /^\d+$/.test(s);

// Match a single cron field against a value.
function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((f) => cronFieldMatches(f.trim(), value));
  }
  if (field.includes("-")) {
    const i = field.indexOf("-");
    return (
      Number(field.slice(0, i)) <= value && value <= Number(field.slice(i + 1))
    );
  }
  return value === Number(field);
}

/**
 * Check if a 5-field cron expression matches the given Date.
 * Standard cron semantics: DOM and DOW use OR when both are constrained.
 */
function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = dt.getDay(); // JS: Sunday=0, same as cron

  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1);
  const dowOk = cronFieldMatches(dow, dowVal);

  // Minute, hour, month must all match
  if (!(m && h && monthOk)) return false;
  // DOM and DOW: if both constrained, either matching is enough (OR)
  const domUnconstrained = dom === "*";
  const dowUnconstrained = dow === "*";
  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

// Validate a single cron field value is within [lo, hi].
function validateCronField(
  field: string,
  lo: number,
  hi: number,
): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const stepStr = field.slice(2);
    if (!isDigits(stepStr)) return `Invalid step: ${field}`;
    if (Number(stepStr) <= 0) return `Step must be > 0: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes("-")) {
    const i = field.indexOf("-");
    const loStr = field.slice(0, i);
    const hiStr = field.slice(i + 1);
    if (!isDigits(loStr) || !isDigits(hiStr)) return `Invalid range: ${field}`;
    const a = Number(loStr);
    const b = Number(hiStr);
    if (a < lo || a > hi || b < lo || b > hi)
      return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!isDigits(field)) return `Invalid field: ${field}`;
  const val = Number(field);
  if (val < lo || val > hi) return `Value ${val} out of bounds [${lo}-${hi}]`;
  return null;
}

// Validate a cron expression. Returns error message or null.
function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

// Persist durable jobs to .scheduled_tasks.json.
function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2));
}

// Load durable jobs from disk on startup.
function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    const jobs = JSON.parse(fs.readFileSync(DURABLE_PATH, "utf8")) as CronJob[];
    let loaded = 0;
    for (const job of jobs) {
      const err = validateCron(job.cron);
      if (err) {
        console.log(
          `  \x1b[31m[cron] skipping invalid job ${job.id}: ${err}\x1b[0m`,
        );
        continue;
      }
      scheduledJobs.set(job.id, job);
      loaded += 1;
    }
    if (loaded) {
      console.log(`  \x1b[35m[cron] loaded ${loaded} durable job(s)\x1b[0m`);
    }
  } catch {
    // corrupted durable file: start empty
  }
}

// Register a new cron job. Returns CronJob or error string.
function scheduleJob(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = {
    id: `cron_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    cron,
    prompt,
    recurring,
    durable,
  };
  scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs();
  console.log(
    `  \x1b[35m[cron register] ${job.id} '${cron}' → ${prompt.slice(0, 40)}\x1b[0m`,
  );
  return job;
}

// Cancel a cron job.
function cancelJob(jobId: string): string {
  const job = scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;
  scheduledJobs.delete(jobId);
  if (job.durable) saveDurableJobs();
  console.log(`  \x1b[31m[cron cancel] ${jobId}\x1b[0m`);
  return `Cancelled ${jobId}`;
}

/**
 * Independent 1s interval timer (Python: daemon thread), fires matching jobs.
 * Individual job errors are caught to prevent one bad job from killing the
 * scheduler. unref() lets the process exit when the REPL closes.
 */
function startCronScheduler(): void {
  setInterval(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // Date-aware marker prevents daily jobs from skipping on day 2+
    const minuteMarker =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    for (const job of [...scheduledJobs.values()]) {
      try {
        if (cronMatches(job.cron, now)) {
          if (lastFiredAt.get(job.id) !== minuteMarker) {
            cronQueue.push(job);
            lastFiredAt.set(job.id, minuteMarker);
            console.log(
              `  \x1b[35m[cron fire] ${job.id} → ${job.prompt.slice(0, 40)}\x1b[0m`,
            );
          }
          if (!job.recurring) {
            scheduledJobs.delete(job.id);
            if (job.durable) saveDurableJobs();
          }
        }
      } catch (e) {
        console.log(`  \x1b[31m[cron error] ${job.id}: ${errMsg(e)}\x1b[0m`);
      }
    }
  }, 1000).unref();
}

// Consume fired jobs from cronQueue (called by agentLoop).
function consumeCronQueue(): CronJob[] {
  const fired = [...cronQueue];
  cronQueue.length = 0;
  return fired;
}

// Return whether fired cron jobs are waiting to be delivered.
function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

// Load durable jobs on startup, then start the scheduler timer
loadDurableJobs();
startCronScheduler();
console.log("  \x1b[35m[cron] scheduler timer started\x1b[0m");

// ── Cron tools ──

function runScheduleCron(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") {
    return `Error: ${result}`;
  }
  return `Scheduled ${result.id}: '${cron}' → ${prompt}`;
}

function runListCrons(): string {
  const jobs = [...scheduledJobs.values()];
  if (!jobs.length) return "No cron jobs. Use schedule_cron to add one.";
  return jobs
    .map((j) => {
      const tag = j.recurring ? "recurring" : "one-shot";
      const dur = j.durable ? "durable" : "session";
      return `  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`;
    })
    .join("\n");
}

function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

// ── Tool definitions ──

const bashSchema = z.object({
  command: z.string(),
  run_in_background: z.boolean().optional(),
});
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
const scheduleCronSchema = z.object({
  cron: z.string().describe("5-field cron expression"),
  prompt: z.string().describe("Message to inject when fired"),
  recurring: z.boolean().describe("True=recurring, False=one-shot").optional(),
  durable: z.boolean().describe("True=persist to disk").optional(),
});
const listCronsSchema = z.object({});
const cancelCronSchema = z.object({ job_id: z.string() });

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
  zodTool(
    "schedule_cron",
    "Schedule a cron job. cron is 5-field: min hour dom month dow.",
    scheduleCronSchema,
  ),
  zodTool("list_crons", "List all registered cron jobs.", listCronsSchema),
  zodTool("cancel_cron", "Cancel a cron job by ID.", cancelCronSchema),
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
  schedule_cron: scheduleCronSchema,
  list_crons: listCronsSchema,
  cancel_cron: cancelCronSchema,
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
  schedule_cron: ({ cron, prompt, recurring, durable }) =>
    runScheduleCron(cron, prompt, recurring ?? true, durable ?? true),
  list_crons: () => runListCrons(),
  cancel_cron: ({ job_id }) => runCancelCron(job_id),
};

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
//  agentLoop — simplified, focused on cron scheduler
// ═══════════════════════════════════════════════════════════
// Teaching code keeps a basic agent loop. S11's full error recovery is omitted.
// startCronScheduler produces work; startQueueProcessor wakes this loop when
// queued work exists and no other agent turn is running.

async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
    // Layer 4: consume fired cron jobs → inject as messages
    const fired = consumeCronQueue();
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      console.log(`  \x1b[35m[inject cron] ${job.prompt.slice(0, 50)}\x1b[0m`);
    }

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
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const schema = TOOL_SCHEMAS[block.name];
      const input = schema ? schema.parse(block.input) : (block.input as any);

      if (shouldRunBackground(block.name, input)) {
        const bgId = startBackgroundTask(block.name, block.id, input);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `[Background task ${bgId} started] Result will be available when complete.`,
        });
      } else {
        const output = executeTool(block.name, input);
        console.log(output.slice(0, 300));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // tool_result blocks and background notifications share one user message
    const bgNotifications = collectBackgroundResults();
    const content: Anthropic.ContentBlockParam[] = [
      ...results,
      ...bgNotifications.map((n) => ({ type: "text" as const, text: n })),
    ];
    messages.push({ role: "user", content });

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── Session state + agent lock ──────────────────────────

const sessionHistory: Anthropic.MessageParam[] = [];
let sessionContext = updateContext();

// Single-threaded analog of Python's agent_lock: the queue processor skips
// when held (acquire(blocking=False)); user input waits for it.
let agentBusy = false;

// Run one agent turn. Caller must hold the agent lock (agentBusy === true).
async function runAgentTurnLocked(userQuery?: string): Promise<void> {
  if (userQuery !== undefined) {
    sessionHistory.push({ role: "user", content: userQuery });
  }
  const finalText = await agentLoop(sessionHistory, sessionContext);
  sessionContext = updateContext();
  console.log(finalText);
  console.log();
}

// Auto-deliver fired cron jobs when the agent is idle.
function startQueueProcessor(): void {
  setInterval(async () => {
    if (!hasCronQueue() || agentBusy) return;
    agentBusy = true;
    try {
      if (!hasCronQueue()) return;
      console.log(
        "\n  \x1b[35m[queue processor] delivering scheduled work\x1b[0m",
      );
      await runAgentTurnLocked();
    } finally {
      agentBusy = false;
    }
  }, 200).unref();
}

// ── Entry point ──────────────────────────────────────────
console.log("s14: cron scheduler");
console.log("输入问题，回车发送。输入 q 退出。\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

startQueueProcessor();
console.log("  \x1b[35m[queue processor] started\x1b[0m");

while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms14 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  // Blocking acquire: wait until the queue processor finishes its turn
  while (agentBusy) await sleep(100);
  agentBusy = true;
  try {
    await runAgentTurnLocked(query);
  } finally {
    agentBusy = false;
  }
}
rl.close();

/**
 * s18_worktree_isolation/main.ts - Worktree 隔离
 *
 * git worktree + 任务-目录绑定 + 事件日志。
 *
 * 相比 s17 的变化：
 *   + Task 类型新增 worktree 字段（string | null）
 *   + validateWorktreeName：拒绝路径穿越和非法字符
 *   + createWorktree：校验名称、执行 git worktree add、可选绑定任务
 *   + bindTaskToWorktree：只写 worktree 字段，任务状态仍保持 pending
 *   + removeWorktree：强制删除前先做安全检查，不自动完成任务
 *   + runGit 返回 [ok, output]，只有成功时才记录事件
 *   + 当已绑定任务被认领时，队友工具会在 worktree 的 cwd 下运行
 *   + 3 个新的 Lead 工具：create_worktree、remove_worktree、keep_worktree
 *
 * ASCII 拓扑：
 *   Main repo (/)
 *     ├── .worktrees/auth/  (branch: wt/auth)  ← Task #1
 *     ├── .worktrees/ui/    (branch: wt/ui)    ← Task #2
 *     ├── .tasks/task_xxx.json (worktree: "auth")
 *     └── .worktrees/events.jsonl
 *
 * TS 特有说明：
 *   - runGit 使用 spawnSync("git", args) —— 参数数组形式，不经过 shell
 *   - 队友的 worktree cwd 保存在一个闭包对象里（wtCtx），
 *     和 Python 版 dict-in-closure 的技巧一样
 *
 * Usage:
 *     pnpm dev s18_worktree_isolation/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID } from "../lib/model";
import { textOf, zodTool } from "../lib/tools";
import { errMsg, type Handlers } from "../s02_tool_use/main";
import { sleep } from "../s11_error_recovery/main";

const client = createClient();

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

// ═══════════════════════════════════════════════════════════
//  FROM s12 (+ s18 worktree field): Task System
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
  worktree: string | null; // s18: bound worktree name
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
    worktree: null,
  };
  saveTask(task);
  return task;
}

function saveTask(task: Task): void {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

function loadTask(taskId: string): Task {
  const task = JSON.parse(fs.readFileSync(taskPath(taskId), "utf8")) as Task;
  task.worktree ??= null;
  return task;
}

function listTasks(): Task[] {
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort()
    .map((f) => {
      const task = JSON.parse(
        fs.readFileSync(path.join(TASKS_DIR, f), "utf8"),
      ) as Task;
      task.worktree ??= null;
      return task;
    });
}

function getTaskJson(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

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
  if (task.owner) {
    return `Task ${taskId} already owned by ${task.owner}`;
  }
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(
      (d) => fs.existsSync(taskPath(d)) && loadTask(d).status !== "completed",
    );
    const missing = task.blockedBy.filter((d) => !fs.existsSync(taskPath(d)));
    const parts: string[] = [];
    if (deps.length) parts.push(`blocked by: [${deps.join(", ")}]`);
    if (missing.length) parts.push(`missing deps: [${missing.join(", ")}]`);
    return `Cannot start — ${parts.join(", ")}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  console.log(`  \x1b[36m[claim] ${task.subject} → in_progress\x1b[0m`);
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
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  NEW in s18: Worktree System
// ═══════════════════════════════════════════════════════════

const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
fs.mkdirSync(WORKTREES_DIR, { recursive: true });

const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

// Return error message if invalid, null if valid.
function validateWorktreeName(name: string): string | null {
  if (!name) return "Worktree name cannot be empty";
  if (name === "." || name === "..")
    return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return (
      `Invalid worktree name '${name}': ` +
      "only letters, digits, dots, underscores, dashes (1-64 chars)"
    );
  }
  return null;
}

// Run git command. Return [ok, output].
function runGit(args: string[]): [boolean, string] {
  const r = spawnSync("git", args, {
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return [false, "Error: git timeout"];
    return [false, `Error: ${r.error.message}`];
  }
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return [r.status === 0, out ? out.slice(0, 5000) : "(no output)"];
}

// Append a lifecycle event to events.jsonl.
function logEvent(eventType: string, worktreeName: string, taskId = ""): void {
  const event = {
    type: eventType,
    worktree: worktreeName,
    task_id: taskId,
    ts: Date.now() / 1000,
  };
  fs.appendFileSync(
    path.join(WORKTREES_DIR, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
}

// Create a git worktree with a dedicated branch. Optionally bind to a task.
function createWorktree(name: string, taskId = ""): string {
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  const wtPath = path.join(WORKTREES_DIR, name);
  if (fs.existsSync(wtPath)) {
    return `Worktree '${name}' already exists at ${wtPath}`;
  }
  const [ok, result] = runGit([
    "worktree",
    "add",
    wtPath,
    "-b",
    `wt/${name}`,
    "HEAD",
  ]);
  if (!ok) return `Git error: ${result}`;
  if (taskId) {
    bindTaskToWorktree(taskId, name);
  }
  logEvent("create", name, taskId);
  console.log(`  \x1b[33m[worktree] created: ${name} at ${wtPath}\x1b[0m`);
  return `Worktree '${name}' created at ${wtPath}`;
}

// Write worktree field to task. Keep status as pending for auto-claim.
function bindTaskToWorktree(taskId: string, worktreeName: string): void {
  const task = loadTask(taskId);
  task.worktree = worktreeName;
  saveTask(task);
  console.log(
    `  \x1b[33m[bind] ${task.subject} → worktree:${worktreeName}\x1b[0m`,
  );
}

// Count uncommitted files and commits in a worktree.
function countWorktreeChanges(wtPath: string): [number, number] {
  try {
    const r1 = spawnSync("git", ["status", "--porcelain"], {
      cwd: wtPath,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r1.error) return [-1, -1];
    const files = (r1.stdout ?? "").split("\n").filter((l) => l.trim()).length;
    const r2 = spawnSync("git", ["log", "@{push}..HEAD", "--oneline"], {
      cwd: wtPath,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r2.error) return [-1, -1];
    const commits = (r2.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim()).length;
    return [files, commits];
  } catch {
    return [-1, -1];
  }
}

// Remove worktree. Refuses if uncommitted changes unless discardChanges.
function removeWorktree(name: string, discardChanges = false): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  const wtPath = path.join(WORKTREES_DIR, name);
  if (!fs.existsSync(wtPath)) {
    return `Worktree '${name}' not found`;
  }
  if (!discardChanges) {
    const [files, commits] = countWorktreeChanges(wtPath);
    if (files < 0) {
      return (
        `Cannot verify worktree '${name}' status. ` +
        "Use discard_changes=true to force removal."
      );
    }
    if (files > 0 || commits > 0) {
      return (
        `Worktree '${name}' has ${files} uncommitted file(s) ` +
        `and ${commits} unpushed commit(s). ` +
        "Use discard_changes=true to force removal, " +
        "or keep_worktree to preserve for review."
      );
    }
  }
  const [ok1] = runGit(["worktree", "remove", wtPath, "--force"]);
  if (!ok1) return `Failed to remove worktree directory for '${name}'`;
  runGit(["branch", "-D", `wt/${name}`]);
  logEvent("remove", name);
  console.log(`  \x1b[33m[worktree] removed: ${name}\x1b[0m`);
  return `Worktree '${name}' removed`;
}

// Keep worktree for manual review. Branch preserved.
function keepWorktree(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  console.log(`  \x1b[36m[worktree] kept: ${name}\x1b[0m`);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

// ═══════════════════════════════════════════════════════════
//  FROM s10 (synced): Prompt Assembly
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Available tools: bash, read_file, write_file, " +
    "create_task, list_tasks, get_task, claim_task, complete_task, " +
    "spawn_teammate, send_message, check_inbox, " +
    "request_shutdown, request_plan, review_plan, " +
    "create_worktree, remove_worktree, keep_worktree.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

type Context = { memories: string };

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

let lastContextHash: string | null = null;
let lastPrompt: string | null = null;

function getSystemPrompt(context: Context): string {
  const h = JSON.stringify(context, Object.keys(context).sort());
  if (h === lastContextHash && lastPrompt) {
    return lastPrompt;
  }
  lastContextHash = h;
  lastPrompt = assembleSystemPrompt(context);
  return lastPrompt;
}

// ═══════════════════════════════════════════════════════════
//  Basic tools (s18: optional cwd for worktree isolation)
// ═══════════════════════════════════════════════════════════

function safePath(p: string, cwd?: string | null): string {
  const base = cwd || WORKDIR;
  const resolved = path.resolve(base, p);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string, cwd?: string | null): string {
  const r = spawnSync(command, {
    shell: true,
    cwd: cwd || WORKDIR,
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

function runRead(p: string, limit?: number, cwd?: string | null): string {
  try {
    let lines = fs.readFileSync(safePath(p, cwd), "utf8").split("\n");
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

function runWrite(p: string, content: string, cwd?: string | null): string {
  try {
    const filePath = safePath(p, cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ═══════════════════════════════════════════════════════════
//  FROM s15: MessageBus (+ metadata field)
// ═══════════════════════════════════════════════════════════

const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
fs.mkdirSync(MAILBOX_DIR, { recursive: true });

type BusMessage = {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
};

class MessageBus {
  send(
    fromAgent: string,
    toAgent: string,
    content: string,
    msgType = "message",
    metadata: Record<string, unknown> = {},
  ): void {
    const msg: BusMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type: msgType,
      ts: Date.now() / 1000,
      metadata,
    };
    fs.appendFileSync(
      path.join(MAILBOX_DIR, `${toAgent}.jsonl`),
      `${JSON.stringify(msg)}\n`,
    );
    console.log(
      `  \x1b[33m[bus] ${fromAgent} → ${toAgent}: (${msgType}) ${content.slice(0, 50)}\x1b[0m`,
    );
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const msgs = fs
      .readFileSync(inbox, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BusMessage);
    fs.unlinkSync(inbox);
    return msgs;
  }
}

const BUS = new MessageBus();
const activeTeammates = new Set<string>();

// ═══════════════════════════════════════════════════════════
//  FROM s16: Protocol State
// ═══════════════════════════════════════════════════════════

type ProtocolState = {
  requestId: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  createdAt: number;
};

const pendingRequests = new Map<string, ProtocolState>();

const newRequestId = () =>
  `req_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;

function matchResponse(
  responseType: string,
  requestId: string,
  approve: boolean,
): void {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  if (state.type === "shutdown" && responseType !== "shutdown_response") {
    console.log(
      `  \x1b[31m[protocol] type mismatch: expected shutdown_response, got ${responseType}\x1b[0m`,
    );
    return;
  }
  if (
    state.type === "plan_approval" &&
    responseType !== "plan_approval_response"
  ) {
    console.log(
      `  \x1b[31m[protocol] type mismatch: expected plan_approval_response, got ${responseType}\x1b[0m`,
    );
    return;
  }
  state.status = approve ? "approved" : "rejected";
  const icon = approve ? "✓" : "✗";
  const color = approve ? "32" : "31";
  console.log(
    `  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`,
  );
}

function consumeLeadInbox(routeProtocol = true): BusMessage[] {
  const msgs = BUS.readInbox("lead");
  if (routeProtocol) {
    for (const msg of msgs) {
      const reqId = String(msg.metadata?.request_id ?? "");
      if (reqId && msg.type.endsWith("_response")) {
        matchResponse(msg.type, reqId, Boolean(msg.metadata?.approve));
      }
    }
  }
  return msgs;
}

// ═══════════════════════════════════════════════════════════
//  FROM s17 (+ worktree cwd): Autonomous Agent
// ═══════════════════════════════════════════════════════════

const IDLE_POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

// Find pending, unowned tasks with all dependencies completed.
function scanUnclaimedTasks(): Task[] {
  return listTasks().filter(
    (t) => t.status === "pending" && !t.owner && canStart(t.id),
  );
}

// Poll for 60s. Return 'work', 'shutdown', or 'timeout'.
async function idlePoll(
  name: string,
  messages: Anthropic.MessageParam[],
): Promise<"work" | "shutdown" | "timeout"> {
  for (let i = 0; i < IDLE_TIMEOUT / IDLE_POLL_INTERVAL; i++) {
    await sleep(IDLE_POLL_INTERVAL * 1000);

    const inbox = BUS.readInbox(name);
    if (inbox.length) {
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = String(msg.metadata?.request_id ?? "");
          BUS.send(
            name,
            "lead",
            "Shutting down gracefully.",
            "shutdown_response",
            {
              request_id: reqId,
              approve: true,
            },
          );
          console.log(
            `  \x1b[35m[protocol] ${name} approved shutdown in idle (${reqId})\x1b[0m`,
          );
          return "shutdown";
        }
      }

      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox)}</inbox>`,
      });
      console.log(`  \x1b[36m[idle] ${name} found inbox messages\x1b[0m`);
      return "work";
    }

    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length) {
      const task = unclaimed[0];
      const result = claimTask(task.id, name);
      if (result.includes("Claimed")) {
        let wtInfo = "";
        if (task.worktree) {
          wtInfo = `\nWork directory: ${path.join(WORKTREES_DIR, task.worktree)}`;
        }
        messages.push({
          role: "user",
          content: `<auto-claimed>Task ${task.id}: ${task.subject}${wtInfo}</auto-claimed>`,
        });
        console.log(
          `  \x1b[32m[idle] ${name} auto-claimed: ${task.subject}\x1b[0m`,
        );
        return "work";
      }
      console.log(`  \x1b[33m[idle] ${name} claim failed: ${result}\x1b[0m`);
    }
  }

  console.log(`  \x1b[31m[idle] ${name} timeout (${IDLE_TIMEOUT}s)\x1b[0m`);
  return "timeout";
}

// ═══════════════════════════════════════════════════════════
//  Teammate (s15 + s16 + s17 + s18)
// ═══════════════════════════════════════════════════════════

function spawnTeammateThread(
  name: string,
  role: string,
  prompt: string,
): string {
  if (activeTeammates.has(name)) {
    return `Teammate '${name}' already exists`;
  }

  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `You can list and claim tasks from the board. ` +
    `If a task has a worktree, work in that directory.`;

  const handleInboxMessage = (
    msg: BusMessage,
    messages: Anthropic.MessageParam[],
  ): boolean => {
    const reqId = String(msg.metadata?.request_id ?? "");

    if (msg.type === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
        request_id: reqId,
        approve: true,
      });
      console.log(
        `  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`,
      );
      return true;
    }

    if (msg.type === "plan_approval_response") {
      const approve = Boolean(msg.metadata?.approve);
      messages.push({
        role: "user",
        content: approve
          ? "[Plan approved] Proceed with the task."
          : `[Plan rejected] Feedback: ${msg.content}`,
      });
    }
    return false;
  };

  const run = async () => {
    // Track current worktree for this teammate's cwd
    const wtCtx: { path: string | null } = { path: null };

    // Once a task with a worktree is claimed, all teammate file tools
    // transparently run inside that isolated directory.
    const subListTasks = () => {
      const tasks = listTasks();
      if (!tasks.length) return "No tasks.";
      return tasks
        .map(
          (t) =>
            `  ${t.id}: ${t.subject} [${t.status}]` +
            (t.worktree ? ` (wt:${t.worktree})` : ""),
        )
        .join("\n");
    };

    const subClaimTask = (taskId: string) => {
      const result = claimTask(taskId, name);
      if (result.includes("Claimed")) {
        // Set worktree cwd if task has one
        const task = loadTask(taskId);
        wtCtx.path = task.worktree
          ? path.join(WORKTREES_DIR, task.worktree)
          : null;
      }
      return result;
    };

    const subCompleteTask = (taskId: string) => {
      const result = completeTask(taskId);
      wtCtx.path = null;
      return result;
    };

    const subBashSchema = z.object({ command: z.string() });
    const subReadSchema = z.object({ path: z.string() });
    const subWriteSchema = z.object({ path: z.string(), content: z.string() });
    const subSendMessageSchema = z.object({
      to: z.string(),
      content: z.string(),
    });
    const subSubmitPlanSchema = z.object({ plan: z.string() });
    const subListTasksSchema = z.object({});
    const subClaimTaskSchema = z.object({ task_id: z.string() });
    const subCompleteTaskSchema = z.object({ task_id: z.string() });

    const subTools: Anthropic.Tool[] = [
      zodTool("bash", "Run a shell command.", subBashSchema),
      zodTool("read_file", "Read file contents.", subReadSchema),
      zodTool("write_file", "Write content to a file.", subWriteSchema),
      zodTool(
        "send_message",
        "Send a message to another agent.",
        subSendMessageSchema,
      ),
      zodTool(
        "submit_plan",
        "Submit a plan for Lead approval.",
        subSubmitPlanSchema,
      ),
      zodTool("list_tasks", "List all tasks on the board.", subListTasksSchema),
      zodTool("claim_task", "Claim a pending task.", subClaimTaskSchema),
      zodTool(
        "complete_task",
        "Mark an in-progress task as completed.",
        subCompleteTaskSchema,
      ),
    ];
    const subSchemas: Partial<Record<string, z.ZodObject>> = {
      bash: subBashSchema,
      read_file: subReadSchema,
      write_file: subWriteSchema,
      send_message: subSendMessageSchema,
      submit_plan: subSubmitPlanSchema,
      list_tasks: subListTasksSchema,
      claim_task: subClaimTaskSchema,
      complete_task: subCompleteTaskSchema,
    };

    const subHandlers: Handlers = {
      bash: ({ command }) => runBash(command, wtCtx.path),
      read_file: ({ path }) => runRead(path, undefined, wtCtx.path),
      write_file: ({ path, content }) => runWrite(path, content, wtCtx.path),
      send_message: ({ to, content }) => {
        BUS.send(name, to, content);
        return "Sent";
      },
      submit_plan: ({ plan }) => teammateSubmitPlan(name, plan),
      list_tasks: () => subListTasks(),
      claim_task: ({ task_id }) => subClaimTask(task_id),
      complete_task: ({ task_id }) => subCompleteTask(task_id),
    };

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    let lastText = "";
    let shouldShutdown = false;

    // Outer loop: WORK → IDLE cycle
    while (true) {
      if (messages.length <= 3) {
        messages.unshift({
          role: "user",
          content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
        });
      }

      // WORK phase
      for (let round = 0; round < 10; round++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (handleInboxMessage(msg, messages)) {
            shouldShutdown = true;
            break;
          }
        }
        if (shouldShutdown) break;
        const nonProtocol = inbox.filter((m) => m.type === "message");
        if (nonProtocol.length) {
          messages.push({
            role: "user",
            content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>`,
          });
        }

        let response: Anthropic.Message;
        try {
          response = await client.messages.create({
            model: MODEL_ID,
            system,
            messages: messages.slice(-20),
            tools: subTools,
            max_tokens: 8000,
          });
        } catch {
          break;
        }
        messages.push({ role: "assistant", content: response.content });
        const text = textOf(response);
        if (text) lastText = text;
        if (response.stop_reason !== "tool_use") break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const schema = subSchemas[block.name];
          const handler = subHandlers[block.name];
          const output =
            handler && schema ? handler(schema.parse(block.input)) : "Unknown";
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
        messages.push({ role: "user", content: results });
      }

      if (shouldShutdown) break;

      // IDLE phase
      const idleResult = await idlePoll(name, messages);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

    // Send final summary to Lead
    BUS.send(name, "lead", lastText || "Done.", "result");
    activeTeammates.delete(name);
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`);
  };

  activeTeammates.add(name);
  void run();
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role} (autonomous)`;
}

function teammateSubmitPlan(fromName: string, plan: string): string {
  const reqId = newRequestId();
  pendingRequests.set(reqId, {
    requestId: reqId,
    type: "plan_approval",
    sender: fromName,
    target: "lead",
    status: "pending",
    payload: plan,
    createdAt: Date.now() / 1000,
  });
  BUS.send(fromName, "lead", plan, "plan_approval_request", {
    request_id: reqId,
  });
  return `Plan submitted (${reqId}). Waiting for approval...`;
}

// ═══════════════════════════════════════════════════════════
//  FROM s16: Lead Protocol Tools
// ═══════════════════════════════════════════════════════════

function runRequestShutdown(teammate: string): string {
  const reqId = newRequestId();
  pendingRequests.set(reqId, {
    requestId: reqId,
    type: "shutdown",
    sender: "lead",
    target: teammate,
    status: "pending",
    payload: "",
    createdAt: Date.now() / 1000,
  });
  BUS.send(
    "lead",
    teammate,
    "Please shut down gracefully.",
    "shutdown_request",
    {
      request_id: reqId,
    },
  );
  console.log(
    `  \x1b[35m[protocol] shutdown_request → ${teammate} (${reqId})\x1b[0m`,
  );
  return `Shutdown request sent to ${teammate} (req: ${reqId})`;
}

function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Please submit a plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(
  requestId: string,
  approve: boolean,
  feedback = "",
): string {
  const state = pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  if (state.status !== "pending")
    return `Request ${requestId} already ${state.status}`;
  state.status = approve ? "approved" : "rejected";
  BUS.send(
    "lead",
    state.sender,
    feedback || (approve ? "Approved" : "Rejected"),
    "plan_approval_response",
    { request_id: requestId, approve },
  );
  const icon = approve ? "✓" : "✗";
  console.log(`  \x1b[32m[protocol] plan ${icon} (${requestId})\x1b[0m`);
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

// ── Basic tool handlers ──

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
  if (!tasks.length) return "No tasks.";
  return tasks
    .map(
      (t) =>
        `  ${t.id}: ${t.subject} [${t.status}]` +
        (t.worktree ? ` (wt:${t.worktree})` : ""),
    )
    .join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTaskJson(taskId);
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function runCheckInbox(): string {
  const msgs = consumeLeadInbox(true);
  if (!msgs.length) return "(inbox empty)";
  return msgs
    .map((m) => {
      const reqId = String(m.metadata?.request_id ?? "");
      const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`;
      return `  [${m.from}]${tag} ${m.content.slice(0, 200)}`;
    })
    .join("\n");
}

// ── Tool definitions ──

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
const spawnTeammateSchema = z.object({
  name: z.string(),
  role: z.string(),
  prompt: z.string(),
});
const sendMessageSchema = z.object({ to: z.string(), content: z.string() });
const checkInboxSchema = z.object({});
const requestShutdownSchema = z.object({ teammate: z.string() });
const requestPlanSchema = z.object({ teammate: z.string(), task: z.string() });
const reviewPlanSchema = z.object({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});
const createWorktreeSchema = z.object({
  name: z.string(),
  task_id: z.string().optional(),
});
const removeWorktreeSchema = z.object({
  name: z.string(),
  discard_changes: z.boolean().optional(),
});
const keepWorktreeSchema = z.object({ name: z.string() });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("create_task", "Create a task.", createTaskSchema),
  zodTool("list_tasks", "List all tasks.", listTasksSchema),
  zodTool("get_task", "Get full details of a specific task.", getTaskSchema),
  zodTool("claim_task", "Claim a pending task.", claimTaskSchema),
  zodTool("complete_task", "Complete an in-progress task.", completeTaskSchema),
  zodTool(
    "spawn_teammate",
    "Spawn an autonomous teammate agent.",
    spawnTeammateSchema,
  ),
  zodTool("send_message", "Send message to a teammate.", sendMessageSchema),
  zodTool(
    "check_inbox",
    "Check inbox for messages and protocol responses.",
    checkInboxSchema,
  ),
  zodTool(
    "request_shutdown",
    "Request a teammate to shut down gracefully.",
    requestShutdownSchema,
  ),
  zodTool(
    "request_plan",
    "Ask a teammate to submit a plan for review.",
    requestPlanSchema,
  ),
  zodTool(
    "review_plan",
    "Approve or reject a submitted plan.",
    reviewPlanSchema,
  ),
  // s18 new: worktree tools
  zodTool(
    "create_worktree",
    "Create an isolated git worktree with its own branch.",
    createWorktreeSchema,
  ),
  zodTool(
    "remove_worktree",
    "Remove a worktree. Refuses if uncommitted changes unless discard_changes=true.",
    removeWorktreeSchema,
  ),
  zodTool(
    "keep_worktree",
    "Keep a worktree for manual review.",
    keepWorktreeSchema,
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
  spawn_teammate: spawnTeammateSchema,
  send_message: sendMessageSchema,
  check_inbox: checkInboxSchema,
  request_shutdown: requestShutdownSchema,
  request_plan: requestPlanSchema,
  review_plan: reviewPlanSchema,
  create_worktree: createWorktreeSchema,
  remove_worktree: removeWorktreeSchema,
  keep_worktree: keepWorktreeSchema,
};

const TOOL_HANDLERS: Handlers = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  create_task: ({ subject, description, blockedBy }) =>
    runCreateTask(subject, description ?? "", blockedBy),
  list_tasks: () => runListTasks(),
  get_task: ({ task_id }) => runGetTask(task_id),
  claim_task: ({ task_id }) => claimTask(task_id, "agent"),
  complete_task: ({ task_id }) => completeTask(task_id),
  spawn_teammate: ({ name, role, prompt }) =>
    runSpawnTeammate(name, role, prompt),
  send_message: ({ to, content }) => runSendMessage(to, content),
  check_inbox: () => runCheckInbox(),
  request_shutdown: ({ teammate }) => runRequestShutdown(teammate),
  request_plan: ({ teammate, task }) => runRequestPlan(teammate, task),
  review_plan: ({ request_id, approve, feedback }) =>
    runReviewPlan(request_id, approve, feedback ?? ""),
  create_worktree: ({ name, task_id }) => createWorktree(name, task_id ?? ""),
  remove_worktree: ({ name, discard_changes }) =>
    removeWorktree(name, discard_changes ?? false),
  keep_worktree: ({ name }) => keepWorktree(name),
};

// ── Context ──

function updateContext(): Context {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf8").slice(0, 2000);
  }
  return { memories };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop
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
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema ? handler(schema.parse(block.input)) : "Unknown";
      console.log(output.slice(0, 300));
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

// ── Entry point ──────────────────────────────────────────
console.log("s18: worktree isolation");
console.log("输入问题，回车发送。输入 q 退出。\n");

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
    query = await rl.question("\x1b[36ms18 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  console.log(finalText);

  // Consume lead inbox: route protocol + inject into history
  const inbox = consumeLeadInbox(true);
  if (inbox.length) {
    const inboxText = inbox
      .map(
        (m) =>
          `From ${m.from} [${m.type || "message"}]: ${m.content.slice(0, 200)}`,
      )
      .join("\n");
    history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
  }
  console.log();
}
rl.close();

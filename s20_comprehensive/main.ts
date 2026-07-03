/**
 * s20_comprehensive/main.ts - 综合版 Agent
 *
 * 把所有教学组件汇聚到同一个循环里。
 *
 * 这最后一章有意把此前讲过的所有教学机制重新组合到一起：分发、权限、
 * hooks、todo、subagent、skills、压缩、记忆、prompt 组装、错误恢复、
 * 任务图、后台任务、cron、团队、协议、自治 agent、worktree 和 MCP。
 *
 * ASCII 流程：
 *   user / cron / background / inbox
 *        ↓
 *   prepareContext（budget → snip → micro → auto compact）
 *        ↓
 *   assembleSystemPrompt（身份 + 工具 + skills + 记忆 + MCP）
 *        ↓
 *   callLLM（withRetry：429/529 退避、备用模型）
 *        ↓                    ↘ length → 升级 / 续写
 *   hooks（PreToolUse）→ dispatch（前台 | 后台 | 压缩）
 *        ↓
 *   工具结果 + task_notifications → 循环
 *
 * TS 特有说明：
 *   - Frontmatter 沿用 s07 里那个极简的 `key: value` 逐行解析器，
 *     而不是 PyYAML
 *   - Python 守护线程 → setInterval(...).unref() 定时器；agent_lock →
 *     agentBusy 布尔值（单线程事件循环，参见 s14）
 *   - 在 AI SDK 里工具结果是 `role: "tool"` 消息，所以已完成的后台通知
 *     会单独放进一条 user 消息，而不是合并进 tool_result 内容里
 *     （参见 s13/s14）
 *   - Python 版本会忽略 submit_plan 之后的 tool_use blocks，容许缺失的
 *     tool_result；AI SDK 会校验配对关系，所以被跳过的调用会得到一个
 *     "[Ignored: waiting for plan approval]" 占位结果
 *   - terminal_print 的 readline.get_line_buffer() → rl.line 重绘
 *
 * Usage:
 *     pnpm dev s20_comprehensive/main.ts
 */

import { exec, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart, ToolSet } from "ai";
import { z } from "zod";
import { anthropic, MODEL_ID, model } from "../lib/model";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const PRIMARY_MODEL = MODEL_ID;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID;

const DEFAULT_MAX_TOKENS = 8000;
const ESCALATED_MAX_TOKENS = 16_000;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_529 = 2;
const MAX_RECOVERY_RETRIES = 2;
const BASE_DELAY_MS = 500;
const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT_TOOL_RESULTS = 3;
const PERSIST_THRESHOLD = 30_000;
const CONTINUATION_PROMPT = "Continue from the previous response. Do not repeat completed work.";
const PROMPT = "\x1b[36ms20 >> \x1b[0m";
let CLI_ACTIVE = false;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const execAsync = promisify(exec);

// Shared readline: hooks (Allow? prompt), terminalPrint redraw, and the REPL.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

// Print from a timer/background context without corrupting the input line:
// clear the current line, print, then redraw the prompt + typed text.
function terminalPrint(text: string): void {
  if (!CLI_ACTIVE) {
    console.log(text);
    return;
  }
  const line = (rl as unknown as { line?: string }).line ?? "";
  process.stdout.write(`\r\x1b[K${text}\n`);
  process.stdout.write(PROMPT + line);
}

// ═══════════════════════════════════════════════════════════
//  FROM s12/s18: Task System
// ═══════════════════════════════════════════════════════════

// Tasks are tiny durable records. Later systems add ownership, dependencies,
// worktrees, and teammates on top of this same file-backed state.
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
  worktree: string | null;
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
      const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task;
      task.worktree ??= null;
      return task;
    });
}

function getTaskJson(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

// Dependencies are intentionally simple: every blocker must exist and be
// completed before the task can be claimed.
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
    return "Cannot start — " + parts.join(", ");
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  terminalPrint(`  \x1b[36m[claim] ${task.subject} → in_progress\x1b[0m`);
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
  terminalPrint(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════
//  FROM s18: Worktree System
// ═══════════════════════════════════════════════════════════

// Worktree names become filesystem paths, so the teaching version keeps the
// validation rules strict and reuses them for create/remove/keep.
const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
fs.mkdirSync(WORKTREES_DIR, { recursive: true });

const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function validateWorktreeName(name: string): string | null {
  if (!name) return "Worktree name cannot be empty";
  if (name === "." || name === "..") return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return (
      `Invalid worktree name '${name}': ` +
      "only letters, digits, dots, underscores, dashes (1-64 chars)"
    );
  }
  return null;
}

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

function logEvent(eventType: string, worktreeName: string, taskId = ""): void {
  const event = { type: eventType, worktree: worktreeName, task_id: taskId, ts: Date.now() / 1000 };
  fs.appendFileSync(path.join(WORKTREES_DIR, "events.jsonl"), JSON.stringify(event) + "\n");
}

function createWorktree(name: string, taskId = ""): string {
  // Tool-layer validation is part of the safety boundary; do it before git
  // sees the name, not only after git happens to reject something.
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  if (taskId) {
    try {
      loadTask(taskId);
    } catch {
      return `Error: task ${taskId} not found`;
    }
  }
  const wtPath = path.join(WORKTREES_DIR, name);
  if (fs.existsSync(wtPath)) {
    return `Worktree '${name}' already exists at ${wtPath}`;
  }
  const [ok, result] = runGit(["worktree", "add", wtPath, "-b", `wt/${name}`, "HEAD"]);
  if (!ok) return `Git error: ${result}`;
  if (taskId) {
    bindTaskToWorktree(taskId, name);
  }
  logEvent("create", name, taskId);
  terminalPrint(`  \x1b[33m[worktree] created: ${name} at ${wtPath}\x1b[0m`);
  return `Worktree '${name}' created at ${wtPath}`;
}

function bindTaskToWorktree(taskId: string, worktreeName: string): void {
  const task = loadTask(taskId);
  task.worktree = worktreeName;
  saveTask(task);
}

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
    const commits = (r2.stdout ?? "").split("\n").filter((l) => l.trim()).length;
    return [files, commits];
  } catch {
    return [-1, -1];
  }
}

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
      return "Cannot verify status. Use discard_changes=true to force.";
    }
    if (files > 0 || commits > 0) {
      return (
        `Worktree '${name}' has ${files} file(s), ${commits} commit(s). ` +
        "Use discard_changes=true or keep_worktree."
      );
    }
  }
  const [ok1] = runGit(["worktree", "remove", wtPath, "--force"]);
  if (!ok1) return `Failed to remove worktree '${name}'`;
  runGit(["branch", "-D", `wt/${name}`]);
  logEvent("remove", name);
  terminalPrint(`  \x1b[33m[worktree] removed: ${name}\x1b[0m`);
  return `Worktree '${name}' removed`;
}

function keepWorktree(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

// ═══════════════════════════════════════════════════════════
//  FROM s07: Skill Loading
// ═══════════════════════════════════════════════════════════

type Skill = { name: string; description: string; content: string };

const SKILL_REGISTRY: Record<string, Skill> = {};

// Parse frontmatter from SKILL.md. Returns { meta, body }.
// Minimal `key: value` line parser (Python uses PyYAML).
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(end + 3).trim() };
}

function scanSkills(): void {
  for (const key of Object.keys(SKILL_REGISTRY)) delete SKILL_REGISTRY[key];
  if (!fs.existsSync(SKILLS_DIR)) return;
  for (const entry of fs.readdirSync(SKILLS_DIR).sort()) {
    const dir = path.join(SKILLS_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifest = path.join(dir, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const { meta } = parseFrontmatter(raw);
    const name = meta.name || entry;
    const description = meta.description || raw.split("\n")[0].replace(/^#+/, "").trim();
    SKILL_REGISTRY[name] = { name, description, content: raw };
  }
}

scanSkills();

function listSkills(): string {
  const skills = Object.values(SKILL_REGISTRY);
  if (!skills.length) return "(no skills found)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) {
    const available = Object.keys(SKILL_REGISTRY).join(", ") || "(none)";
    return `Skill not found: ${name}. Available: ${available}`;
  }
  return skill.content;
}

// ═══════════════════════════════════════════════════════════
//  FROM s10: Prompt Assembly
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Available tools: bash, read_file, write_file, edit_file, glob, " +
    "todo_write, task, load_skill, compact, " +
    "create_task, list_tasks, get_task, claim_task, complete_task, " +
    "schedule_cron, list_crons, cancel_cron, " +
    "spawn_teammate, send_message, check_inbox, " +
    "request_shutdown, request_plan, review_plan, " +
    "create_worktree, remove_worktree, keep_worktree, " +
    "connect_mcp. MCP tools are prefixed mcp__{server}__{tool}.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

type Context = {
  memories: string;
  connectedMcp: string[];
  activeTeammates: string[];
};

// The system prompt is rebuilt each turn from live context. This is where
// memory, skill catalog, MCP state, and active teammates become visible.
function assembleSystemPrompt(context: Context): string {
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
  sections.push(`Current time: ${new Date().toISOString().slice(0, 19)}`);
  sections.push(
    "Skills catalog:\n" + listSkills() + "\nUse load_skill(name) when a skill is relevant.",
  );
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }
  const mcpNames = Object.keys(mcpClients);
  if (mcpNames.length) {
    sections.push(`Connected MCP servers: ${mcpNames.join(", ")}`);
  }
  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════
//  FROM s02-s05: Basic tools (worktree-aware cwd)
// ═══════════════════════════════════════════════════════════

// File tools stay inside the workspace or teammate worktree. Bash remains
// powerful on purpose and is controlled by the permission hook instead.
function safePath(p: string, cwd?: string | null): string {
  const base = cwd || WORKDIR;
  const resolved = path.resolve(base, p);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// run_in_background is consumed by the dispatcher; direct execution ignores it.
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

// Async variant for background execution — keeps the event loop free.
async function runBashAsync(command: string, cwd?: string | null): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || WORKDIR,
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

function runRead(p: string, limit?: number, offset = 0, cwd?: string | null): string {
  try {
    let lines = fs.readFileSync(safePath(p, cwd), "utf8").split("\n");
    lines = lines.slice(Math.max(offset, 0));
    if (limit != null && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
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

function runEdit(p: string, oldText: string, newText: string, cwd?: string | null): string {
  try {
    const filePath = safePath(p, cwd);
    const text = fs.readFileSync(filePath, "utf8");
    // indexOf + slice instead of String.replace: replace would treat
    // `$&`-style patterns in newText as special replacement syntax.
    const i = text.indexOf(oldText);
    if (i === -1) return `Error: text not found in ${p}`;
    fs.writeFileSync(filePath, text.slice(0, i) + newText + text.slice(i + oldText.length));
    return `Edited ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runGlob(pattern: string, cwd?: string | null): string {
  try {
    const base = cwd || WORKDIR;
    const results = fs
      .globSync(pattern, { cwd: base })
      .filter((m) => path.resolve(base, m).startsWith(base + path.sep));
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ── Todo ──

const todoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
type Todo = z.infer<typeof todoItem>;

let currentTodos: Todo[] = [];

function normalizeTodos(todos: unknown): { todos?: Todo[]; error?: string } {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { error: "Error: todos must be a list or JSON array string" };
    }
  }
  const parsed = z.array(todoItem).safeParse(todos);
  if (!parsed.success) {
    return { error: "Error: todos must be a list of {content, status} objects" };
  }
  return { todos: parsed.data };
}

function runTodoWrite(todosInput: unknown): string {
  const { todos, error } = normalizeTodos(todosInput);
  if (error || !todos) return error ?? "Error: invalid todos";
  currentTodos = todos;
  terminalPrint(`  \x1b[33m[todo] updated ${currentTodos.length} item(s)\x1b[0m`);
  return `Updated ${currentTodos.length} todos`;
}

// ═══════════════════════════════════════════════════════════
//  FROM s15: MessageBus
// ═══════════════════════════════════════════════════════════

// Team communication is append-only JSONL mailboxes. This keeps the protocol
// inspectable on disk and lets background teammates send messages.
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
    fs.appendFileSync(path.join(MAILBOX_DIR, `${toAgent}.jsonl`), JSON.stringify(msg) + "\n");
    terminalPrint(
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

// Responses are matched by request_id so one protocol reply cannot approve
// a different pending request.
function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) return;
  if (state.type === "shutdown" && responseType !== "shutdown_response") return;
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") return;
  state.status = approve ? "approved" : "rejected";
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
//  FROM s17: Autonomous Agent
// ═══════════════════════════════════════════════════════════

const IDLE_POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

function scanUnclaimedTasks(): Task[] {
  return listTasks().filter((t) => t.status === "pending" && !t.owner && canStart(t.id));
}

// Autonomous teammates wake up for inbox messages first, then look for
// unclaimed tasks. This keeps direct protocol messages higher priority.
async function idlePoll(
  name: string,
  messages: ModelMessage[],
  worktreeContext?: { path: string | null },
): Promise<"work" | "shutdown" | "timeout"> {
  for (let i = 0; i < IDLE_TIMEOUT / IDLE_POLL_INTERVAL; i++) {
    await sleep(IDLE_POLL_INTERVAL * 1000);
    const inbox = BUS.readInbox(name);
    if (inbox.length) {
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = String(msg.metadata?.request_id ?? "");
          BUS.send(name, "lead", "Shutting down.", "shutdown_response", {
            request_id: reqId,
            approve: true,
          });
          return "shutdown";
        }
      }
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      return "work";
    }
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length) {
      const task = unclaimed[0];
      const result = claimTask(task.id, name);
      if (result.includes("Claimed")) {
        let wtInfo = "";
        if (task.worktree) {
          const wtPath = path.join(WORKTREES_DIR, task.worktree);
          wtInfo = `\nWork directory: ${wtPath}`;
          if (worktreeContext) {
            worktreeContext.path = wtPath;
          }
        }
        messages.push({
          role: "user",
          content: `<auto-claimed>Task ${task.id}: ${task.subject}${wtInfo}</auto-claimed>`,
        });
        return "work";
      }
    }
  }
  return "timeout";
}

// ═══════════════════════════════════════════════════════════
//  Teammate (s15 + s16 + s17 + s18)
// ═══════════════════════════════════════════════════════════

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) {
    return `Teammate '${name}' already exists`;
  }

  // Plan approval is a real gate: after submit_plan, the teammate stops
  // taking model/tool steps until lead sends plan_approval_response.
  const protocolCtx: { waitingPlan: string | null } = { waitingPlan: null };
  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `If a task has a worktree, work in that directory.`;

  const handleInboxMessage = (msg: BusMessage, messages: ModelMessage[]): boolean => {
    const reqId = String(msg.metadata?.request_id ?? "");
    if (msg.type === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down.", "shutdown_response", {
        request_id: reqId,
        approve: true,
      });
      return true;
    }
    if (msg.type === "plan_approval_response") {
      const approve = Boolean(msg.metadata?.approve);
      if (reqId === protocolCtx.waitingPlan) {
        protocolCtx.waitingPlan = null;
      }
      messages.push({
        role: "user",
        content: approve ? "[Plan approved]" : `[Plan rejected] ${msg.content}`,
      });
    }
    return false;
  };

  const run = async () => {
    // Once a task with a worktree is claimed, all teammate file tools
    // transparently run inside that isolated directory.
    const wtCtx: { path: string | null } = { path: null };

    const subListTasks = () => {
      const tasks = listTasks();
      if (!tasks.length) return "No tasks.";
      return tasks
        .map(
          (t) =>
            `  ${t.id}: ${t.subject} [${t.status}]` + (t.worktree ? ` (wt:${t.worktree})` : ""),
        )
        .join("\n");
    };

    const subClaimTask = (taskId: string) => {
      const result = claimTask(taskId, name);
      if (result.includes("Claimed")) {
        const task = loadTask(taskId);
        wtCtx.path = task.worktree ? path.join(WORKTREES_DIR, task.worktree) : null;
      }
      return result;
    };

    const subCompleteTask = (taskId: string) => {
      const result = completeTask(taskId);
      wtCtx.path = null;
      return result;
    };

    const subTools = {
      bash: tool({
        description: "Run a shell command.",
        inputSchema: z.object({ command: z.string() }),
      }),
      read_file: tool({
        description: "Read file contents.",
        inputSchema: z.object({
          path: z.string(),
          limit: z.number().int().optional(),
          offset: z.number().int().optional(),
        }),
      }),
      write_file: tool({
        description: "Write content to a file.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
      }),
      send_message: tool({
        description: "Send a message to another agent.",
        inputSchema: z.object({ to: z.string(), content: z.string() }),
      }),
      submit_plan: tool({
        description: "Submit a plan for Lead approval.",
        inputSchema: z.object({ plan: z.string() }),
      }),
      list_tasks: tool({
        description: "List all tasks.",
        inputSchema: z.object({}),
      }),
      claim_task: tool({
        description: "Claim a pending task.",
        inputSchema: z.object({ task_id: z.string() }),
      }),
      complete_task: tool({
        description: "Mark an in-progress task as completed.",
        inputSchema: z.object({ task_id: z.string() }),
      }),
    };

    const subHandlers: Record<string, (input: any) => string> = {
      bash: ({ command }) => runBash(command, wtCtx.path),
      read_file: ({ path, limit, offset }) => runRead(path, limit, offset ?? 0, wtCtx.path),
      write_file: ({ path, content }) => runWrite(path, content, wtCtx.path),
      send_message: ({ to, content }) => {
        BUS.send(name, to, content);
        return "Sent";
      },
      list_tasks: () => subListTasks(),
      claim_task: ({ task_id }) => subClaimTask(task_id),
      complete_task: ({ task_id }) => subCompleteTask(task_id),
    };

    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
    let lastText = "";
    let shouldShutdown = false;

    while (true) {
      if (messages.length <= 3) {
        messages.unshift({
          role: "user",
          content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
        });
      }

      for (let round = 0; round < 10; round++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (handleInboxMessage(msg, messages)) {
            shouldShutdown = true;
            break;
          }
        }
        if (shouldShutdown) break;
        if (protocolCtx.waitingPlan) {
          // Poll only for protocol replies while the approval gate is
          // closed; do not let the model continue with the task.
          await sleep(IDLE_POLL_INTERVAL * 1000);
          continue;
        }
        const nonProtocol = inbox.filter((m) => m.type === "message");
        if (nonProtocol.length) {
          messages.push({
            role: "user",
            content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>`,
          });
        }

        let result;
        try {
          result = await generateText({
            model,
            system,
            messages: messages.slice(-20),
            tools: subTools,
            maxOutputTokens: 8000,
          });
        } catch {
          break;
        }
        messages.push(...result.response.messages);
        if (result.text) lastText = result.text;
        if (result.finishReason !== "tool-calls") break;

        const results: ToolResultPart[] = [];
        for (const call of result.toolCalls) {
          if (call.dynamic) continue;
          let output: string;
          if (protocolCtx.waitingPlan) {
            // Later tool calls from the same response belong after approval.
            // (Python drops them; the AI SDK requires paired results.)
            output = "[Ignored: waiting for plan approval]";
          } else if (call.toolName === "submit_plan") {
            output = teammateSubmitPlan(name, (call.input as { plan?: string }).plan ?? "");
            const match = /\((req_\d+)\)/.exec(output);
            protocolCtx.waitingPlan = match ? match[1] : output;
          } else {
            const handler = subHandlers[call.toolName];
            output = handler ? handler(call.input) : "Unknown";
          }
          results.push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: output },
          });
        }
        messages.push({ role: "tool", content: results });
        if (protocolCtx.waitingPlan) break;
      }

      if (shouldShutdown) break;
      if (protocolCtx.waitingPlan) continue;
      const idleResult = await idlePoll(name, messages, wtCtx);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

    BUS.send(name, "lead", lastText || "Done.", "result");
    activeTeammates.delete(name);
  };

  activeTeammates.add(name);
  void run();
  return `Teammate '${name}' spawned as ${role}`;
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
  BUS.send(fromName, "lead", plan, "plan_approval_request", { request_id: reqId });
  return `Plan submitted (${reqId})`;
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
  BUS.send("lead", teammate, "Shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request sent to ${teammate}`;
}

function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Submit plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback = ""): string {
  const state = pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
    "plan_approval_response", { request_id: requestId, approve });
  return `Plan ${approve ? "approved" : "rejected"}`;
}

// ═══════════════════════════════════════════════════════════
//  FROM s03/s04: Hooks + Permission Pipeline
// ═══════════════════════════════════════════════════════════

// Hooks are intentionally outside tool handlers. The loop can add permission,
// logging, and stop behavior without changing each individual tool.
type Hook = (...args: any[]) => string | null | Promise<string | null>;

const HOOKS: Record<string, Hook[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: Hook): void {
  HOOKS[event].push(callback);
}

async function triggerHooks(event: string, ...args: any[]): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) return result;
  }
  return null;
}

// The shape PreToolUse/PostToolUse hooks receive — the AI SDK's tool
// call (Python hooks receive the raw `tool_use` block instead).
type ToolCallInfo = { toolName: string; input: any };

async function confirmWithUser(warning: string, detail: string): Promise<boolean> {
  console.log(`\n\x1b[33m[permission] ${warning}\x1b[0m`);
  console.log(`  ${detail}`);
  let choice: string;
  try {
    choice = (await rl.question("  Allow? [y/N] ")).trim().toLowerCase();
  } catch {
    return false; // stdin closed — nobody left to approve
  }
  return choice === "y" || choice === "yes";
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// The permission layer sees the tool call before dispatch. It can deny,
// ask the user, or allow execution to continue.
async function permissionHook(call: ToolCallInfo): Promise<string | null> {
  if (call.toolName === "bash") {
    const command: string = call.input.command ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied: '${pattern}' is on the deny list`;
      }
    }
    if (DESTRUCTIVE.some((token) => command.includes(token))) {
      if (!(await confirmWithUser("destructive command", command))) {
        return "Permission denied by user";
      }
    }
  }
  if (call.toolName === "write_file" || call.toolName === "edit_file") {
    const p: string = call.input.path ?? "";
    try {
      safePath(p);
    } catch {
      return `Permission denied: path escapes workspace: ${p}`;
    }
  }
  if (call.toolName.startsWith("mcp__") && call.toolName.includes("deploy")) {
    if (!(await confirmWithUser("MCP destructive-looking tool", call.toolName))) {
      return "Permission denied by user";
    }
  }
  return null;
}

function logHook(call: ToolCallInfo): null {
  console.log(`\x1b[90m[HOOK] ${call.toolName}\x1b[0m`);
  return null;
}

function largeOutputHook(call: ToolCallInfo, output: string): null {
  if (String(output).length > 100_000) {
    console.log(
      `\x1b[33m[HOOK] large output from ${call.toolName}: ${String(output).length} chars\x1b[0m`,
    );
  }
  return null;
}

function userPromptHook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: ${WORKDIR}\x1b[0m`);
  return null;
}

function stopHook(messages: ModelMessage[]): null {
  const toolCount = messages.reduce(
    (n, m) =>
      n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool-result").length : 0),
    0,
  );
  console.log(`\x1b[90m[HOOK] Stop: ${toolCount} tool result(s)\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", userPromptHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", stopHook);

// ═══════════════════════════════════════════════════════════
//  FROM s06: Subagent Tool
// ═══════════════════════════════════════════════════════════

const SUB_SYSTEM =
  `You are a coding subagent at ${WORKDIR}. ` +
  "Complete the task, then return a concise final summary. " +
  "Do not spawn more agents.";

const SUB_AGENT_TOOLS = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({
      path: z.string(),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
    }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  edit_file: tool({
    description: "Replace exact text in a file once.",
    inputSchema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
  }),
  glob: tool({
    description: "Find files matching a glob pattern.",
    inputSchema: z.object({ pattern: z.string() }),
  }),
};

const SUB_HANDLERS: Record<string, (input: any) => string> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit, offset }) => runRead(path, limit, offset ?? 0),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

async function spawnSubagent(description: string): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: description }];
  let lastText = "";
  for (let round = 0; round < 30; round++) {
    const result = await generateText({
      model,
      system: SUB_SYSTEM,
      messages,
      tools: SUB_AGENT_TOOLS,
      maxOutputTokens: 8000,
    });
    messages.push(...result.response.messages);
    if (result.text) lastText = result.text;
    if (result.finishReason !== "tool-calls") break;

    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      const blocked = await triggerHooks("PreToolUse", call);
      let output: string;
      if (blocked) {
        output = String(blocked);
      } else {
        const handler = SUB_HANDLERS[call.toolName];
        output = handler ? handler(call.input) : `Unknown: ${call.toolName}`;
        await triggerHooks("PostToolUse", call, output);
      }
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }
    messages.push({ role: "tool", content: results });
  }
  return lastText || "Subagent finished without a text summary.";
}

// ═══════════════════════════════════════════════════════════
//  FROM s08: Context Compaction
// ═══════════════════════════════════════════════════════════

// Compaction is layered: first shrink oversized tool results, then trim old
// message ranges, and only call the model for a summary when the context is
// still too large or the model explicitly asks for compact.
const estimateSize = (msgs: ModelMessage[]): number => JSON.stringify(msgs).length;

// Replace an array's contents in place — callers hold the same reference
// (mirrors Python's `messages[:] = ...`).
function setMessages(messages: ModelMessage[], next: ModelMessage[]): void {
  messages.splice(0, messages.length, ...next);
}

const messageHasToolCall = (m: ModelMessage): boolean =>
  m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool-call");

// AI SDK diff: tool results are `role: "tool"` messages, not user messages
// carrying tool_result blocks as in the Anthropic SDK.
const isToolResultMessage = (m: ModelMessage): boolean => m.role === "tool";

const outputText = (part: ToolResultPart): string =>
  part.output.type === "text" ? part.output.value : JSON.stringify(part.output);

function collectToolResults(messages: ModelMessage[]): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) {
      if (part.type === "tool-result") parts.push(part);
    }
  }
  return parts;
}

function persistLargeOutput(toolCallId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolCallId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

function toolResultBudget(messages: ModelMessage[], maxBytes = 200_000): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool") return messages;
  const blocks = last.content.filter((b): b is ToolResultPart => b.type === "tool-result");
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort((a, b) => outputText(b).length - outputText(a).length);
  for (const block of ranked) {
    if (total <= maxBytes) break;
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;
    block.output = { type: "text", value: persistLargeOutput(block.toolCallId, content) };
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }
  return messages;
}

function snipCompact(messages: ModelMessage[], maxMessages = 50): ModelMessage[] {
  if (messages.length <= maxMessages) return messages;
  const keepHead = 3;
  const keepTail = maxMessages - 3;
  let headEnd = keepHead;
  let tailStart = messages.length - keepTail;
  // never split a tool-call/tool-result pair at either boundary
  if (headEnd > 0 && messageHasToolCall(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) headEnd += 1;
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}

function microCompact(messages: ModelMessage[]): ModelMessage[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return messages;
  for (const part of toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    if (part.output.type === "text" && part.output.value.length > 120) {
      part.output = { type: "text", value: "[Earlier tool result compacted. Re-run if needed.]" };
    }
  }
  return messages;
}

function writeTranscript(messages: ModelMessage[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return filePath;
}

async function summarizeHistory(messages: ModelMessage[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue. " +
    "Preserve current goal, key findings, changed files, remaining work, " +
    "and user constraints.\n\n" +
    conversation;
  const { text } = await generateText({ model, prompt, maxOutputTokens: 2000 });
  return text.trim() || "(empty summary)";
}

async function compactHistory(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`  \x1b[36m[compact] transcript saved: ${transcriptPath}\x1b[0m`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

async function reactiveCompact(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`  \x1b[31m[reactive compact] transcript saved: ${transcriptPath}\x1b[0m`);
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  let summary: string;
  try {
    summary = await summarizeHistory(messages.slice(0, tailStart));
  } catch {
    summary = "Earlier conversation was trimmed after a prompt-too-long error.";
  }
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}

// ═══════════════════════════════════════════════════════════
//  FROM s11: Error Recovery
// ═══════════════════════════════════════════════════════════

class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel = PRIMARY_MODEL;
}

// Exponential backoff with jitter (seconds).
function retryDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32_000) / 1000;
  return base + Math.random() * base * 0.25;
}

// AI SDK APICallError carries statusCode; fall back to message text below.
function errorStatus(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "statusCode" in e) {
    const s = (e as { statusCode?: unknown }).statusCode;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * Exponential backoff for transient errors (429/529).
 * Non-transient errors are re-thrown for the outer handler.
 */
async function withRetry<T>(fn: () => Promise<T>, state: RecoveryState): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e) {
      const name = e instanceof Error ? e.name.toLowerCase() : "";
      const msg = errMsg(e).toLowerCase();
      const status = errorStatus(e);

      if (status === 429 || name.includes("ratelimit") || msg.includes("429")) {
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[429] retry ${attempt + 1}/${MAX_RETRIES} after ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay * 1000);
        continue;
      }

      if (status === 529 || name.includes("overloaded") || msg.includes("overloaded") || msg.includes("529")) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529 && FALLBACK_MODEL) {
          state.currentModel = FALLBACK_MODEL;
          state.consecutive529 = 0;
          console.log(`  \x1b[31m[529] switching to ${FALLBACK_MODEL}\x1b[0m`);
        }
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[529] retry ${attempt + 1}/${MAX_RETRIES} after ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay * 1000);
        continue;
      }

      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

function isPromptTooLongError(e: unknown): boolean {
  const msg = errMsg(e).toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window")
  );
}

// ═══════════════════════════════════════════════════════════
//  FROM s13: Background Tasks
// ═══════════════════════════════════════════════════════════

// Slow tools return a placeholder tool_result immediately. Their real output is
// later injected as a task_notification, so the main loop can keep moving.
let bgCounter = 0;
type BgTask = { toolCallId: string; command: string; status: "running" | "completed" };
const backgroundTasks: Record<string, BgTask> = {};
const backgroundResults: Record<string, string> = {};

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

function shouldRunBackground(toolName: string, toolInput: any): boolean {
  if (toolName !== "bash") return false;
  return Boolean(toolInput.run_in_background) || isSlowOperation(toolName, toolInput);
}

function startBackgroundTask(call: { toolName: string; toolCallId: string; input: any }): string {
  bgCounter += 1;
  const bgId = `bg_${String(bgCounter).padStart(4, "0")}`;
  const cmd = String(call.input.command ?? call.toolName);

  backgroundTasks[bgId] = { toolCallId: call.toolCallId, command: cmd, status: "running" };
  void (async () => {
    const result = await runBashAsync(String(call.input.command ?? ""));
    await triggerHooks("PostToolUse", call, result);
    backgroundTasks[bgId].status = "completed";
    backgroundResults[bgId] = result;
  })();

  terminalPrint(`  \x1b[33m[background] ${bgId}: ${cmd.slice(0, 60)}\x1b[0m`);
  return bgId;
}

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
  }
  return notifications;
}

// ═══════════════════════════════════════════════════════════
//  FROM s14: Cron Scheduler
// ═══════════════════════════════════════════════════════════

// Cron jobs are stored separately from conversation history. When a job fires,
// it becomes a scheduled prompt that is injected back into the same agent loop.
const DURABLE_PATH = path.join(WORKDIR, ".scheduled_tasks.json");

type CronJob = {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
};

const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFiredAt = new Map<string, string>(); // job_id → "YYYY-MM-DD HH:MM"

const isDigits = (s: string) => /^\d+$/.test(s);

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
    return Number(field.slice(0, i)) <= value && value <= Number(field.slice(i + 1));
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

  if (!(m && h && monthOk)) return false;
  if (dom === "*" && dow === "*") return true;
  if (dom === "*") return dowOk;
  if (dow === "*") return domOk;
  return domOk || dowOk;
}

function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const stepStr = field.slice(2);
    if (!isDigits(stepStr) || Number(stepStr) <= 0) return `Invalid step: ${field}`;
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
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!isDigits(field)) return `Invalid field: ${field}`;
  const val = Number(field);
  if (val < lo || val > hi) return `Value ${val} out of bounds [${lo}-${hi}]`;
  return null;
}

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

function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2));
}

function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    for (const job of JSON.parse(fs.readFileSync(DURABLE_PATH, "utf8")) as CronJob[]) {
      if (!validateCron(job.cron)) {
        scheduledJobs.set(job.id, job);
      }
    }
  } catch {
    // corrupted durable file: start empty
  }
}

function scheduleJob(cron: string, prompt: string, recurring = true, durable = true): CronJob | string {
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
  return job;
}

function cancelJob(jobId: string): string {
  const job = scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;
  scheduledJobs.delete(jobId);
  if (job.durable) saveDurableJobs();
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
    const minuteMarker =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    for (const job of [...scheduledJobs.values()]) {
      try {
        if (cronMatches(job.cron, now) && lastFiredAt.get(job.id) !== minuteMarker) {
          cronQueue.push(job);
          lastFiredAt.set(job.id, minuteMarker);
          if (!job.recurring) {
            scheduledJobs.delete(job.id);
            if (job.durable) saveDurableJobs();
          }
        }
      } catch (e) {
        terminalPrint(`  \x1b[31m[cron error] ${job.id}: ${errMsg(e)}\x1b[0m`);
      }
    }
  }, 1000).unref();
}

function consumeCronQueue(): CronJob[] {
  const fired = [...cronQueue];
  cronQueue.length = 0;
  return fired;
}

function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

function runScheduleCron(cron: string, prompt: string, recurring = true, durable = true): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") {
    return `Error: ${result}`;
  }
  return `Scheduled ${result.id}: '${cron}' -> ${prompt}`;
}

function runListCrons(): string {
  const jobs = [...scheduledJobs.values()];
  if (!jobs.length) return "No cron jobs.";
  return jobs
    .map(
      (j) =>
        `  ${j.id}: '${j.cron}' -> ${j.prompt.slice(0, 40)} ` +
        `[${j.recurring ? "recurring" : "one-shot"}, ${j.durable ? "durable" : "session"}]`,
    )
    .join("\n");
}

function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

loadDurableJobs();
startCronScheduler();

// ═══════════════════════════════════════════════════════════
//  FROM s19: MCP System
// ═══════════════════════════════════════════════════════════

// MCP is modeled as late-bound tools: connect first, then discovered server
// tools are merged into the normal tool pool with mcp__server__tool names.
type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
};

/** Discovers and calls tools on an MCP server (mock for teaching). */
class MCPClient {
  name: string;
  tools: McpToolDef[] = [];
  private handlers: Record<string, (...args: any[]) => string> = {};

  constructor(name: string) {
    this.name = name;
  }

  register(toolDefs: McpToolDef[], handlers: Record<string, (...args: any[]) => string>): void {
    this.tools = toolDefs;
    this.handlers = handlers;
  }

  callTool(toolName: string, args: Record<string, any>): string {
    const handler = this.handlers[toolName];
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try {
      return handler(args);
    } catch (e) {
      return `MCP error: ${errMsg(e)}`;
    }
  }
}

const mcpClients: Record<string, MCPClient> = {};

const DISALLOWED_CHARS = /[^a-zA-Z0-9_-]/g;

// Replace non [a-zA-Z0-9_-] with underscore.
function normalizeMcpName(name: string): string {
  return name.replace(DISALLOWED_CHARS, "_");
}

function mockServerDocs(): MCPClient {
  const client = new MCPClient("docs");
  client.register(
    [
      {
        name: "search",
        description: "Search documentation. (readOnly)",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "get_version",
        description: "Get API version. (readOnly)",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    {
      search: ({ query }: { query: string }) => `[docs] Found 3 results for '${query}'`,
      get_version: () => "[docs] API v2.1.0",
    },
  );
  return client;
}

function mockServerDeploy(): MCPClient {
  const client = new MCPClient("deploy");
  client.register(
    [
      {
        name: "trigger",
        description: "Trigger a deployment. (destructive — requires approval in real CC)",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
      },
      {
        name: "status",
        description: "Check deployment status. (readOnly)",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
      },
    ],
    {
      trigger: ({ service }: { service: string }) => `[deploy] Triggered: ${service}`,
      status: ({ service }: { service: string }) => `[deploy] ${service}: running (v1.4.2)`,
    },
  );
  return client;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = {
  docs: mockServerDocs,
  deploy: mockServerDeploy,
};

function connectMcp(name: string): string {
  if (mcpClients[name]) return `MCP server '${name}' already connected`;
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    return `Unknown server '${name}'. Available: ${Object.keys(MOCK_SERVERS).join(", ")}`;
  }
  const client = factory();
  mcpClients[name] = client;
  const toolNames = client.tools.map((t) => t.name);
  terminalPrint(`  \x1b[31m[mcp] connected: ${name} → [${toolNames.join(", ")}]\x1b[0m`);
  return (
    `Connected to MCP server '${name}'. ` +
    `Discovered ${client.tools.length} tools: ${toolNames.join(", ")}`
  );
}

// Best-effort JSON Schema -> Zod conversion, enough for the mock servers.
function jsonSchemaToZod(schema: Record<string, any>): z.ZodTypeAny {
  const props = schema.properties ?? {};
  const required: string[] = schema.required ?? [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props) as [string, any][]) {
    let field: z.ZodTypeAny;
    switch (propSchema.type) {
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.any());
        break;
      case "object":
        field = z.record(z.string(), z.any());
        break;
      default:
        field = z.string();
    }
    shape[key] = required.includes(key) ? field : field.optional();
  }
  return z.object(shape);
}

type ToolHandler = (input: any) => string | Promise<string>;

/** Merge builtin tools + all MCP tools into one pool. */
function assembleToolPool(): { tools: ToolSet; handlers: Record<string, ToolHandler> } {
  const assembled: ToolSet = { ...BUILTIN_TOOLS };
  const handlers: Record<string, ToolHandler> = { ...BUILTIN_HANDLERS };
  for (const [serverName, mcpClient] of Object.entries(mcpClients)) {
    const safeServer = normalizeMcpName(serverName);
    for (const toolDef of mcpClient.tools) {
      const safeTool = normalizeMcpName(toolDef.name);
      const prefixed = `mcp__${safeServer}__${safeTool}`;
      assembled[prefixed] = tool({
        description: toolDef.description ?? "",
        inputSchema: jsonSchemaToZod(toolDef.inputSchema ?? {}),
      });
      handlers[prefixed] = (input: any) => mcpClient.callTool(toolDef.name, input);
    }
  }
  return { tools: assembled, handlers };
}

// ── Lead Worktree Tools ──

function runCreateWorktree(name: string, taskId = ""): string {
  return createWorktree(name, taskId);
}

function runRemoveWorktree(name: string, discardChanges = false): string {
  return removeWorktree(name, discardChanges);
}

function runKeepWorktree(name: string): string {
  return keepWorktree(name);
}

// ── Basic tool handlers ──

function runCreateTask(subject: string, description = "", blockedBy?: string[]): string {
  const task = createTask(subject, description, blockedBy ?? []);
  const deps = blockedBy?.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  terminalPrint(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (!tasks.length) return "No tasks.";
  return tasks
    .map(
      (t) => `  ${t.id}: ${t.subject} [${t.status}]` + (t.worktree ? ` (wt:${t.worktree})` : ""),
    )
    .join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTaskJson(taskId);
  } catch {
    return `Error: task ${taskId} not found`;
  }
}

function runClaimTask(taskId: string): string {
  try {
    return claimTask(taskId, "agent");
  } catch {
    return `Error: task ${taskId} not found`;
  }
}

function runCompleteTask(taskId: string): string {
  try {
    return completeTask(taskId);
  } catch {
    return `Error: task ${taskId} not found`;
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

function runConnectMcp(name: string): string {
  return connectMcp(name);
}

// ── Tool definitions ──

// The model sees tool schemas; TS executes handlers. S20 keeps both tables
// explicit so every added capability is visible in one place.
const BUILTIN_TOOLS: ToolSet = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
    }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({
      path: z.string(),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
    }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  edit_file: tool({
    description: "Replace exact text in a file once.",
    inputSchema: z.object({
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
    }),
  }),
  glob: tool({
    description: "Find files matching a glob pattern.",
    inputSchema: z.object({ pattern: z.string() }),
  }),
  todo_write: tool({
    description: "Create and manage a task list for the current session.",
    inputSchema: z.object({ todos: z.array(todoItem) }),
  }),
  task: tool({
    description: "Launch a focused subagent. Returns only its final summary.",
    inputSchema: z.object({ description: z.string() }),
  }),
  load_skill: tool({
    description: "Load the full content of a skill by name.",
    inputSchema: z.object({ name: z.string() }),
  }),
  compact: tool({
    description: "Summarize earlier conversation and continue with compacted context.",
    inputSchema: z.object({ focus: z.string().optional() }),
  }),
  create_task: tool({
    description: "Create a task.",
    inputSchema: z.object({
      subject: z.string(),
      description: z.string().optional(),
      blockedBy: z.array(z.string()).optional(),
    }),
  }),
  list_tasks: tool({
    description: "List all tasks.",
    inputSchema: z.object({}),
  }),
  get_task: tool({
    description: "Get full task details.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
  claim_task: tool({
    description: "Claim a pending task.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
  complete_task: tool({
    description: "Complete an in-progress task.",
    inputSchema: z.object({ task_id: z.string() }),
  }),
  schedule_cron: tool({
    description:
      "Schedule a cron job. cron is 5-field: min hour dom month dow. " +
      "For one-shot reminders, compute the target minute and set recurring=false.",
    inputSchema: z.object({
      cron: z.string(),
      prompt: z.string(),
      recurring: z.boolean().optional(),
      durable: z.boolean().optional(),
    }),
  }),
  list_crons: tool({
    description: "List registered cron jobs.",
    inputSchema: z.object({}),
  }),
  cancel_cron: tool({
    description: "Cancel a cron job by ID.",
    inputSchema: z.object({ job_id: z.string() }),
  }),
  spawn_teammate: tool({
    description: "Spawn an autonomous teammate.",
    inputSchema: z.object({
      name: z.string(),
      role: z.string(),
      prompt: z.string(),
    }),
  }),
  send_message: tool({
    description: "Send message to a teammate.",
    inputSchema: z.object({ to: z.string(), content: z.string() }),
  }),
  check_inbox: tool({
    description: "Check inbox for messages and protocol responses.",
    inputSchema: z.object({}),
  }),
  request_shutdown: tool({
    description: "Request a teammate to shut down.",
    inputSchema: z.object({ teammate: z.string() }),
  }),
  request_plan: tool({
    description: "Ask a teammate to submit a plan.",
    inputSchema: z.object({ teammate: z.string(), task: z.string() }),
  }),
  review_plan: tool({
    description: "Approve or reject a submitted plan.",
    inputSchema: z.object({
      request_id: z.string(),
      approve: z.boolean(),
      feedback: z.string().optional(),
    }),
  }),
  create_worktree: tool({
    description: "Create an isolated git worktree.",
    inputSchema: z.object({ name: z.string(), task_id: z.string().optional() }),
  }),
  remove_worktree: tool({
    description: "Remove a worktree. Refuses if changes exist.",
    inputSchema: z.object({ name: z.string(), discard_changes: z.boolean().optional() }),
  }),
  keep_worktree: tool({
    description: "Keep a worktree for manual review.",
    inputSchema: z.object({ name: z.string() }),
  }),
  connect_mcp: tool({
    description: "Connect to an MCP server (docs, deploy) and discover tools.",
    inputSchema: z.object({ name: z.string() }),
  }),
};

const BUILTIN_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit, offset }) => runRead(path, limit, offset ?? 0),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
  todo_write: ({ todos }) => runTodoWrite(todos),
  task: ({ description }) => spawnSubagent(description),
  load_skill: ({ name }) => loadSkill(name),
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
  spawn_teammate: ({ name, role, prompt }) => runSpawnTeammate(name, role, prompt),
  send_message: ({ to, content }) => runSendMessage(to, content),
  check_inbox: () => runCheckInbox(),
  request_shutdown: ({ teammate }) => runRequestShutdown(teammate),
  request_plan: ({ teammate, task }) => runRequestPlan(teammate, task),
  review_plan: ({ request_id, approve, feedback }) =>
    runReviewPlan(request_id, approve, feedback ?? ""),
  create_worktree: ({ name, task_id }) => runCreateWorktree(name, task_id ?? ""),
  remove_worktree: ({ name, discard_changes }) =>
    runRemoveWorktree(name, discard_changes ?? false),
  keep_worktree: ({ name }) => runKeepWorktree(name),
  connect_mcp: ({ name }) => runConnectMcp(name),
};

// ── Context ──

function updateContext(): Context {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf8").slice(0, 2000);
  }
  return {
    memories,
    connectedMcp: Object.keys(mcpClients),
    activeTeammates: [...activeTeammates],
  };
}

// ═══════════════════════════════════════════════════════════
//  Agent Loop
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

// Every LLM turn enters through the same context budget pipeline.
async function prepareContext(messages: ModelMessage[]): Promise<void> {
  setMessages(messages, toolResultBudget(messages));
  setMessages(messages, snipCompact(messages));
  setMessages(messages, microCompact(messages));
  if (estimateSize(messages) > CONTEXT_LIMIT) {
    setMessages(messages, await compactHistory(messages));
  }
}

// Completed background notifications return to the model as user-side
// content, matching the tool_result feedback loop (separate user message —
// the AI SDK keeps tool results in role:"tool" messages).
function injectBackgroundNotifications(messages: ModelMessage[]): void {
  const notes = collectBackgroundResults();
  if (notes.length) {
    messages.push({ role: "user", content: notes.join("\n") });
  }
}

function callLLM(
  messages: ModelMessage[],
  context: Context,
  tools: ToolSet,
  state: RecoveryState,
  maxTokens: number,
) {
  const system = assembleSystemPrompt(context);
  return withRetry(
    () =>
      generateText({
        model: anthropic(state.currentModel),
        system,
        messages,
        tools,
        maxOutputTokens: maxTokens,
        maxRetries: 0, // withRetry above owns backoff, not the SDK
      }),
    state,
  );
}

async function agentLoop(messages: ModelMessage[], context: Context): Promise<string> {
  let { tools, handlers } = assembleToolPool();
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;
  let lastText = "";

  while (true) {
    // One cycle: inject scheduled/background work, prepare context, call
    // the model, execute tool calls, append tool results, repeat.
    const fired = consumeCronQueue();
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      terminalPrint(`  \x1b[35m[cron inject] ${job.prompt.slice(0, 60)}\x1b[0m`);
    }

    injectBackgroundNotifications(messages);

    if (roundsSinceTodo >= 3) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    await prepareContext(messages);
    context = updateContext();
    ({ tools, handlers } = assembleToolPool());

    let result;
    try {
      result = await callLLM(messages, context, tools, state, maxTokens);
    } catch (e) {
      if (isPromptTooLongError(e) && !state.hasAttemptedReactiveCompact) {
        setMessages(messages, await reactiveCompact(messages));
        state.hasAttemptedReactiveCompact = true;
        continue;
      }
      const errText = `[Error] ${e instanceof Error ? e.name : "Error"}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }

    // max_tokens (finishReason "length") -> escalate, then continuation
    if (result.finishReason === "length") {
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(`  \x1b[33m[max_tokens] retry with ${maxTokens}\x1b[0m`);
        continue;
      }
      messages.push(...result.response.messages);
      if (result.text) lastText = result.text;
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount += 1;
        continue;
      }
      return lastText;
    }

    maxTokens = DEFAULT_MAX_TOKENS;
    state.hasEscalated = false;
    messages.push(...result.response.messages);
    if (result.text) lastText = result.text;
    if (result.finishReason !== "tool-calls") {
      await triggerHooks("Stop", messages);
      return result.text;
    }

    const results: ToolResultPart[] = [];
    let compactedNow = false;
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);

      if (call.toolName === "compact") {
        // compactHistory replaces the whole message list, so the pending
        // tool call disappears with it — no orphan tool_result needed.
        setMessages(messages, await compactHistory(messages));
        messages.push({ role: "user", content: "[Compacted. Continue with summarized context.]" });
        compactedNow = true;
        break;
      }

      const blocked = await triggerHooks("PreToolUse", call);
      if (blocked) {
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: String(blocked) },
        });
        continue;
      }

      if (shouldRunBackground(call.toolName, call.input)) {
        const bgId = startBackgroundTask(call);
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "text",
            value: `[Background task ${bgId} started] Result will arrive as a task_notification.`,
          },
        });
        continue;
      }

      const handler = handlers[call.toolName];
      const output = handler ? await handler(call.input) : `Unknown: ${call.toolName}`;
      await triggerHooks("PostToolUse", call, output);
      console.log(String(output).slice(0, 300));

      if (call.toolName === "todo_write") {
        roundsSinceTodo = 0;
      } else {
        roundsSinceTodo += 1;
      }

      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }

    if (compactedNow) continue;

    messages.push({ role: "tool", content: results });
    injectBackgroundNotifications(messages);
  }
}

// ── Session state + agent lock ──────────────────────────

const history: ModelMessage[] = [];
let context = updateContext();

// Single-threaded analog of Python's agent_lock: the queue processor skips
// when held (acquire(blocking=False)); user input waits for it.
let agentBusy = false;

// Run one agent turn. Caller must hold the agent lock (agentBusy === true).
async function runAgentTurnLocked(userQuery?: string): Promise<void> {
  if (userQuery !== undefined) {
    history.push({ role: "user", content: userQuery });
  }
  const finalText = await agentLoop(history, context);
  context = updateContext();
  terminalPrint(finalText);
}

// Auto-deliver fired cron jobs when the agent is idle (Python:
// cron_autorun_loop daemon thread; agentLoop consumes the queue itself).
function startQueueProcessor(): void {
  setInterval(async () => {
    if (!hasCronQueue() || agentBusy) return;
    agentBusy = true;
    try {
      if (!hasCronQueue()) return;
      terminalPrint("  \x1b[35m[cron auto] delivering scheduled work\x1b[0m");
      await runAgentTurnLocked();
    } finally {
      agentBusy = false;
    }
  }, 1000).unref();
}

// ── Entry point ──────────────────────────────────────────
console.log("s20: comprehensive agent");
console.log("输入问题，回车发送。输入 q 退出。\n");

CLI_ACTIVE = true;
startQueueProcessor();

while (true) {
  let query: string;
  try {
    query = await rl.question(PROMPT);
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  await triggerHooks("UserPromptSubmit", query);

  // Blocking acquire: wait until the queue processor finishes its turn
  while (agentBusy) await sleep(100);
  agentBusy = true;
  try {
    await runAgentTurnLocked(query);
  } finally {
    agentBusy = false;
  }

  const inbox = consumeLeadInbox(true);
  if (inbox.length) {
    const inboxLabel = (m: BusMessage) => {
      const reqId = String(m.metadata?.request_id ?? "");
      return reqId ? `${m.type} req:${reqId}` : m.type || "message";
    };
    const inboxText = inbox
      .map((m) => `From ${m.from} [${inboxLabel(m)}]: ${m.content.slice(0, 200)}`)
      .join("\n");
    history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
  }
  console.log();
}
rl.close();

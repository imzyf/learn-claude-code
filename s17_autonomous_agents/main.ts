/**
 * s17_autonomous_agents/main.ts - 自治 Agent
 *
 * 空闲轮询 + 自动认领 + WORK/IDLE 生命周期。
 *
 * 相比 s16 的变化：
 *   + scanUnclaimedTasks：查找依赖已完成、待处理且无人认领的任务
 *   + idlePoll：60 秒轮询循环（收件箱 + 任务看板），IDLE 状态下分发关机
 *   + claimTask：owner 校验 + 依赖缺失提示
 *   + 队友生命周期：WORK → IDLE → SHUTDOWN
 *   + 队友工具：新增 list_tasks、claim_task、complete_task（5→8 个）
 *   + 队友历史记录仍然很短时重新注入身份信息
 *   - 后台任务被移除（上游 s17 简化了 agent 循环）
 *
 * ASCII 生命周期：
 *   WORK: inbox → LLM → tools → (tool-calls? loop) → (done? → IDLE)
 *   IDLE: 5s poll → inbox? → WORK / unclaimed? → claim → WORK / 60s? → SHUTDOWN
 *
 * TS 特有说明：
 *   - 队友是游离的异步循环；idlePoll 使用 `await sleep(5s)`
 *   - WORK 阶段每个周期最多 10 轮 LLM 调用，和 Python 版本一致
 *
 * Usage:
 *     pnpm dev s17_autonomous_agents/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { client, MODEL_ID } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

function getTask(taskId: string): string {
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

// s17: owner check added — an owned pending task cannot be re-claimed.
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
    .filter((t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map((t) => t.subject);
  console.log(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
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
    "spawn_teammate, send_message, check_inbox, " +
    "request_shutdown, request_plan, review_plan.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

type Context = { memories: string };

function assembleSystemPrompt(context: Context): string {
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
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
//  FROM s15 (synced): Basic tools
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
    fs.appendFileSync(path.join(MAILBOX_DIR, `${toAgent}.jsonl`), JSON.stringify(msg) + "\n");
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

// Correlate a response to the original request via request_id.
function matchResponse(responseType: string, requestId: string, approve: boolean): void {
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
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") {
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

// Read Lead inbox: route protocol responses, return all messages.
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
//  NEW in s17: Autonomous Agent
// ═══════════════════════════════════════════════════════════

const IDLE_POLL_INTERVAL = 5; // seconds
const IDLE_TIMEOUT = 60; // seconds

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

    // Check inbox — dispatch protocol messages first
    const inbox = BUS.readInbox(name);
    if (inbox.length) {
      // Check for shutdown_request
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = String(msg.metadata?.request_id ?? "");
          BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
            request_id: reqId,
            approve: true,
          });
          console.log(`  \x1b[35m[protocol] ${name} approved shutdown in idle (${reqId})\x1b[0m`);
          return "shutdown";
        }
      }

      // Non-protocol inbox: inject and resume work
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      console.log(`  \x1b[36m[idle] ${name} found inbox messages\x1b[0m`);
      return "work";
    }

    // Scan task board
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length) {
      const task = unclaimed[0];
      const result = claimTask(task.id, name);
      if (result.includes("Claimed")) {
        messages.push({
          role: "user",
          content: `<auto-claimed>Task ${task.id}: ${task.subject}</auto-claimed>`,
        });
        console.log(`  \x1b[32m[idle] ${name} auto-claimed: ${task.subject}\x1b[0m`);
        return "work";
      }
      console.log(`  \x1b[33m[idle] ${name} claim failed: ${result}\x1b[0m`);
    }
  }

  console.log(`  \x1b[31m[idle] ${name} timeout (${IDLE_TIMEOUT}s)\x1b[0m`);
  return "timeout";
}

// ═══════════════════════════════════════════════════════════
//  Teammate (s15 + s16 + s17)
// ═══════════════════════════════════════════════════════════

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) {
    return `Teammate '${name}' already exists`;
  }

  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `You can list and claim tasks from the board. ` +
    `Check inbox for protocol messages.`;

  // Dispatch incoming protocol messages by type. Returns true to stop.
  const handleInboxMessage = (msg: BusMessage, messages: Anthropic.MessageParam[]): boolean => {
    const reqId = String(msg.metadata?.request_id ?? "");

    if (msg.type === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
        request_id: reqId,
        approve: true,
      });
      console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`);
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

  const subBashSchema = z.object({ command: z.string() });
  const subReadSchema = z.object({ path: z.string() });
  const subWriteSchema = z.object({ path: z.string(), content: z.string() });
  const subSendMessageSchema = z.object({ to: z.string(), content: z.string() });
  const subSubmitPlanSchema = z.object({ plan: z.string() });
  const subListTasksSchema = z.object({});
  const subClaimTaskSchema = z.object({ task_id: z.string() });
  const subCompleteTaskSchema = z.object({ task_id: z.string() });

  const subTools: Anthropic.Tool[] = [
    zodTool("bash", "Run a shell command.", subBashSchema),
    zodTool("read_file", "Read file contents.", subReadSchema),
    zodTool("write_file", "Write content to a file.", subWriteSchema),
    zodTool("send_message", "Send a message to another agent.", subSendMessageSchema),
    zodTool("submit_plan", "Submit a plan for Lead approval.", subSubmitPlanSchema),
    // s17 new: teammates can list, claim, and complete tasks
    zodTool("list_tasks", "List all tasks on the board.", subListTasksSchema),
    zodTool("claim_task", "Claim a pending task.", subClaimTaskSchema),
    zodTool("complete_task", "Mark an in-progress task as completed.", subCompleteTaskSchema),
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

  const subListTasks = () => {
    const tasks = listTasks();
    if (!tasks.length) return "No tasks.";
    return tasks.map((t) => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n");
  };

  const subHandlers: Partial<Record<string, (input: any) => string>> = {
    bash: ({ command }) => runBash(command),
    read_file: ({ path }) => runRead(path),
    write_file: ({ path, content }) => runWrite(path, content),
    send_message: ({ to, content }) => {
      BUS.send(name, to, content);
      return "Sent";
    },
    submit_plan: ({ plan }) => teammateSubmitPlan(name, plan),
    list_tasks: () => subListTasks(),
    claim_task: ({ task_id }) => claimTask(task_id, name),
    complete_task: ({ task_id }) => completeTask(task_id),
  };

  const run = async () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    let lastText = "";
    let shouldShutdown = false;

    // Outer loop: WORK → IDLE cycle
    while (true) {
      // Identity re-injection (s17): after context loss the teammate is
      // reminded who it is
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

        let response;
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
          const output = handler && schema ? handler(schema.parse(block.input)) : "Unknown";
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
        messages.push({ role: "user", content: results });
      }

      if (shouldShutdown) break;

      // IDLE phase (s17 new)
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

// Teammate submits a plan to Lead for approval.
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
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  console.log(`  \x1b[35m[protocol] shutdown_request → ${teammate} (${reqId})\x1b[0m`);
  return `Shutdown request sent to ${teammate} (req: ${reqId})`;
}

// Lead asks a teammate to submit a plan.
function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Please submit a plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback = ""): string {
  const state = pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
    "plan_approval_response", { request_id: requestId, approve });
  const icon = approve ? "✓" : "✗";
  console.log(`  \x1b[32m[protocol] plan ${icon} (${requestId})\x1b[0m`);
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

// ── Basic tool handlers ──

function runCreateTask(subject: string, description = "", blockedBy?: string[]): string {
  const task = createTask(subject, description, blockedBy ?? []);
  const deps = blockedBy?.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (!tasks.length) return "No tasks.";
  return tasks.map((t) => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTask(taskId);
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
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
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

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("create_task", "Create a task.", createTaskSchema),
  zodTool("list_tasks", "List all tasks.", listTasksSchema),
  zodTool("get_task", "Get full details of a specific task.", getTaskSchema),
  zodTool("claim_task", "Claim a pending task.", claimTaskSchema),
  zodTool("complete_task", "Complete an in-progress task.", completeTaskSchema),
  zodTool("spawn_teammate", "Spawn an autonomous teammate agent.", spawnTeammateSchema),
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
  zodTool("request_plan", "Ask a teammate to submit a plan for review.", requestPlanSchema),
  zodTool("review_plan", "Approve or reject a submitted plan.", reviewPlanSchema),
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
};

const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  create_task: ({ subject, description, blockedBy }) =>
    runCreateTask(subject, description ?? "", blockedBy),
  list_tasks: () => runListTasks(),
  get_task: ({ task_id }) => runGetTask(task_id),
  claim_task: ({ task_id }) => claimTask(task_id, "agent"),
  complete_task: ({ task_id }) => completeTask(task_id),
  spawn_teammate: ({ name, role, prompt }) => runSpawnTeammate(name, role, prompt),
  send_message: ({ to, content }) => runSendMessage(to, content),
  check_inbox: () => runCheckInbox(),
  request_shutdown: ({ teammate }) => runRequestShutdown(teammate),
  request_plan: ({ teammate, task }) => runRequestPlan(teammate, task),
  review_plan: ({ request_id, approve, feedback }) =>
    runReviewPlan(request_id, approve, feedback ?? ""),
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

async function agentLoop(messages: Anthropic.MessageParam[], context: Context): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
    let response;
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
      const output = handler && schema ? handler(schema.parse(block.input)) : "Unknown";
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
console.log("s17: autonomous agents");
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
    query = await rl.question("\x1b[36ms17 >> \x1b[0m");
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
      .map((m) => `From ${m.from} [${m.type || "message"}]: ${m.content.slice(0, 200)}`)
      .join("\n");
    history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
  }
  console.log();
}
rl.close();

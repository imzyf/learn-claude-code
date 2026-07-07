/**
 * s16_team_protocols/main.ts - Team Protocols
 *
 * Request-response protocol + request_id + dispatch + state machine.
 *
 * Changes from s15:
 *   + ProtocolState (request_id, type, sender, target, status, payload)
 *   + pendingRequests: tracks in-flight protocol requests
 *   + handleInboxMessage: teammate routes incoming messages by type
 *   + matchResponse: Lead correlates response via request_id (+ type check)
 *   + Teammate idle loop: waits for inbox messages instead of exiting
 *   + consumeLeadInbox: unified protocol routing + injection into history
 *   + 3 new Lead tools: request_shutdown, request_plan, review_plan
 *   + 1 new teammate tool: submit_plan
 *   - s15's cron scheduler and event-queue wake are gone (upstream s16 drops
 *     them; the Lead inbox is consumed at turn boundaries like the Python REPL)
 *
 * ASCII flow:
 *   Lead: BUS.send("shutdown_request", {request_id}) ──────→ teammate inbox
 *   Teammate: dispatch → handler → BUS.send("shutdown_response", {request_id}) ─→ Lead inbox
 *   Lead: consumeLeadInbox → matchResponse(request_id) → pendingRequests[reqId].status = approved
 *
 * TS-specific notes:
 *   - Teammates are detached async loops (not daemon threads); the idle wait
 *     is `await sleep(1s)` so the event loop stays free
 *   - Idle resumes on any injected inbox message (Python resumed only on
 *     non-protocol messages, so plan approvals left the teammate idling)
 *   - Background notifications get their own user message; the AI SDK keeps
 *     tool results in role:"tool" messages (see s13 note)
 *
 * Usage:
 *     pnpm dev s16_team_protocols/main.ts
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
    "get_task, create_task, list_tasks, claim_task, complete_task, " +
    "spawn_teammate, send_message, check_inbox, " +
    "request_shutdown, request_plan, review_plan.",
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

// ═══════════════════════════════════════════════════════════
//  FROM s13 (synced): Background Tasks
// ═══════════════════════════════════════════════════════════

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

// Run tool in a detached async worker. Returns background task ID.
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

// ═══════════════════════════════════════════════════════════
//  FROM s15: MessageBus (+ metadata field for protocols)
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

/**
 * File-based message bus. Each agent has a .jsonl inbox.
 * Read is destructive: readFile + unlink (consumes messages).
 * Teaching version: no file locking; real CC uses proper-lockfile.
 */
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
    fs.unlinkSync(inbox); // consume: read + delete
    return msgs;
  }
}

const BUS = new MessageBus();
const activeTeammates = new Set<string>();

// ═══════════════════════════════════════════════════════════
//  NEW in s16: Protocol State
// ═══════════════════════════════════════════════════════════

type ProtocolState = {
  requestId: string;
  type: string; // "shutdown" | "plan_approval"
  sender: string;
  target: string;
  status: string; // pending | approved | rejected
  payload: string; // plan text or shutdown reason
  createdAt: number;
};

const pendingRequests = new Map<string, ProtocolState>();

const newRequestId = () =>
  `req_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;

/**
 * Correlate a response to the original request via request_id.
 * Validates that response_type matches the request type.
 */
function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  // Validate response type matches request type
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
  if (state.status !== "pending") {
    console.log(
      `  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`,
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

// ═══════════════════════════════════════════════════════════
//  NEW in s16: Unified Lead Inbox Consumer
// ═══════════════════════════════════════════════════════════
// Both the check_inbox tool and the main loop call this function.
// Protocol responses are routed via matchResponse before returning.

function consumeLeadInbox(routeProtocol = true): BusMessage[] {
  const msgs = BUS.readInbox("lead");
  if (!msgs.length) return [];
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
//  NEW in s16: Teammate (idle loop + dispatch)
// ═══════════════════════════════════════════════════════════

/**
 * Spawn a teammate agent as a detached async loop.
 * Uses idle loop: after each LLM turn, waits for inbox messages
 * (shutdown_request, new task) instead of exiting.
 */
function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) {
    return `Teammate '${name}' already exists`;
  }

  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `Check inbox for protocol messages (shutdown_request, etc).`;

  // Dispatch incoming protocol messages by type.
  // Returns true if the teammate should stop.
  const handleInboxMessage = (msg: BusMessage, messages: ModelMessage[]): boolean => {
    const reqId = String(msg.metadata?.request_id ?? "");

    if (msg.type === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down gracefully.", "shutdown_response", {
        request_id: reqId,
        approve: true,
      });
      console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`);
      return true; // stop the loop
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

    return false; // continue
  };

  const subTools = {
    bash: tool({
      description: "Run a shell command.",
      inputSchema: z.object({ command: z.string() }),
    }),
    read_file: tool({
      description: "Read file contents.",
      inputSchema: z.object({ path: z.string() }),
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
  };
  const subHandlers: Record<string, (input: any) => string> = {
    bash: ({ command }) => runBash(command),
    read_file: ({ path }) => runRead(path),
    write_file: ({ path, content }) => runWrite(path, content),
    send_message: ({ to, content }) => {
      BUS.send(name, to, content);
      return "Sent";
    },
    submit_plan: ({ plan }) => teammateSubmitPlan(name, plan),
  };

  const run = async () => {
    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
    let lastText = "";
    let shutdownRequested = false;

    outer: while (!shutdownRequested) {
      // Check inbox for protocol messages
      const inbox = BUS.readInbox(name);
      const nonProtocol: BusMessage[] = [];
      for (const msg of inbox) {
        if (msg.type === "shutdown_request" || msg.type === "plan_approval_response") {
          if (handleInboxMessage(msg, messages)) {
            shutdownRequested = true;
            break outer;
          }
        } else {
          nonProtocol.push(msg);
        }
      }
      if (nonProtocol.length) {
        messages.push({ role: "user", content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` });
      }

      // LLM turn
      let result;
      try {
        result = await generateText({
          model,
          system,
          // Tail window mirrors Python's messages[-20:] (teaching shortcut)
          messages: messages.slice(-20),
          tools: subTools,
          maxOutputTokens: 8000,
        });
      } catch {
        break;
      }
      messages.push(...result.response.messages);
      if (result.text) lastText = result.text;

      if (result.finishReason !== "tool-calls") {
        // Idle: wait for inbox messages instead of exiting.
        // Real CC sends idle_notification to Lead here.
        let resumed = false;
        while (!shutdownRequested && !resumed) {
          await sleep(1000);
          const idleInbox = BUS.readInbox(name);
          if (!idleInbox.length) continue;
          const idleNonProtocol: BusMessage[] = [];
          for (const msg of idleInbox) {
            if (msg.type === "shutdown_request" || msg.type === "plan_approval_response") {
              if (handleInboxMessage(msg, messages)) {
                shutdownRequested = true;
                break;
              }
              resumed = true; // protocol injected a message — back to LLM turn
            } else {
              idleNonProtocol.push(msg);
            }
          }
          if (shutdownRequested) break;
          if (idleNonProtocol.length) {
            messages.push({
              role: "user",
              content: `<inbox>${JSON.stringify(idleNonProtocol)}</inbox>`,
            });
            resumed = true; // back to LLM turn with new messages
          }
        }
        continue; // no tool calls to execute for this response
      }

      // Execute tool calls
      const results: ToolResultPart[] = [];
      for (const call of result.toolCalls) {
        if (call.dynamic) continue;
        const handler = subHandlers[call.toolName];
        const output = handler ? handler(call.input) : "Unknown";
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: output },
        });
      }
      messages.push({ role: "tool", content: results });
    }

    // Send final summary to Lead
    BUS.send(name, "lead", lastText || "Done.", "result");
    activeTeammates.delete(name);
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`);
  };

  activeTeammates.add(name);
  void run(); // detached — runs concurrently with the Lead's loop
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role}`;
}

/**
 * Teammate submits a plan to Lead for approval.
 *
 * Note: This is a protocol-level request, not a code-level gate.
 * After submitting, the teammate's loop keeps running — it can still call
 * bash/write/etc. Real enforcement relies on the model waiting for the
 * approval response before acting (s20 adds the code-level gate).
 */
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
//  NEW in s16: Lead Protocol Tools
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

// Lead asks a teammate to submit a plan for a task.
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

// ── Other Lead tool handlers ──

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

// Check Lead's inbox. Routes protocol responses via matchResponse.
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
  spawn_teammate: tool({
    description: "Spawn a teammate agent in the background.",
    inputSchema: z.object({
      name: z.string(),
      role: z.string(),
      prompt: z.string(),
    }),
  }),
  send_message: tool({
    description: "Send message to a teammate via MessageBus.",
    inputSchema: z.object({ to: z.string(), content: z.string() }),
  }),
  check_inbox: tool({
    description: "Check Lead's inbox. Routes protocol responses automatically.",
    inputSchema: z.object({}),
  }),
  request_shutdown: tool({
    description: "Request a teammate to shut down gracefully.",
    inputSchema: z.object({ teammate: z.string() }),
  }),
  request_plan: tool({
    description: "Ask a teammate to submit a plan for review.",
    inputSchema: z.object({ teammate: z.string(), task: z.string() }),
  }),
  review_plan: tool({
    description: "Approve or reject a submitted plan by request_id.",
    inputSchema: z.object({
      request_id: z.string(),
      approve: z.boolean(),
      feedback: z.string().optional(),
    }),
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
  spawn_teammate: ({ name, role, prompt }) => runSpawnTeammate(name, role, prompt),
  send_message: ({ to, content }) => runSendMessage(to, content),
  check_inbox: () => runCheckInbox(),
  request_shutdown: ({ teammate }) => runRequestShutdown(teammate),
  request_plan: ({ teammate, task }) => runRequestPlan(teammate, task),
  review_plan: ({ request_id, approve, feedback }) =>
    runReviewPlan(request_id, approve, feedback ?? ""),
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
//  agentLoop
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
            value: `[Background task ${bgId} started] Result will be available when complete.`,
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

    // Background notifications get their own user message (see s13 note)
    const bgNotifications = collectBackgroundResults();
    if (bgNotifications.length) {
      messages.push({ role: "user", content: bgNotifications.join("\n") });
    }

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── Entry point ──────────────────────────────────────────
console.log("s16: team protocols");
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
    query = await rl.question("\x1b[36ms16 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  console.log(finalText);

  // Check inbox → route protocol + inject into history
  const inboxMsgs = consumeLeadInbox(true);
  if (inboxMsgs.length) {
    const inboxText = inboxMsgs
      .map((m) => `From ${m.from}: ${m.content.slice(0, 200)}`)
      .join("\n");
    history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
    console.log(`\n\x1b[33m[Inbox: ${inboxMsgs.length} messages injected]\x1b[0m`);
  }
  console.log();
}
rl.close();

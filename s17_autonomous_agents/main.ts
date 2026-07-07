/**
 * s17_autonomous_agents/main.ts - Autonomous Agents
 *
 * Idle poll + auto-claim + WORK/IDLE lifecycle.
 *
 * Changes from s16:
 *   + scanUnclaimedTasks: find pending, unowned tasks with deps completed
 *   + idlePoll: 60s polling loop (inbox + task board), dispatches shutdown in IDLE
 *   + claimTask: owner check + missing-deps message
 *   + Teammate lifecycle: WORK → IDLE → SHUTDOWN
 *   + Teammate tools: + list_tasks, claim_task, complete_task (5→8)
 *   + Identity re-injection when the teammate history is still short
 *   - Background tasks dropped (upstream s17 simplifies the agent loop)
 *
 * ASCII lifecycle:
 *   WORK: inbox → LLM → tools → (tool-calls? loop) → (done? → IDLE)
 *   IDLE: 5s poll → inbox? → WORK / unclaimed? → claim → WORK / 60s? → SHUTDOWN
 *
 * TS-specific notes:
 *   - Teammates are detached async loops; idlePoll uses `await sleep(5s)`
 *   - WORK phase caps at 10 LLM rounds per cycle like the Python version
 *
 * Usage:
 *     pnpm dev s17_autonomous_agents/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { model } from "../lib/model";

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
  messages: ModelMessage[],
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
  const handleInboxMessage = (msg: BusMessage, messages: ModelMessage[]): boolean => {
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
    // s17 new: teammates can list, claim, and complete tasks
    list_tasks: tool({
      description: "List all tasks on the board.",
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

  const subListTasks = () => {
    const tasks = listTasks();
    if (!tasks.length) return "No tasks.";
    return tasks.map((t) => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n");
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
    list_tasks: () => subListTasks(),
    claim_task: ({ task_id }) => claimTask(task_id, name),
    complete_task: ({ task_id }) => completeTask(task_id),
  };

  const run = async () => {
    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
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

const tools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
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
    description: "Get full details of a specific task.",
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
  spawn_teammate: tool({
    description: "Spawn an autonomous teammate agent.",
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
    description: "Request a teammate to shut down gracefully.",
    inputSchema: z.object({ teammate: z.string() }),
  }),
  request_plan: tool({
    description: "Ask a teammate to submit a plan for review.",
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
};

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
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
      const handler = TOOL_HANDLERS[call.toolName];
      const output = handler ? handler(call.input) : "Unknown";
      console.log(output.slice(0, 300));
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }
    messages.push({ role: "tool", content: results });

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

const history: ModelMessage[] = [];
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

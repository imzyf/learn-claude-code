/**
 * s06_subagent/main.ts - Subagent
 *
 * 用全新的 messages[] 派生子 agent，实现上下文隔离：
 *
 *   Parent Agent                           Subagent
 *   +------------------+                  +------------------+
 *   | messages=[...]   |                  | messages=[task]  | <-- fresh
 *   |                  |   dispatch       |                  |
 *   | tool: task       | ---------------> | own while loop   |
 *   |   prompt="..."   |                  |   bash/read/...  |
 *   |                  |   summary only   |   (max 30 turns) |
 *   | result = "..."   | <--------------- | return last text |
 *   +------------------+                  +------------------+
 *         ^                                      |
 *         |      intermediate results DISCARDED  |
 *         +--------------------------------------+
 *
 *   子 agent 的工具：bash、read、write、edit、glob（没有 task——不能递归）
 *
 * 相比 s05 的变化：
 *   + task 工具 + 带全新 messages[] 的 spawnSubagent()
 *   + 安全限制：每个子 agent 最多 30 轮
 *   子 agent 不能再派生子子 agent（subTools 里没有 task 工具）。
 *   主循环几乎没变：task 通过 TOOL_HANDLERS 自动分发——
 *   唯一区别是 `await handler(...)`，因为 spawnSubagent 是异步的。
 *
 * 基于 s05（todo_write）构建。Usage:
 *
 *     pnpm dev s06_subagent/main.ts
 */

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type AgentLogger } from "../lib/logger";
import {
  runRead as s02RunRead,
  runWrite as s02RunWrite,
  runEdit as s02RunEdit,
  runGlob as s02RunGlob,
  safePath as s02SafePath,
} from "../s02_tool_use/main";

const WORKDIR = process.cwd();

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "For complex sub-problems, use the task tool to spawn a subagent.";

// s06: subagent gets its own system prompt — no task, no recursion
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// client 与 logger 通过参数注入到 agentLoop / spawnSubagent。
export type Deps = { client: ModelClient; logger: AgentLogger };

// ═══════════════════════════════════════════════════════════
//  FROM s02-s05: Tool Implementations
//  - runBash 同 s03/s04：去掉内联危险检查（改由 permissionHook 把关）
//  - safePath + 四个文件工具 unchanged：从 s02 导入并起别名，本地保留
//    同名 wrapper，结构与 TOOL_HANDLERS 调用点都不用动
// ═══════════════════════════════════════════════════════════

export function runBash(command: string): string {
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

export function safePath(p: string): string {
  return s02SafePath(p);
}

export function runRead(p: string, limit?: number): string {
  return s02RunRead(p, limit);
}

export function runWrite(p: string, content: string): string {
  return s02RunWrite(p, content);
}

export function runEdit(p: string, oldText: string, newText: string): string {
  return s02RunEdit(p, oldText, newText);
}

export function runGlob(pattern: string): string {
  return s02RunGlob(pattern);
}

// FROM s05 (unchanged): todo_write

const todoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
type Todo = z.infer<typeof todoItem>;

let currentTodos: Todo[] = [];

export function normalizeTodos(todos: unknown): { todos?: Todo[]; error?: string } {
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

export function runTodoWrite(todosInput: unknown): string {
  const { todos, error } = normalizeTodos(todosInput);
  if (error || !todos) return error ?? "Error: invalid todos";
  currentTodos = todos;
  const icons: Record<Todo["status"], string> = {
    pending: " ",
    in_progress: "\x1b[36m▸\x1b[0m",
    completed: "\x1b[32m✓\x1b[0m",
  };
  const lines = ["\n\x1b[33m## Current Tasks\x1b[0m"];
  for (const t of currentTodos) {
    lines.push(`  [${icons[t.status]}] ${t.content}`);
  }
  console.log(lines.join("\n"));
  return `Updated ${currentTodos.length} tasks`;
}

// ═══════════════════════════════════════════════════════════
//  Tool Definitions — parent gets everything, subagent a subset
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });
const todoWriteSchema = z.object({ todos: z.union([z.array(todoItem), z.string()]) });
const taskSchema = z.object({ description: z.string() });

// Shared by parent and subagent (Python re-declares SUB_TOOLS by hand)
const fileTools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
];

const FILE_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

const tools: Anthropic.Tool[] = [
  ...fileTools,
  zodTool(
    "todo_write",
    "Create and manage a task list for your current coding session.",
    todoWriteSchema,
  ),
  // s06: new tool
  zodTool(
    "task",
    "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    taskSchema,
  ),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...FILE_SCHEMAS,
  todo_write: todoWriteSchema,
  task: taskSchema,
};

// NO "task" tool — prevent recursive spawning
const subTools = fileTools;

const SUB_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// Handlers may be async now: task -> spawnSubagent returns a Promise.
// 第二参 deps 让需要 client/logger 的 handler（task）拿到依赖，
// 纯工具 handler 直接忽略它。
const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: Deps) => string | Promise<string>>
> = {
  ...SUB_HANDLERS,
  todo_write: ({ todos }) => runTodoWrite(todos),
  task: ({ description }, deps) => spawnSubagent(description, deps),
};

// ═══════════════════════════════════════════════════════════
//  NEW in s06: Subagent — fresh messages[], summary only
// ═══════════════════════════════════════════════════════════

export async function spawnSubagent(description: string, deps: Deps): Promise<string> {
  const { client, logger } = deps;
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: description }]; // fresh context
  let lastText = "";

  for (let turn = 0; turn < 30; turn++) {
    // safety limit
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system: SUB_SYSTEM,
      messages,
      tools: subTools,
      max_tokens: 8000,
    });
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });
    const text = textOf(response);
    if (text) lastText = text;
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      // Issue 1: subagent also runs hooks (permissions apply)
      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }

      const schema = FILE_SCHEMAS[block.name];
      const handler = SUB_HANDLERS[block.name];
      const output = handler && schema ? handler(schema.parse(block.input)) : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      await triggerHooks("PostToolUse", block, output);
      console.log(`  \x1b[90m[sub] ${block.name}: ${output.slice(0, 100)}\x1b[0m`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }

  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  // Issue 5: fallback if safety limit hit during tool-calls — lastText holds
  // the most recent assistant text, if any turn produced one.
  // Only the summary returns; the subagent's message history is discarded.
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  FROM s04 (unchanged): Hook System
// ═══════════════════════════════════════════════════════════

// `...args: any[]` mirrors Python's `callback(*args)`.
type Hook = (...args: any[]) => string | null | Promise<string | null>;

const HOOKS: Record<string, Hook[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(event: string, callback: Hook): void {
  HOOKS[event].push(callback);
}

export async function triggerHooks(event: string, ...args: any[]): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) return result;
  }
  return null;
}

// 测试用：清空注册表，隔离用例（入口通过 registerDefaultHooks 注册）。
export function clearHooks(): void {
  for (const event of Object.keys(HOOKS)) HOOKS[event] = [];
}

type ToolCallInfo = Anthropic.ToolUseBlock;

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];

// PreToolUse: deny list check.
export function permissionHook(call: ToolCallInfo): string | null {
  if (call.name === "bash") {
    for (const pattern of DENY_LIST) {
      if (((call.input as any).command ?? "").includes(pattern)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${pattern}'\x1b[0m`);
        return "Permission denied";
      }
    }
  }
  return null;
}

// PreToolUse: log tool calls.
export function logHook(call: ToolCallInfo): null {
  console.log(`\x1b[90m[HOOK] ${call.name}\x1b[0m`);
  return null;
}

// UserPromptSubmit: log working directory.
export function contextInjectHook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop: print tool call count.
export function summaryHook(messages: Anthropic.MessageParam[]): null {
  const toolCount = messages.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result").length : 0),
    0,
  );
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

// 默认 hook 注册收进函数，只在入口调用一次；import 该模块不产生副作用。
export function registerDefaultHooks(): void {
  registerHook("UserPromptSubmit", contextInjectHook);
  registerHook("PreToolUse", permissionHook);
  registerHook("PreToolUse", logHook);
  registerHook("Stop", summaryHook);
}

// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s05 + nag reminder, task auto-dispatches
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

export function resetNagCounter(): void {
  roundsSinceTodo = 0;
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger } = deps;
  while (true) {
    // s05: nag reminder
    if (roundsSinceTodo >= 3 && messages.length) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

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

    if (response.stop_reason !== "tool_use") {
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    roundsSinceTodo += 1;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      // s06: await — the task handler (spawnSubagent) is async
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await triggerHooks("PostToolUse", block, output);

      if (block.name === "todo_write") roundsSinceTodo = 0;

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── Entry point ──────────────────────────────────────────
// import.meta.main 只在文件被直接运行时为 true。
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });
  registerDefaultHooks();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  console.log("s06: Subagent — spawn sub-agents with fresh context, summary only");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms06 >> \x1b[0m");
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    await triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger });
    console.log(finalText);
    console.log();
  }
  rl.close();
}

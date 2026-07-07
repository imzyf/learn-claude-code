/**
 * s05_todo_write/main.ts - TodoWrite
 *
 * 在 s04 hooks 基础上加一个规划工具：
 *
 *   +---------+      +-------+      +------------------+
 *   |  User   | ---> |  LLM  | ---> | TOOL_HANDLERS    |
 *   | prompt  |      |       |      |  bash            |
 *   +---------+      +---+---+      |  read_file       |
 *                        ^          |  write_file      |
 *                        | result   |  edit_file       |
 *                        +----------+  glob            |
 *                                   |  todo_write ← NEW|
 *                                   +------------------+
 *                                        |
 *                          in-memory currentTodos
 *                                        |
 *                         if roundsSinceTodo >= 3:
 *                           inject <reminder>
 *
 * 相比 s04 的变化：
 *   + todo_write 工具 + runTodoWrite() 实现
 *   + 唠叨提醒（连续 3 轮没更新 todo 就注入提醒）
 *   + SYSTEM prompt 加入“先计划再执行”的指引
 *   + agentLoop 中的 roundsSinceTodo 计数器
 *   - permissionHook 精简为只剩拒绝名单（不再有 Allow? 提示）
 *   循环本身没变：新工具通过 TOOL_HANDLERS 自动分发。
 *
 * 一处 TS 特有的差异：Python 版本在 _normalize_todos 里手动校验 todos；
 * 这里改用 zod 的 safeParse 做条目校验，normalizeTodos 只负责
 * 解开偶尔出现的 JSON 字符串形式。
 *
 * 基于 s04（hooks）构建。Usage:
 *
 *     pnpm dev s05_todo_write/main.ts
 */

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type SessionLogger } from "../lib/logger";
import {
  runRead as s02RunRead,
  runWrite as s02RunWrite,
  runEdit as s02RunEdit,
  runGlob as s02RunGlob,
  safePath as s02SafePath,
} from "../s02_tool_use/main";

const WORKDIR = process.cwd();

// s05 change: SYSTEM prompt adds planning guidance
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go.";

// ═══════════════════════════════════════════════════════════
//  FROM s02-s04: Tool Implementations
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

// ═══════════════════════════════════════════════════════════
//  NEW in s05: todo_write tool — plan only, no execution
// ═══════════════════════════════════════════════════════════

const todoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
type Todo = z.infer<typeof todoItem>;

let currentTodos: Todo[] = [];

// The model occasionally sends `todos` as a JSON string instead of an
// array — the input schema admits both, this unwraps and validates.
// (Python's _normalize_todos also tries ast.literal_eval; JSON is enough here.)
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

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });
const todoWriteSchema = z.object({ todos: z.union([z.array(todoItem), z.string()]) });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
  // s05: new tool
  zodTool(
    "todo_write",
    "Create and manage a task list for your current coding session.",
    todoWriteSchema,
  ),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
  todo_write: todoWriteSchema,
};

// `input: any` mirrors Python's `handler(**block.input)` — each handler
// destructures the shape its schema guarantees after `.parse()`.
const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
  todo_write: ({ todos }) => runTodoWrite(todos),
};

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

// s04 hooks preserved
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
//  agentLoop — same as s04 + nag reminder counter
// ═══════════════════════════════════════════════════════════

// 唠叨计数器跨用户轮持续（module 级）；测试用 resetNagCounter 复位。
let roundsSinceTodo = 0;

export function resetNagCounter(): void {
  roundsSinceTodo = 0;
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger },
): Promise<string> {
  const { client, logger } = deps;
  while (true) {
    // s05: nag reminder — inject if model hasn't updated todos for 3 rounds
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
      const output = handler && schema ? handler(schema.parse(block.input)) : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await triggerHooks("PostToolUse", block, output);

      // s05: reset nag counter when todo_write is called
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

  console.log("s05: TodoWrite — plan before execute, nag if you forget");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms05 >> \x1b[0m");
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

/**
 * s04_hooks/main.ts - Hooks
 *
 * 把扩展逻辑从循环里搬出来，交给 hooks 管理：
 *
 *   User types query
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │ UserPromptSubmit │ ── triggerHooks() before LLM
 *   └────────┬─────────┘
 *            ▼
 *   ┌────────────┐     ┌──────────────────────────────┐
 *   │  messages  │────▶│ LLM (stop_reason=tool_use?)   │
 *   └────────────┘     │   No ──▶ Stop hooks ──▶ exit  │
 *                      │   Yes ──▶ tool call ────────┐ │
 *                      └─────────────────────────────┘ │
 *                                                      ▼
 *                                          ┌──────────────────┐
 *                                          │ triggerHooks()    │
 *                                          │  PreToolUse:      │
 *                                          │   permissionHook  │
 *                                          │   logHook         │
 *                                          └───────┬──────────┘
 *                                                  │ (not blocked)
 *                                          ┌───────▼──────────┐
 *                                          │ TOOL_HANDLERS[x]  │
 *                                          └───────┬──────────┘
 *                                                  │
 *                                          ┌───────▼──────────┐
 *                                          │ triggerHooks()    │
 *                                          │  PostToolUse:     │
 *                                          │   largeOutput     │
 *                                          └───────┬──────────┘
 *                                                  │
 *                                          results ──▶ back to messages
 *
 * 相比 s03 的变化：
 *   + HOOKS 注册表（事件 -> 回调列表）
 *   + registerHook() / triggerHooks()
 *   + contextInjectHook（UserPromptSubmit）
 *   + permissionHook、logHook（PreToolUse）
 *   + largeOutputHook（PostToolUse）
 *   + summaryHook（Stop）—— 可能通过一条用户消息强制再来一轮
 *   - checkPermission() 从循环体里移除
 *     （逻辑搬进了 permissionHook，通过 PreToolUse 触发）
 *   - 循环自身的 `> toolName` / 输出日志被移除——改由 logHook 负责
 *
 * 基于 s03（权限）构建。Usage:
 *
 *     pnpm dev s04_hooks/main.ts
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ═══════════════════════════════════════════════════════════
//  FROM s02-s03: Tool Implementations
//  - runBash 同 s03：去掉内联危险检查（改由 permissionHook 把关）
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
//  FROM s02-s03 (unchanged): Tool Definitions & Dispatch
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

// `input: any` mirrors Python's `handler(**block.input)` — each handler
// destructures the shape its schema guarantees after `.parse()`.
const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// ═══════════════════════════════════════════════════════════
//  NEW in s04: Hook System (s03 permission logic now via hooks)
// ═══════════════════════════════════════════════════════════

// Hooks are async because permissionHook awaits rl.question()
// (Python just calls input()). `...args: any[]` mirrors Python's
// `callback(*args)` — each event passes its own argument shape.
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
    if (result != null) return result; // teaching shortcut: block this tool call
  }
  return null;
}

// 清空所有已注册 hook。入口不会自动注册（见 registerDefaultHooks），
// 测试用它在每个用例前重置注册表，避免用例间互相污染。
export function clearHooks(): void {
  for (const event of Object.keys(HOOKS)) HOOKS[event] = [];
}

// The shape PreToolUse/PostToolUse hooks receive — the raw tool_use block
// (matches what Python hooks receive too).
type ToolCallInfo = Anthropic.ToolUseBlock;

// permissionHook 需要「问用户」的能力，但不该自己持有 readline。
// 把确认动作抽象成 Confirm：入口注入真实 readline 提示，测试注入 fake。
export type Confirm = (call: ToolCallInfo, warning: string) => Promise<boolean>;

// s03 permission check logic, now wrapped as a hook
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// PreToolUse: s03 checkPermission() logic moved here.
// 工厂函数：闭包捕获 confirm，返回真正的 hook（这就是给回调注入依赖的标准手法）。
export function makePermissionHook(confirm: Confirm): Hook {
  return async (call: ToolCallInfo): Promise<string | null> => {
    const input = call.input as any;
    if (call.name === "bash") {
      const command: string = input.command ?? "";
      for (const pattern of DENY_LIST) {
        if (command.includes(pattern)) {
          console.log(`\n\x1b[31m⛔ Blocked: '${pattern}'\x1b[0m`);
          return "Permission denied by deny list";
        }
      }
      if (DESTRUCTIVE.some((kw) => command.includes(kw))) {
        if (!(await confirm(call, "Potentially destructive command"))) {
          return "Permission denied by user";
        }
      }
    }
    if (call.name === "write_file" || call.name === "edit_file") {
      const resolved = path.resolve(WORKDIR, input.path ?? "");
      if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
        if (!(await confirm(call, "Writing outside workspace"))) {
          return "Permission denied by user";
        }
      }
    }
    return null;
  };
}

// PreToolUse: log every tool call.
export function logHook(call: ToolCallInfo): null {
  const argsPreview = JSON.stringify(Object.values((call.input as any) ?? {}).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${call.name}(${argsPreview})\x1b[0m`);
  return null;
}

// PostToolUse: warn on large output.
export function largeOutputHook(call: ToolCallInfo, output: string): null {
  if (output.length > 100_000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${call.name}: ${output.length} chars\x1b[0m`);
  }
  return null;
}

// UserPromptSubmit hook: log user input before it reaches the LLM
export function contextInjectHook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop hook: print summary when loop is about to exit
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
// permissionHook 需要 confirm，所以注册时才把它注入进去。
export function registerDefaultHooks(confirm: Confirm): void {
  registerHook("UserPromptSubmit", contextInjectHook);
  registerHook("PreToolUse", makePermissionHook(confirm));
  registerHook("PreToolUse", logHook);
  registerHook("PostToolUse", largeOutputHook);
  registerHook("Stop", summaryHook);
}

// ═══════════════════════════════════════════════════════════
//  agentLoop — same structure as s03, but no hard-coded check
//  s03: if (!(await checkPermission(call))) ...
//  s04: if (await triggerHooks("PreToolUse", call)) ...
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger },
): Promise<string> {
  const { client, logger } = deps;
  while (true) {
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
      // A Stop hook may force another round: its return value becomes
      // a user message and the loop continues instead of exiting.
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      // s04 change: hook replaces hard-coded checkPermission()
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

      await triggerHooks("PostToolUse", block, output); // s04: post hook

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

  // Shared readline: hooks (Allow? prompt) and the REPL both use it.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const confirmWithUser: Confirm = async (call, warning) => {
    console.log(`\n\x1b[33m⚠  ${warning}\x1b[0m`);
    console.log(`   Tool: ${call.name}(${JSON.stringify(call.input)})`);
    let choice: string;
    try {
      choice = (await rl.question("   Allow? [y/N] ")).trim().toLowerCase();
    } catch {
      return false; // stdin closed — nobody left to approve
    }
    return choice === "y" || choice === "yes";
  };

  registerDefaultHooks(confirmWithUser);

  console.log("s04: Hooks — extension logic on hooks, loop stays clean");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms04 >> \x1b[0m");
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

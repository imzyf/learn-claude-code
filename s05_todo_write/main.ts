/**
 * s05_todo_write/main.ts - TodoWrite
 *
 * 在 s04 hooks 基础上加一个规划工具 todo_write：
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
 *   工具层：复用 s02 的 tools / TOOL_SCHEMAS + s03 的 TOOL_HANDLERS，
 *          只 append 一个 todo_write（外加 runTodoWrite 实现）。
 *   Hook 层：hook 实例（createHooks）连同 contextInjectHook / logHook /
 *          summaryHook 全部从 s04 原样复用。
 *   + 唠叨提醒：连续 3 轮没更新 todo 就注入 <reminder>
 *     （agentLoop 里的 roundsSinceTodo 计数器）。
 *   + SYSTEM prompt 加入「先计划再执行」的指引。
 *   - permissionHook 精简为只剩拒绝名单（复用 s03 的 checkDenyList），
 *     不再有 s04 的 Allow? 确认关卡——把注意力留给 todo_write 本身。
 *
 * 一处 TS 特有的差异：Python 版本在 _normalize_todos 里手动校验 todos；
 * 这里改用 zod 的 safeParse 做条目校验，normalizeTodos 只负责解开偶尔
 * 出现的 JSON 字符串形式。
 *
 * 基于 s04（hooks）构建。Usage:
 *
 *     pnpm dev s05_todo_write/main.ts
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）——纯数据，原样复用。
import {
  TOOL_SCHEMAS as BASE_SCHEMAS,
  tools as baseTools,
} from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）+ 拒绝名单检查（checkDenyList）。
import {
  TOOL_HANDLERS as BASE_HANDLERS,
  checkDenyList,
} from "../s03_permission/main";
// 来自 s04：hook 系统（createHooks 实例）与三个通用 hook，原样复用。
import {
  createHooks,
  type HookSystem,
  logHook,
  summaryHook,
} from "../s04_hooks/main";

const WORKDIR = process.cwd();

// s05 改动：SYSTEM prompt 加入「先计划再执行」的指引。
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go.";

// ═══════════════════════════════════════════════════════════
//  s05 新增：todo_write 工具 —— 只规划，不执行
// ═══════════════════════════════════════════════════════════

const todoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
type Todo = z.infer<typeof todoItem>;

// todo 清单存在内存里，跨轮持续（Python 版是模块级 _current_todos）。
let currentTodos: Todo[] = [];

// 模型偶尔把 `todos` 当成 JSON 字符串发来（不是数组）——input schema 两者都收，
// 这里解开并校验。（Python 的 _normalize_todos 还会试 ast.literal_eval，JSON 足够了。）
export function normalizeTodos(todos: unknown): {
  todos?: Todo[];
  error?: string;
} {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { error: "Error: todos must be a list or JSON array string" };
    }
  }
  const parsed = z.array(todoItem).safeParse(todos);
  if (!parsed.success) {
    return {
      error: "Error: todos must be a list of {content, status} objects",
    };
  }
  return { todos: parsed.data };
}

// 把 todo 清单按 `[status] content` 逐行写进 transcript（纯文本、无 ANSI）。
export function logTodos(logger: SessionLogger, todos: readonly Todo[]): void {
  const body = todos.map((t) => `[${t.status}] ${t.content}`).join("\n");
  logger.section("TASKS", body || "(empty)");
}

export function runTodoWrite(
  todosInput: unknown,
  logger: SessionLogger,
): string {
  const { todos, error } = normalizeTodos(todosInput);
  if (error || !todos) return error ?? "Error: invalid todos";
  currentTodos = todos;
  const icons: Record<Todo["status"], string> = {
    pending: " ",
    in_progress: colorize("▸", "cyan"),
    completed: colorize("✓", "green"),
  };
  const lines = [`\n${colorize("## Current Tasks", "yellow")}`];
  for (const t of currentTodos) {
    lines.push(`  [${icons[t.status]}] ${t.content}`);
  }
  print(lines.join("\n"));
  // 终端看彩色清单；transcript 另存一份纯文本条目（toolResult 只有 "Updated N tasks"）。
  logTodos(logger, currentTodos);
  return `Updated ${currentTodos.length} tasks`;
}

const todoWriteSchema = z.object({
  // string 一支：兼容模型偶尔把数组发成 JSON 字符串，schema.parse 才不会抛错（normalizeTodos 负责解开）。
  todos: z.union([z.array(todoItem), z.string()]),
});

// ═══════════════════════════════════════════════════════════
//  工具装配：s02/s03 的基础工具层 + 一个 todo_write
//  三张表都用展开语法在基础之上追加，调用点（agentLoop）不用改。
// ═══════════════════════════════════════════════════════════

// 装配好的三张表导出，供下游（s06）在其之上追加 task 等新工具复用。
export const tools: Anthropic.Tool[] = [
  ...baseTools,
  zodTool(
    "todo_write",
    "Create and manage a task list for your current coding session.",
    todoWriteSchema,
  ),
];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...BASE_SCHEMAS,
  todo_write: todoWriteSchema,
};

// 第二参 deps 让 todo_write 拿到 logger；基础 handler 是 (input)=>string，忽略它。
export const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: { logger: SessionLogger }) => string>
> = {
  ...BASE_HANDLERS,
  todo_write: ({ todos }, deps) => runTodoWrite(todos, deps.logger),
};

// ═══════════════════════════════════════════════════════════
//  来自 s04（复用）：hook 系统 + 通用 hook
//  createHooks 与 contextInjectHook / logHook / summaryHook 都从 s04 import，
//  s05 只补一个精简版 permissionHook。
// ═══════════════════════════════════════════════════════════

// PreToolUse/PostToolUse hook 收到的结构 —— 原始的 tool_use block。
type ToolCallInfo = Anthropic.ToolUseBlock;

// PreToolUse：s05 只保留拒绝名单这一道关卡（s04 的 Allow? 确认关卡去掉）。
// 检测逻辑复用 s03 的 checkDenyList，命中即拦截。
export function permissionHook(
  logger: SessionLogger,
  call: ToolCallInfo,
): string | null {
  if (call.name === "bash") {
    const reason = checkDenyList((call.input as any).command ?? "");
    if (reason) {
      logger.console(
        `[HOOK] PreToolUse(permissionHook): ⛔ Blocked: '${reason}'`,
        "red",
      );
      return reason;
    }
  }
  return null;
}

// 默认 hook 注册收进函数，只在入口调用一次；import 该模块不产生副作用。
export function registerDefaultHooks(hooks: HookSystem): void {
  hooks.register("PreToolUse", permissionHook);
  hooks.register("PreToolUse", logHook);
  hooks.register("Stop", summaryHook);
  // 注册完一次性记录（和 s04 一致，复用 s04 的格式化）。
  hooks.logRegistration();
}

// 入口层 helper：建 hook 实例 + 注册默认 hook，s05/s06.. 入口复用。
export function loadHooks(logger: SessionLogger): HookSystem {
  const hooks = createHooks(logger);
  registerDefaultHooks(hooks);
  return hooks;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s04 一样，只多了 nag 计数器
// ═══════════════════════════════════════════════════════════

// 唠叨计数器跨用户轮持续（module 级）；测试用 resetNagCounter 复位。
// nag 机制在 s05 引入，这里作为「单一出处」导出，供 s06 的 agentLoop 复用。
// 计数器本身保持 module 私有，只暴露 bump / reset / nagIfStale 三个操作。
let roundsSinceTodo = 0;

export function resetNagCounter(): void {
  roundsSinceTodo = 0;
}

// 每完成一个 tool-use 轮次调用一次，计数 +1。
export function bumpNagCounter(): void {
  roundsSinceTodo += 1;
}

// 循环顶部调用：连续 3 轮没更新 todo 就注入一条 <reminder> 并复位计数器。
export function nagIfStale(
  messages: Anthropic.MessageParam[],
  logger: SessionLogger,
): void {
  if (roundsSinceTodo < 3 || !messages.length) return;
  logger.section(
    "REMINDER",
    `连续 ${roundsSinceTodo} 轮未更新 todo，注入 <reminder>`,
  );
  messages.push({
    role: "user",
    content: "<reminder>Update your todos.</reminder>",
  });
  roundsSinceTodo = 0;
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger; hooks: HookSystem },
): Promise<string> {
  const { client, logger, hooks } = deps;
  while (true) {
    nagIfStale(messages, logger);

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
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    bumpNagCounter();
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }

      const blocked = await hooks.trigger("PreToolUse", block);
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
      const output =
        handler && schema
          ? handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await hooks.trigger("PostToolUse", block, output);

      // todo_write 被调用即复位唠叨计数器。
      if (block.name === "todo_write") resetNagCounter();

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
// Prompt example: Create lib/slug.ts with a slugify(text) function, write 3 vitest cases in lib/slug.test.ts, run the tests, and fix any failures.
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  const hooks = loadHooks(logger);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print("s05: TodoWrite — plan before execute, nag if you forget", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s05 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, hooks });
    print(finalText, "green");
    print();
  }
  rl.close();
}

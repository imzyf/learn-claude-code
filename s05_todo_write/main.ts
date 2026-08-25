/**
 * s05_todo_write/main.ts - TodoWrite
 *
 * 在 s04 hooks 基础上加一个规划工具 todo_write：模型通过 TodoManager
 * 记录自己的进度，连续 3 轮没更新就补一条提醒。
 *
 *     +----------+      +-------+      +--------------+
 *     |   User   | ---> |  LLM  | ---> | Tools        |
 *     |  prompt  |      |       |      | + todo_write |
 *     +----------+      +---^---+      +------+-------+
 *                           |                 | update
 *                           |          +------v----------+
 *                           |          | TodoManager     |
 *                           |          | [ ] pending     |
 *                           |          | [>] in progress |
 *                           |          | [x] completed   |
 *                           |          +------+----------+
 *                           | tool_result     |
 *                           +-----------------+
 *
 *               roundsSinceTodo >= 3 -> inject <reminder>
 *
 * 相比 s04 的变化：
 *   工具层：复用 s02 的 tools / TOOL_SCHEMAS，只 append 一个 todo_write
 *          （外加 runTodoWrite 实现）。dispatch 表在这里重新组装成
 *          BASE_HANDLERS —— 权限层降级了，文件工具得换回带 safePath 的版本。
 *   Hook 层：hook 实例（createHooks）连同 contextInjectHook / logHook /
 *          largeOutputHook / summaryHook 全部从 s04 原样复用。
 *   + 唠叨提醒：连续 3 轮没更新 todo 就在本轮 tool_result 里补一条
 *     <reminder>（agentLoop 里的 createNagCounter 计数器）。
 *   + SYSTEM prompt 加入「先计划再执行」的指引。
 *   - permissionHook 精简为只剩拒绝名单（复用 s03 的 checkDenyList），
 *     不再有 s04 的 Allow? 确认关卡——把注意力留给 todo_write 本身。
 *   - s04 那个「强制再来一轮」的 Stop hook 不再注册（和 code.py 一致）。
 *   - 循环里工具输出的 preview 打印去掉，输出只由 logger 收进 transcript。
 *
 * 一处 TS 特有的差异：Python 版本在 TodoManager.update 里手动校验条目结构；
 * 这里把结构校验交给 zod 的 safeParse（normalizeTodos），TodoManager 只做
 * zod 表达不了的那几条规则：20 条上限、content 去空白后非空、同时只能有
 * 一个 in_progress。dispatch 处的 try/catch 与 code.py 的 execute_tool 对应：
 * 工具异常（含 schema 校验失败）都是一条 tool_result，不打断循环。
 *
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）——纯数据，原样复用；
// 四个文件工具也取 s02 的版本，它们带 safePath（理由见下面的 BASE_HANDLERS）。
import {
  errMsg,
  type Handlers,
  runEdit,
  runGlob,
  runRead,
  runWrite,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
  tools as s02Tools,
} from "../s02_tool_use/main";
// 来自 s03：runBash（内联危险命令检查已移除）+ 拒绝名单检查（checkDenyList）。
import { checkDenyList, runBash } from "../s03_permission/main";
// 来自 s04：hook 系统（createHooks 实例）与四个通用 hook，原样复用。
import {
  contextInjectHook,
  createHooks,
  type Deps,
  type HookSystem,
  largeOutputHook,
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

const MAX_TODOS = 20;

// 模型偶尔把 `todos` 当成 JSON 字符串发来（不是数组）——input schema 两者都收，
// 这里解开并校验结构。（Python 版还会试 ast.literal_eval，JSON 足够了。）
// 错误文案不带 `Error: ` 前缀，由 runTodoWrite 统一加，和 Python 抛 ValueError 一致。
export function normalizeTodos(todos: unknown): {
  todos?: Todo[];
  error?: string;
} {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { error: "todos must be a list or JSON array string" };
    }
  }
  const parsed = z.array(todoItem).safeParse(todos);
  if (!parsed.success) {
    return { error: describeIssue(parsed.error) };
  }
  return { todos: parsed.data };
}

// zod 的 issue.path 形如 [2, "status"]：把它翻回 Python 那种带下标的文案
// （`todos[2] has invalid status`）。模型靠这句自纠，指明是哪一条才有用。
function describeIssue(error: z.ZodError): string {
  const [index, field] = error.issues[0].path;
  if (typeof index !== "number") {
    return "todos must be a list of {content, status} objects";
  }
  return typeof field === "string"
    ? `todos[${index}] has invalid ${field}`
    : `todos[${index}] must be an object with content and status`;
}

// todo 清单是模型自己维护的结构化状态，跨轮存在内存里。
// 校验失败抛 Error，由 runTodoWrite 转成一条 tool_result 文案回给模型。
export class TodoManager {
  items: Todo[] = [];

  update(todosInput: unknown): string {
    const { todos, error } = normalizeTodos(todosInput);
    if (error || !todos) throw new Error(error ?? "invalid todos");
    if (todos.length > MAX_TODOS) {
      throw new Error(`Max ${MAX_TODOS} todos allowed`);
    }

    const validated: Todo[] = [];
    let inProgress = 0;
    for (const [index, todo] of todos.entries()) {
      const content = todo.content.trim();
      if (!content) throw new Error(`todos[${index}] requires content`);
      if (todo.status === "in_progress") inProgress += 1;
      validated.push({ content, status: todo.status });
    }
    if (inProgress > 1) {
      throw new Error("Only one todo can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const markers: Record<Todo["status"], string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
    };
    const lines = this.items.map((t) => `${markers[t.status]} ${t.content}`);
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

// 和 Python 的模块级 TODO 一样，清单是进程内唯一一份：subagent（s06）和主
// agent 共用它。测试之间要靠 resetTodos 手动隔离。
export const TODO = new TodoManager();

export function resetTodos(): void {
  TODO.items = [];
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
  let output: string;
  try {
    output = TODO.update(todosInput);
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
  print(`\n${colorize("## Current Tasks", "yellow")}\n${output}`);
  // 渲染结果同时回给模型；transcript 另存一份带 status 名的条目清单。
  logTodos(logger, TODO.items);
  return output;
}

// todo_write 的 schema：zodTool 用它生成发给模型的声明（20 条上限、content
// 非空，对齐 Python 版的 input_schema），dispatch 处也用它校验模型发来的 input。
// string 分支收模型偶尔把 todos 发成 JSON 字符串的情况；解开它、以及 zod 表达
// 不了的那条规则（同时只能有一个 in_progress），由 normalizeTodos / TodoManager
// 兜底。
const todoWriteSchema = z.object({
  todos: z.union([
    z.array(todoItem.extend({ content: z.string().min(1) })).max(MAX_TODOS),
    z.string(),
  ]),
});

// ═══════════════════════════════════════════════════════════
//  工具装配：s02/s03 的基础工具层 + 一个 todo_write
//  三张表都用展开语法在基础之上追加，调用点（agentLoop）不用改。
// ═══════════════════════════════════════════════════════════

// s05 起权限层被精简成只剩拒绝名单（下游更是一道都不留），s03 的关卡 2/3
// 不在了，所以基础 dispatch 表在这里重新组装：runBash 用 s03 的（危险命令
// 交给拒绝名单），四个文件工具换回 s02 带 safePath 的版本兜住越界。
export const BASE_HANDLERS: Handlers = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// 装配好的三张表导出，供下游（s06）在其之上追加 task 等新工具复用。
export const tools: Anthropic.Tool[] = [
  ...s02Tools,
  zodTool(
    "todo_write",
    "Create and manage a task list for your current coding session.",
    todoWriteSchema,
  ),
];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
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

// PreToolUse：s05 只保留拒绝名单这一道关卡（s04 的 Allow? 确认关卡去掉）。
// 检测逻辑复用 s03 的 checkDenyList，命中即拦截。
export function permissionHook(
  logger: SessionLogger,
  call: Anthropic.ToolUseBlock,
): string | null {
  if (call.name === "bash") {
    const reason = checkDenyList((call.input as any).command ?? "");
    if (reason) {
      // 命中的具体 pattern 只写进日志；回给模型的文案和 s04 / Python 保持一致。
      logger.console(`[HOOK] PreToolUse(permissionHook): ${reason}`, "red");
      return "Permission denied by deny list";
    }
  }
  return null;
}

// 默认 hook 注册收进函数，只在入口调用一次；import 该模块不产生副作用。
// 五个 hook 和 code.py 的注册表逐条对齐；s04 那个「强制再来一轮」的 Stop hook
// 不在其中（它是 s04 演示用的，Python 版没有）。
export function registerDefaultHooks(hooks: HookSystem): void {
  hooks.register("UserPromptSubmit", contextInjectHook);
  hooks.register("PreToolUse", permissionHook);
  hooks.register("PreToolUse", logHook);
  hooks.register("PostToolUse", largeOutputHook);
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

const NAG_AFTER_ROUNDS = 3;

// 唠叨计数器。Python 里它是 agent_loop 的局部变量（code.py:279），每条用户输入
// 从 0 开始；这里用闭包对应，agentLoop 每次调用建一个实例。做成模块级变量的话
// 计数会跨用户轮残留，新一轮跑 1 个工具轮次就可能被提醒，语义不再是「连续 3 轮」。
// nag 机制在 s05 引入，这里作为「单一出处」导出，供 s06+ 的 agentLoop 复用。
export interface NagCounter {
  // 每完成一个 tool-use 轮次调用一次，计数 +1。
  bump(): void;
  // todo_write 被调用即复位。
  reset(): void;
  // 连续 3 轮没更新 todo 就往本轮的 tool_result 里追加一条 <reminder>。
  nagIfStale(
    results: Anthropic.ContentBlockParam[],
    logger: SessionLogger,
  ): void;
}

export function createNagCounter(): NagCounter {
  let roundsSinceTodo = 0;
  return {
    bump() {
      roundsSinceTodo += 1;
    },
    reset() {
      roundsSinceTodo = 0;
    },
    // 提醒和 tool_result 同处一条 user 消息（对齐 code.py:321-324）：既不会
    // 制造两条相邻的 user 消息，模型也在同一次请求里看到它。
    nagIfStale(results, logger) {
      if (roundsSinceTodo < NAG_AFTER_ROUNDS) return;
      logger.console(
        `[NAG] 连续 ${roundsSinceTodo} 轮未更新 todo，注入 <reminder>`,
        "yellow",
      );
      results.push({
        type: "text",
        text: "<reminder>Update your todos.</reminder>",
      });
      roundsSinceTodo = 0;
    },
  };
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks } = deps;
  const nag = createNagCounter();
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

    if (!hasToolUse(response)) {
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    nag.bump();
    // 类型是 ContentBlockParam[] 而不是 ToolResultBlockParam[]：<reminder>
    // 作为一个 text block 挂在同一条 user 消息的末尾。
    const results: Anthropic.ContentBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;

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
      // 异常收成 tool_result 文案（对齐 code.py:307-310），包括 schema 校验失败。
      let output: string;
      try {
        output =
          handler && schema
            ? handler(schema.parse(block.input), deps)
            : `Unknown: ${block.name}`;
      } catch (e) {
        output = `Error: ${errMsg(e)}`;
      }
      logger.toolResult(block.name, output);

      await hooks.trigger("PostToolUse", block, output);

      // todo_write 被调用即复位唠叨计数器。
      if (block.name === "todo_write") nag.reset();

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    nag.nagIfStale(results, logger);
    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
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

  print("s05: TodoWrite - plan before execution", "cyan");
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

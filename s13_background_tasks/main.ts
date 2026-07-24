/**
 * s13_background_tasks/main.ts - 后台任务
 *
 * 异步后台执行 + 通知注入。
 *
 * 相比 s12 的变化：
 *   工具层、任务系统、prompt 组装、context 推导继续直接复用，不再内联：
 *     基础工具 handler 复用 s03，任务系统（tools / TOOL_SCHEMAS / makeTaskHandlers）
 *     复用 s12，getSystemPrompt / updateContext / Context 复用 s10，
 *     MEMORY_INDEX 复用 s09。s11 的错误恢复在此照旧省略。
 *   本文件只新增后台任务这一层：
 *   + BackgroundState：counter / tasks / results，跟踪跨轮的后台任务生命周期
 *   + isSlowOperation：模型未指定时的兜底启发式判断
 *   + shouldRunBackground：模型通过 run_in_background 参数显式请求，否则回退启发式
 *   + startBackgroundTask：分发给一个游离的异步 worker，返回后台任务 id
 *   + collectBackgroundResults：收集已完成的任务，以通知形式返回
 *   + agentLoop：慢操作 -> 后台执行 + 占位符，再注入 <task_notification> 通知
 *   + bash 工具覆盖 s02 版本，新增 run_in_background 参数
 *
 * TS 特有说明：
 *   - Python 用 threading.Thread + Lock；Node 的事件循环是单线程的，
 *     所以这里用一个游离的 Promise 代替守护线程，也不需要锁。
 *     后台状态由 session 持有、跨轮传入（对齐 code.py 的模块全局），
 *     这样上一轮派发、本轮才完成的任务仍能被后续 tool_use 迭代收走。
 *   - 后台 bash 用异步 exec（独立子进程），保证命令运行期间事件循环不被阻塞；
 *     前台 bash 仍走 s03 的同步 runBash。
 *   - tool_result 块和文本通知一起放进同一条 user 消息（content 是数组，
 *     可以混装多种 block），和 Python 的做法一致。
 *
 * Usage:
 *     pnpm dev s13_background_tasks/main.ts
 */

import { exec } from "node:child_process";
import * as readline from "node:readline/promises";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
import { errMsg, type Handlers } from "../s02_tool_use/main";
// 来自 s03：不含权限检查的基础 dispatch 表（前台 bash 走这里的同步 runBash）。
import { TOOL_HANDLERS as BASE_TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：记忆索引路径，s10 也复用同一份。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：只借 Context 类型（prompt 组装 / context 推导改用 s12 的版本）。
import type { Context } from "../s10_system_prompt/main";
// 来自 s12：任务系统 —— tools/TOOL_SCHEMAS 已是「基础 + 任务」的合并，
// makeTaskHandlers 工厂闭包捕获 logger + 存储目录；getSystemPrompt / updateContext
// 是 s12 接管后的版本，「Available tools」已含任务工具。s13 同名覆盖 bash 不改工具名，
// 直接复用；Deps（client + logger + memoryIndex + tasksDir?）同样以 s12 为底。
import {
  getSystemPrompt,
  makeTaskHandlers,
  TOOL_SCHEMAS as S12_TOOL_SCHEMAS,
  type Deps as S12Deps,
  tools as s12Tools,
  updateContext,
} from "../s12_task_system/main";

const WORKDIR = process.cwd();
const execAsync = promisify(exec);

// deps 与 s12 一致，另加 background：后台状态由 session 持有并跨轮传入。
export type Deps = S12Deps & {
  background: BackgroundState;
};

// ═══════════════════════════════════════════════════════════
//  s13 覆盖：bash 工具新增 run_in_background 参数
// ═══════════════════════════════════════════════════════════

// s02 的 bash 只有 command；这里加 run_in_background，让模型能显式请求后台执行。
const bashSchema = z.object({
  command: z.string(),
  run_in_background: z.boolean().optional(),
});

// tools 复用 s12（基础 + 任务），仅把 bash 换成支持 run_in_background 的版本。
export const tools: Anthropic.Tool[] = s12Tools.map((t) =>
  t.name === "bash"
    ? zodTool(
        "bash",
        "Run a shell command. Set run_in_background=true for slow operations (install/build/test).",
        bashSchema,
      )
    : t,
);

// schema 表同理：以 s12 为底，覆盖 bash。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S12_TOOL_SCHEMAS,
  bash: bashSchema,
};

// ═══════════════════════════════════════════════════════════
//  s13 新增：后台任务
// ═══════════════════════════════════════════════════════════

type BackgroundTask = {
  toolCallId: string;
  command: string;
  status: "running" | "completed";
};

// 后台生命周期状态：由 session 持有、跨轮复用，
// 这样上一轮派发、本轮完成的任务仍能被后续 tool_use 迭代收走。
// Node 单 JS 线程，不需要 Python 的 threading.Lock。
export class BackgroundState {
  // 递增计数器，用于生成 backgroundId。
  counter = 0;
  // 进行中/已完成的任务，按 backgroundId 索引。
  tasks: Record<string, BackgroundTask> = {};
  // 已完成任务的输出，按 backgroundId 索引。
  results: Record<string, string> = {};
}
// 模型显式请求优先；否则回退到启发式。
export function shouldRunBackground(toolName: string, toolInput: any): boolean {
  if (toolInput.run_in_background) return true;
  return isSlowOperation(toolName, toolInput);
}
// 兜底启发式：靠关键词猜测哪些命令可能耗时较长（install/build/test…）。
export function isSlowOperation(toolName: string, toolInput: any): boolean {
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

// 在游离的异步 worker 里跑工具（守护线程的 TS 版），返回后台任务 ID。
// bash 走异步版本；其余工具是同步 handler，直接调用后置为完成。
export function startBackgroundTask(
  state: BackgroundState,
  handlers: Handlers,
  toolName: string,
  toolCallId: string,
  input: any,
  logger: SessionLogger,
): string {
  state.counter += 1;
  const backgroundId = `background_${String(state.counter).padStart(4, "0")}`;
  const cmd = String(input.command ?? toolName);

  state.tasks[backgroundId] = { toolCallId, command: cmd, status: "running" };
  void (async () => {
    const result =
      toolName === "bash"
        ? // bash 走异步版本，不阻塞事件循环。
          await runBashAsync(String(input.command ?? ""), logger)
        : (handlers[toolName]?.(input) ?? `Unknown tool: ${toolName}`);
    state.tasks[backgroundId].status = "completed";
    state.results[backgroundId] = result;
  })();

  logger.console(
    `  [background] dispatched ${backgroundId}: ${cmd.slice(0, 40)}`,
    "yellow",
  );
  logger.section(
    "BACKGROUND TASK STARTED",
    `  <task_id>${backgroundId}</task_id>\n` +
      `  <tool_name>${toolName}</tool_name>\n` +
      `  <tool_call_id>${toolCallId}</tool_call_id>\n` +
      `  <command>${cmd}</command>`,
  );
  return backgroundId;
}
// 后台执行用的异步 bash —— 独立子进程，不阻塞事件循环。
// logger 把完整输出记进 transcript；测试传 noopLogger。
export async function runBashAsync(
  command: string,
  logger: SessionLogger,
): Promise<string> {
  const result = await execBashAsync(command);
  print(
    `  [background done] ${command.slice(0, 40)} (${result.length} chars)`,
    "blue",
  );
  logger.toolResult(`bash[background] ${command}`, result);
  return result;
}
// 实际执行，返回截断后的输出；日志与执行分离，方便复用。
async function execBashAsync(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = (stdout + stderr).trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (e) {
    // exec 在非零退出码时 reject；已捕获的输出仍挂在 error 上。
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) return "Error: Timeout (120s)";
    const out = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    return out ? out.slice(0, 50_000) : `Error: ${errMsg(e)}`;
  }
}

// 收集已完成的后台结果，包装成 <task_notification> 文本，并从 state 中清除。
export function collectBackgroundResults(
  state: BackgroundState,
  logger: SessionLogger,
): string[] {
  // 挑出已完成的任务 id。
  const readyIds = Object.entries(state.tasks)
    .filter(([, task]) => task.status === "completed")
    .map(([id]) => id);

  const notifications: string[] = [];
  for (const backgroundId of readyIds) {
    const task = state.tasks[backgroundId];
    delete state.tasks[backgroundId];
    const output = state.results[backgroundId] ?? "";
    delete state.results[backgroundId];
    const summary = output.slice(0, 200);
    notifications.push(
      `<task_notification>\n` +
        `  <task_id>${backgroundId}</task_id>\n` +
        `  <status>completed</status>\n` +
        `  <command>${task.command}</command>\n` +
        `  <summary>${summary}</summary>\n` +
        `</task_notification>`,
    );
    logger.console(
      `  [background done] ${backgroundId}: ${task.command.slice(0, 40)} (${output.length} chars)`,
      "blue",
    );
  }
  return notifications;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦后台任务（省略 s11 的错误恢复）
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: Deps,
): Promise<string> {
  const { client, logger, memoryIndex, tasksDir, background } = deps;
  let system = getSystemPrompt(context);
  // 基础工具（前台 bash / 文件工具）+ 任务工具（闭包捕获 logger + 存储目录）。
  const handlers: Handlers = {
    ...BASE_TOOL_HANDLERS,
    ...makeTaskHandlers(logger, tasksDir),
  };

  while (true) {
    logger.section(
      "SYSTEM PROMPT",
      `enabled_tools: ${JSON.stringify(Object.keys(handlers))}` +
        `\nworkspace: ${context.workspace}` +
        `\n\nBackgroundState:\n${JSON.stringify(background)}`,
    );
    logger.request(messages, true);
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
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }
    logger.response(response);

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") {
        continue;
      }
      const schema = TOOL_SCHEMAS[block.name];
      const input = schema ? schema.parse(block.input) : (block.input as any);

      // 后台执行：模型显式请求 run_in_background 或启发式判断为慢操作。
      if (shouldRunBackground(block.name, input)) {
        // 分发到游离 worker，立即拿到后台任务 id。
        const backgroundId = startBackgroundTask(
          background,
          handlers,
          block.name,
          block.id,
          input,
          logger,
        );
        // 先回占位符 tool_result，真正结果稍后以通知注入。
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            `[Background task ${backgroundId} started] ` +
            `Command: ${input.command ?? ""}. ` +
            `Result will be available when complete.`,
        });
      } else {
        // 前台执行：同步调用 handler，返回结果。
        const handler = handlers[block.name];
        const output =
          handler && schema ? handler(input) : `Unknown: ${block.name}`;
        logger.toolResult(block.name, output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // tool_result 块和文本通知一起放进同一条 user 消息
    // （content 是数组，可以同时装两种 block）；通知不复用原来的 tool call id。
    // 注入后台通知：收集已完成的任务，包装成 <task_notification> 文本块。
    const backgroundNotifications = collectBackgroundResults(
      background,
      logger,
    );
    const content: Anthropic.ContentBlockParam[] = [
      ...results,
      ...backgroundNotifications.map((n) => ({
        type: "text" as const,
        text: n,
      })),
    ];

    messages.push({ role: "user", content });
    if (backgroundNotifications.length) {
      logger.console(
        `  [inject] ${backgroundNotifications.length} background notification(s)`,
        "blue",
      );
      logger.section(
        "INJECTED BACKGROUND NOTIFICATIONS",
        backgroundNotifications.join("\n\n"),
      );
    }

    context = updateContext(memoryIndex);
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, tools });

  print("s13: Background Tasks — 异步后台执行 + 通知注入", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const history: Anthropic.MessageParam[] = [];
  // 后台状态一个 session 一份，跨轮复用。
  const background = new BackgroundState();
  let context = updateContext(MEMORY_INDEX);
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s13 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, context, {
      client,
      logger,
      memoryIndex: MEMORY_INDEX,
      background,
    });
    context = updateContext(MEMORY_INDEX);
    print(finalText, "green");
    print();
  }
  rl.close();
}

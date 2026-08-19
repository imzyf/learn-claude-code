/**
 * s11_background_tasks/main.ts - 后台任务
 *
 * 慢操作放后台，Agent Loop 继续运行；结果在后续轮次以通知形式收回。
 *
 *     主线程                                     后台 worker
 *     +------------------------------+         +----------------------+
 *     | bash(run_in_background=true) | ------> | 执行命令             |
 *     | 返回 bg_id                   |         | 结果进完成队列       |
 *     | 继续 agent loop              | <------ +----------------------+
 *     | 下一轮开局：收集             |
 *     +------------------------------+
 *
 * 相比 s04 的变化：
 *   工具层与 hook 层直接复用，不再内联：tools / TOOL_SCHEMAS 复用 s02，
 *   TOOL_HANDLERS 复用 s03，hook 系统（loadHooks / HookSystem / Deps）复用 s04。
 *   本文件只新增后台执行这一层：
 *   + bash 工具覆盖 s02 版本，新增 run_in_background 参数
 *   + shouldRunBackground：只认模型显式传的 run_in_background，不再猜关键词
 *   + BackgroundManager：tasks / results / 完成队列，跟踪跨轮的后台任务生命周期
 *   + runBashAsync：独立进程组里跑命令，返回输出与退出码
 *   + injectBackgroundResults：把已完成任务包成 <task_notification> 加进对话
 *   + agentLoop：每轮开局注入通知；executeTool 在 PreToolUse 之后分流前台/后台
 *
 * TS 特有说明：
 *   - Python 用 threading.Thread + Lock；Node 的事件循环是单线程的，
 *     所以这里用一个游离的 Promise 代替 daemon 线程，也不需要锁。
 *     后台状态由 session 持有、经 deps 跨轮传入（对齐 code.py 的模块全局），
 *     这样上一轮派发、本轮才完成的任务仍能被后续轮次收走。
 *   - 后台 bash 用异步 exec（独立子进程），保证命令运行期间事件循环不被阻塞；
 *     前台 bash 仍走 s03 的同步 runBash。
 *   - Python 在 import 时就 atexit.register + signal.signal；这里保持 import 无副作用，
 *     进程组清理在第一次派发后台任务时才安装（installShellCleanup 幂等）。
 *   - Python 的 daemon 线程不会拖住退出；Node 的子进程会 ref 住事件循环，
 *     所以 REPL 退出时要显式调用 stopBackgroundProcesses()。
 *   - tool_result 块和文本通知可以放进同一条 user 消息（content 是数组，
 *     可以混装多种 block），和 Python 的 inject_background_results 一致。
 *
 * 基于 s04（hooks）构建。Usage:
 *
 *     pnpm dev s11_background_tasks/main.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）+ errMsg。
import {
  errMsg,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
  tools as s02Tools,
} from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）+ 权限确认抽象（makeConfirm）。
import { makeConfirm, TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s04：hook 系统（装配 + 触发）与 Deps（client + logger + hooks）。
import { loadHooks, type Deps as S04Deps } from "../s04_hooks/main";

const WORKDIR = process.cwd();
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
  `Set run_in_background to true only for independent Bash commands.`;

// deps 与 s04 一致，另加 background：后台状态由 session 持有并跨轮传入。
export type Deps = S04Deps & { background: BackgroundManager };

// ═══════════════════════════════════════════════════════════
//  s11 覆盖：bash 工具新增 run_in_background 参数
// ═══════════════════════════════════════════════════════════

// s02 的 bash 只有 command；这里加 run_in_background，让模型能显式请求后台执行。
const bashSchema = z.object({
  command: z.string(),
  run_in_background: z.boolean().optional(),
});

// tools 复用 s02，仅把 bash 换成支持 run_in_background 的版本。
export const tools: Anthropic.Tool[] = s02Tools.map((t) =>
  t.name === "bash" ? zodTool("bash", "Run a shell command.", bashSchema) : t,
);

// schema 表同理：以 s02 为底，覆盖 bash。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
  bash: bashSchema,
};

// ═══════════════════════════════════════════════════════════
//  s11 新增：后台 bash 执行
// ═══════════════════════════════════════════════════════════

// 命令在独立进程组里启动（detached），这样超时或退出时能连同它派生的子进程一起停掉。
// 这只是生命周期清理，不是沙箱：另建 session 的进程仍可能离开该进程组。
const liveProcesses = new Set<ChildProcess>();
let cleanupInstalled = false;

// 停掉仍留在命令原进程组里的进程：先 SIGTERM，给一小段时间后再 SIGKILL。
function stopProcessGroup(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) return;
  if (!killGroup(pid, "SIGTERM")) return;
  // 定时器 unref，避免这条清理路径把进程的退出时间拖长。
  setTimeout(() => killGroup(pid, "SIGKILL"), 50).unref();
}

// 给整个进程组发信号；进程组已经不在时返回 false。
function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// 停掉所有还在跑的后台命令及其进程组。
// 子进程和它的 stdout / stderr pipe 都 ref 住事件循环，只要还有命令在跑，
// Node 就不会退出；REPL 收到 q 之后必须显式调用这个函数，对应 Python
// daemon 线程「主线程退出即结束」的语义。
export function stopBackgroundProcesses(): void {
  for (const child of liveProcesses) {
    if (child.pid !== undefined) {
      killGroup(child.pid, "SIGTERM");
      killGroup(child.pid, "SIGKILL");
    }
  }
  liveProcesses.clear();
}

// 进程退出前收尾：还在跑的后台命令连同其进程组一起停掉。
// Python 用 atexit + SIGTERM handler，这里对应 exit / SIGTERM / SIGINT 三个事件。
export function installShellCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", stopBackgroundProcesses);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      stopBackgroundProcesses();
      process.exit(128 + (signal === "SIGTERM" ? 15 : 2));
    });
  }
}

// 输出上限，同 s02/s03 的前台 bash：累积时限流（单块可能略微超出），
// 返回前再截断，避免长跑命令把内存吃满。
const OUTPUT_LIMIT = 50_000;

// 后台执行用的异步 bash —— 独立子进程 + 独立进程组，不阻塞事件循环。
// 返回输出与退出码：超时、被信号杀掉或启动失败时退出码为 null。
export async function runBashAsync(
  command: string,
): Promise<{ output: string; exitCode: number | null }> {
  installShellCleanup();
  return new Promise((resolve) => {
    // 用 spawn 而不是 exec：exec 的 timeout 只杀 shell 自己，
    // detached + 进程组信号才能把它派生出来的子进程一并停掉。
    const child = spawn(command, {
      shell: true,
      cwd: WORKDIR,
      detached: true,
    });
    liveProcesses.add(child);

    let out = "";
    const append = (chunk: Buffer) => {
      if (out.length < OUTPUT_LIMIT) out += chunk.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child);
    }, 120_000);

    const finish = (result: { output: string; exitCode: number | null }) => {
      clearTimeout(timer);
      liveProcesses.delete(child);
      stopProcessGroup(child);
      resolve(result);
    };
    child.on("error", (e) =>
      finish({ output: `Error: ${errMsg(e)}`, exitCode: null }),
    );
    child.on("close", (code) => {
      if (timedOut) {
        finish({ output: "Error: Timeout (120s)", exitCode: null });
        return;
      }
      const trimmed = out.trim();
      finish({
        output: trimmed ? trimmed.slice(0, OUTPUT_LIMIT) : "(no output)",
        exitCode: code,
      });
    });
  });
}

// 退出码非 0 时在输出前面标一行。这是后台路径独有的：前台走 s01 的 runBash，
// 只回 stdout + stderr，不带退出码（Python 两条路径共用 _format_bash_result，
// 这里为了复用 s01 而分叉）。同理，前台的 isDangerous 只拦前台，后台命令的
// 拦截由 PreToolUse 的 DENY_LIST 负责。
export function formatBashResult(
  output: string,
  exitCode: number | null,
): string {
  if (exitCode === 0 || exitCode === null) return output;
  return `Error: command exited with status ${exitCode}\n${output}`;
}

// ═══════════════════════════════════════════════════════════
//  s11 新增：后台任务生命周期
// ═══════════════════════════════════════════════════════════

export type BackgroundStatus = "running" | "completed" | "failed";

export type BackgroundTask = {
  toolUseId: string;
  command: string;
  status: BackgroundStatus;
};

// 模型显式请求才进后台：只认 bash 上明确为 true 的 run_in_background，
// 不再按 install / build / test 之类的关键词猜测。
export function shouldRunBackground(
  toolName: string,
  toolInput: unknown,
): boolean {
  const flag = (toolInput as { run_in_background?: unknown } | null)
    ?.run_in_background;
  return toolName === "bash" && flag === true;
}

// 后台任务的登记簿：进行中的任务、已完成的输出，以及一条完成队列。
// 由 session 持有、跨轮复用，这样上一轮派发、本轮完成的任务仍能被后续轮次收走。
// Node 只有一个 JS 线程，不需要 Python 的 threading.Lock。
export class BackgroundManager {
  // 进行中/已完成的任务，按 taskId 索引。
  tasks: Record<string, BackgroundTask> = {};
  // 已完成任务的输出，按 taskId 索引。
  results: Record<string, string> = {};
  // 完成队列：collect() 只看这里，避免每轮扫描全部任务。
  private ready: string[] = [];
  // 递增计数器，用于生成 taskId。
  private counter = 0;

  // 登记任务并派发给游离的 worker，立即返回 taskId。
  // 非 bash 工具、空命令直接抛错，由调用方转成 tool_result 的错误文本。
  start(block: Anthropic.ToolUseBlock, logger: SessionLogger): string {
    if (block.name !== "bash") {
      throw new Error("Only Bash commands can run in the background");
    }
    const command = (block.input as { command?: unknown })?.command;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("Bash command cannot be empty");
    }

    this.counter += 1;
    const taskId = `bg_${String(this.counter).padStart(4, "0")}`;
    this.tasks[taskId] = { toolUseId: block.id, command, status: "running" };
    // 游离的 Promise = Python 的 daemon 线程：不 await，循环继续往下走。
    void this.run(taskId, command, logger);

    logger.console(
      `  [background] started ${taskId}: ${command.slice(0, 60)}`,
      "yellow",
    );
    logger.section(
      "BACKGROUND TASK STARTED",
      `  <task_id>${taskId}</task_id>\n` +
        `  <tool_use_id>${block.id}</tool_use_id>\n` +
        `  <command>${command}</command>`,
    );
    return taskId;
  }

  // worker 本体：跑完把结果和状态写回登记簿，并把 taskId 推进完成队列。
  private async run(
    taskId: string,
    command: string,
    logger: SessionLogger,
  ): Promise<void> {
    let result: string;
    let status: BackgroundStatus;
    try {
      const { output, exitCode } = await runBashAsync(command);
      result = formatBashResult(output, exitCode);
      status = exitCode === 0 ? "completed" : "failed";
    } catch (e) {
      result = `Error: ${errMsg(e)}`;
      status = "failed";
    }
    logger.toolResult(`bash[background] ${command}`, result);

    const task = this.tasks[taskId];
    if (task === undefined) return; // 任务已被收走
    task.status = status;
    this.results[taskId] = result;
    this.ready.push(taskId);
  }

  // 取出已完成的任务，包装成 <task_notification> 文本，并从登记簿中清除。
  collect(logger: SessionLogger): string[] {
    const readyIds = this.ready.splice(0);
    const notifications: string[] = [];
    for (const taskId of readyIds) {
      const task = this.tasks[taskId];
      const result = this.results[taskId] ?? "";
      delete this.tasks[taskId];
      delete this.results[taskId];
      if (task === undefined) continue;

      notifications.push(
        `<task_notification>\n` +
          `  <task_id>${taskId}</task_id>\n` +
          `  <status>${task.status}</status>\n` +
          `  <command>${task.command}</command>\n` +
          `  <summary>${result.slice(0, 500)}</summary>\n` +
          `</task_notification>`,
      );
      logger.console(
        `  [background] collected ${taskId}: ${task.status}`,
        "blue",
      );
    }
    return notifications;
  }
}

// 把已完成的后台结果加进对话，返回本次注入的通知条数。
// 末尾已经是 user 消息就并进去（tool_result 和文本通知可以同处一条消息），
// 否则单开一条 user 消息。通知不复用原来的 tool_use_id：
// 原始 tool call 早已用占位 tool_result 回复过，一个 tool_use 仍只对应一个 tool_result。
export function injectBackgroundResults(
  messages: Anthropic.MessageParam[],
  background: BackgroundManager,
  logger: SessionLogger,
): number {
  const notifications = background.collect(logger);
  if (notifications.length === 0) return 0;

  const blocks: Anthropic.ContentBlockParam[] = notifications.map((text) => ({
    type: "text",
    text,
  }));
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    last.content = Array.isArray(last.content)
      ? [...last.content, ...blocks]
      : [{ type: "text", text: String(last.content) }, ...blocks];
  } else {
    messages.push({ role: "user", content: blocks });
  }

  logger.console(
    `  [inject] ${notifications.length} background notification(s)`,
    "blue",
  );
  logger.section(
    "INJECTED BACKGROUND NOTIFICATIONS",
    notifications.join("\n\n"),
  );
  return notifications.length;
}

// ═══════════════════════════════════════════════════════════
//  工具执行 —— PreToolUse 之后分流：后台派发 or 前台同步
// ═══════════════════════════════════════════════════════════

// 前台执行：查表 + schema 校验，异常收敛成错误文本回给模型。
export function callTool(block: Anthropic.ToolUseBlock): string {
  const handler = TOOL_HANDLERS[block.name];
  const schema = TOOL_SCHEMAS[block.name];
  if (!handler || !schema) return `Unknown: ${block.name}`;
  try {
    return handler(schema.parse(block.input));
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export async function executeTool(
  block: Anthropic.ToolUseBlock,
  deps: Deps,
): Promise<string> {
  const { logger, hooks, background } = deps;
  // 后台派发前仍走 PreToolUse：权限检查留在主线程，拦截即不派发。
  const blocked = await hooks.trigger("PreToolUse", block);
  if (blocked) return blocked;

  let output: string;
  if (shouldRunBackground(block.name, block.input)) {
    try {
      const taskId = background.start(block, logger);
      // 先回占位 tool_result，真正结果稍后以通知注入。
      output =
        `[Background task ${taskId} started] ` +
        `The result will be collected on a later turn.`;
    } catch (e) {
      output = `Error: ${errMsg(e)}`;
    }
  } else {
    output = callTool(block);
    logger.toolResult(block.name, output);
  }

  await hooks.trigger("PostToolUse", block, output);
  return output;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s04 结构相同，只在开局多一步通知注入
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks, background } = deps;
  while (true) {
    // 后台结果不会主动唤醒 agent：下一次进到循环开头才被收走并注入。
    injectBackgroundResults(messages, background, logger);

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

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: await executeTool(block, deps),
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const hooks = loadHooks(logger, makeConfirm(rl, logger));

  print("s11: Background Tasks — 显式后台执行 Bash 命令", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  // 后台登记簿一个 session 一份，跨轮复用。
  const background = new BackgroundManager();
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s11 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, {
      client,
      logger,
      hooks,
      background,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
  // 未完成的后台命令会 ref 住事件循环，退出前主动停掉，不然要等它跑完（或 120s 超时）。
  stopBackgroundProcesses();
}

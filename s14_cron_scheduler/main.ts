/**
 * s14_cron_scheduler/main.ts - Cron 调度器
 *
 * 独立的定时器 + 队列处理器。
 *
 * 相比 s13 的变化：
 *   工具层、任务系统、后台任务、prompt 组装继续直接复用，不再内联：
 *     基础工具 handler 复用 s03，任务系统（makeTaskHandlers）复用 s12，
 *     后台任务（BackgroundState / shouldRunBackground / startBackgroundTask /
 *     collectBackgroundResults）与带 run_in_background 的 tools / TOOL_SCHEMAS
 *     复用 s13，getSystemPrompt / Context 复用 s12 / s10，MEMORY_INDEX 复用 s09。
 *     s11 的错误恢复在此照旧省略。
 *   本文件只新增 cron 调度器这一层：
 *   + CronJob 类型（id / cron / prompt / recurring / durable）
 *   + CronState：scheduledJobs / cronQueue / lastFiredAt，由 session 持有、跨轮复用
 *   + cronFor：croner 模式的构造+缓存单一入口，匹配与校验都走它
 *     （DOM/DOW 的 OR 语义、步长/区间/校验都由库负责，不再手写字段匹配；
 *      匹配内联进 runCronTick，校验靠构造抛错，均无需单独函数）
 *   + scheduleJob / cancelJob：注册/移除 cron 任务（带校验）
 *   + runCronTick：单次扫描，把匹配的任务推进 cronQueue（定时器每秒调用）
 *   + consumeCronQueue / hasCronQueue：agentLoop 与队列处理器读取触发结果
 *   + makeCronHandlers + 3 个新工具：schedule_cron / list_crons / cancel_cron
 *   + updateContext override：enabled_tools 补上 3 个 cron 工具
 *   + agentLoop 在 s13 的基础上，循环开头多一步「消费 cron 队列 -> 注入 messages」
 *
 * 四个层次：
 *   1. 调度器：1s 定时器检查时间 -> 触发匹配的任务进 cronQueue
 *   2. 队列：cronQueue 把调度器和 agent 循环解耦
 *   3. 队列处理器：有排队任务且 agent 空闲时唤醒 agent
 *   4. 消费者：agentLoop 消费排队任务，把它们注入 messages
 *
 * TS 特有说明：
 *   - Python 的守护线程 -> setInterval(...).unref() 定时器；REPL 关闭时进程可正常退出。
 *   - Python 的 agent_lock / threading.Lock -> agentBusy 布尔值（单线程事件循环，
 *     无需真锁）：用户输入阻塞等待它释放，队列处理器在它被占用时直接跳过
 *     （相当于 acquire(blocking=False)）。cron 状态的读写都在同一事件循环线程，
 *     调度器 tick 与 consumeCronQueue 天然互斥，也不需要 cron_lock。
 *   - cron 匹配/校验由 croner 库负责（new Cron(expr).match(date)）；无回调构造
 *     只解析、不启动定时器，模式实例按表达式缓存复用。轮询架构与 code.py 保持一致。
 *   - CronState 的 durablePath 可注入，测试传临时路径做隔离（对齐 s12 的 tasksDir）。
 *
 * Usage:
 *     pnpm dev s14_cron_scheduler/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { Cron } from "croner";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s03：不含权限检查的基础 dispatch 表（前台 bash 走这里的同步 runBash）。
import { TOOL_HANDLERS as BASE_TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：记忆索引路径。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：只借 Context 类型。
import type { Context } from "../s10_system_prompt/main";
// 来自 s12：任务工具工厂、prompt 组装，以及 memory/workspace 的 context 推导。
import {
  getSystemPrompt,
  makeTaskHandlers,
  updateContext as taskUpdateContext,
} from "../s12_task_system/main";
// 来自 s13：后台任务层 + 带 run_in_background 的 bash（tools / TOOL_SCHEMAS 已是
// 「基础 + 任务 + bash 覆盖」的合并）。s14 在其上再叠加 cron 工具。
import {
  BackgroundState,
  collectBackgroundResults,
  TOOL_SCHEMAS as S13_TOOL_SCHEMAS,
  tools as s13Tools,
  shouldRunBackground,
  startBackgroundTask,
} from "../s13_background_tasks/main";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Handlers = Partial<Record<string, (input: any) => string>>;

// deps 与 s13 一致：client + logger + memoryIndex + 跨轮的 background 状态；
// 另加跨轮的 cron 状态。tasksDir 可选，透传给 makeTaskHandlers 做测试隔离。
export type Deps = { client: ModelClient; logger: SessionLogger };
export type LoopDeps = Deps & {
  memoryIndex: string;
  background: BackgroundState;
  cron: CronState;
  tasksDir?: string;
};

// ═══════════════════════════════════════════════════════════
//  s14 新增：Cron 调度器
// ═══════════════════════════════════════════════════════════

// 默认持久化路径，落在 s14 自己的目录下（对齐 s12 的 .tasks/）。
export const DURABLE_PATH = path.join(
  import.meta.dirname,
  ".scheduled_tasks.json",
);

export type CronJob = {
  id: string;
  cron: string; // "0 9 * * *"
  prompt: string; // 触发时注入的消息
  recurring: boolean; // true = 周期，false = 一次性
  durable: boolean; // true = 持久化到磁盘
};

// cron 生命周期状态：由 session 持有、跨轮复用（对齐 code.py 的模块全局）。
// durablePath 可注入，测试传临时路径做隔离。
export class CronState {
  // 已注册的任务，按 job.id 索引。
  scheduledJobs = new Map<string, CronJob>();
  // 已触发、等待投递给 agent 的任务。
  cronQueue: CronJob[] = [];
  // job.id -> "YYYY-MM-DD HH:MM"，防止同一分钟内重复触发。
  lastFiredAt = new Map<string, string>();

  constructor(public durablePath: string = DURABLE_PATH) {}
}

// 启动时从磁盘加载 durable 任务；损坏或非法的任务跳过。
export function loadDurableJobs(state: CronState, logger: SessionLogger): void {
  if (!fs.existsSync(state.durablePath)) return;
  try {
    const jobs = JSON.parse(
      fs.readFileSync(state.durablePath, "utf8"),
    ) as CronJob[];
    let loaded = 0;
    for (const job of jobs) {
      try {
        cronFor(job.cron); // 构造抛错即非法，跳过
      } catch (e) {
        logger.console(
          `  [cron] skipping invalid job ${job.id}: ${errMsg(e)}`,
          "red",
        );
        continue;
      }
      state.scheduledJobs.set(job.id, job);
      loaded += 1;
    }
    if (loaded)
      logger.console(`  [cron] loaded ${loaded} durable job(s)`, "magenta");
  } catch {
    // 持久化文件损坏：从空开始。
    logger.console(
      `  [cron] failed to load durable jobs, starting empty`,
      "red",
    );
  }
}

// croner 每个模式解析一次即可复用；match 是纯计算、不启定时器，可安全缓存。
const patternCache = new Map<string, Cron>();
function cronFor(expr: string): Cron {
  let cron = patternCache.get(expr);
  if (!cron) {
    cron = new Cron(expr);
    patternCache.set(expr, cron);
  }
  return cron;
}

// 把 durable 任务持久化到磁盘。
export function saveDurableJobs(state: CronState): void {
  const durable = [...state.scheduledJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(state.durablePath, JSON.stringify(durable, null, 2));
}

// 注册一个 cron 任务，返回 CronJob 或错误字符串。
export function scheduleJob(
  state: CronState,
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  logger: SessionLogger,
): CronJob | string {
  try {
    cronFor(cron); // 构造抛错即非法，把错误信息回传给调用方
  } catch (e) {
    return errMsg(e);
  }
  const job: CronJob = {
    id: `cron_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    cron,
    prompt,
    recurring,
    durable,
  };
  state.scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs(state);
  logger.console(
    `  [cron register] ${job.id} '${cron}' → ${prompt.slice(0, 40)}`,
    "magenta",
  );
  return job;
}

// 移除一个 cron 任务。
export function cancelJob(
  state: CronState,
  jobId: string,
  logger: SessionLogger,
): string {
  const job = state.scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;
  state.scheduledJobs.delete(jobId);
  if (job.durable) saveDurableJobs(state);
  logger.console(`  [cron cancel] ${jobId}`, "red");
  return `Cancelled ${jobId}`;
}

// 单次扫描：把匹配当前时间的任务推进 cronQueue，一次性任务触发后即移除。
// 单个任务出错就地捕获，避免一个坏任务拖垮整个调度器。
export function runCronTick(
  state: CronState,
  now: Date,
  logger: SessionLogger,
): void {
  const pad = (n: number) => String(n).padStart(2, "0");
  // 含日期的标记，避免每日任务在第 2 天起被跳过。
  const minuteMarker =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // 秒清零：5 段 cron 是分钟粒度，抹掉秒让整分钟内任意时刻都能命中。
  // 匹配交给 croner（DOM/DOW 的 OR、步长/区间/列表都由库负责）；构造抛错即非法，
  // 由下方每个 job 的 try/catch 兜底（已注册任务都过了校验，实际到不了）。
  const atMinute = new Date(now);
  atMinute.setSeconds(0, 0);
  for (const job of [...state.scheduledJobs.values()]) {
    try {
      if (cronFor(job.cron).match(atMinute)) {
        if (state.lastFiredAt.get(job.id) !== minuteMarker) {
          state.cronQueue.push(job);
          state.lastFiredAt.set(job.id, minuteMarker);
          logger.console(
            `  [cron fire] ${job.id} → ${job.prompt.slice(0, 40)}`,
            "magenta",
          );
        }
        if (!job.recurring) {
          state.scheduledJobs.delete(job.id);
          if (job.durable) saveDurableJobs(state);
        }
      }
    } catch (e) {
      logger.console(`  [cron error] ${job.id}: ${errMsg(e)}`, "red");
    }
  }
}

// 拉起 1s 定时器（守护线程的 TS 版），unref 让 REPL 关闭时进程可退出。
export function startCronScheduler(
  state: CronState,
  logger: SessionLogger,
): NodeJS.Timeout {
  const timer = setInterval(() => runCronTick(state, new Date(), logger), 1000);
  timer.unref();
  return timer;
}

// 取出已触发的任务（agentLoop 调用），清空队列。
export function consumeCronQueue(state: CronState): CronJob[] {
  const fired = [...state.cronQueue];
  state.cronQueue.length = 0;
  return fired;
}

// 是否有已触发、等待投递的任务。
export function hasCronQueue(state: CronState): boolean {
  return state.cronQueue.length > 0;
}

// ── cron 工具 handler ─────────────────────────────────────

export function runScheduleCron(
  state: CronState,
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  logger: SessionLogger,
): string {
  const result = scheduleJob(state, cron, prompt, recurring, durable, logger);
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: '${cron}' → ${prompt}`;
}

export function runListCrons(state: CronState): string {
  const jobs = [...state.scheduledJobs.values()];
  if (!jobs.length) return "No cron jobs. Use schedule_cron to add one.";
  return jobs
    .map((j) => {
      const tag = j.recurring ? "recurring" : "one-shot";
      const dur = j.durable ? "durable" : "session";
      return `  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`;
    })
    .join("\n");
}

export function runCancelCron(
  state: CronState,
  jobId: string,
  logger: SessionLogger,
): string {
  return cancelJob(state, jobId, logger);
}

// cron handler 需要 cron 状态 + logger，用工厂闭包捕获，再与基础/任务 handler 合并。
export function makeCronHandlers(
  state: CronState,
  logger: SessionLogger,
): Handlers {
  return {
    schedule_cron: ({ cron, prompt, recurring, durable }) =>
      runScheduleCron(
        state,
        cron,
        prompt,
        recurring ?? true,
        durable ?? true,
        logger,
      ),
    list_crons: () => runListCrons(state),
    cancel_cron: ({ job_id }) => runCancelCron(state, job_id, logger),
  };
}

// ═══════════════════════════════════════════════════════════
//  s14 新增：cron 工具定义，叠加到 s13 的工具集之上
// ═══════════════════════════════════════════════════════════

const scheduleCronSchema = z.object({
  cron: z.string().describe("5-field cron expression"),
  prompt: z.string().describe("Message to inject when fired"),
  recurring: z.boolean().describe("True=recurring, False=one-shot").optional(),
  durable: z.boolean().describe("True=persist to disk").optional(),
});
const listCronsSchema = z.object({});
const cancelCronSchema = z.object({ job_id: z.string() });

const cronTools: Anthropic.Tool[] = [
  zodTool(
    "schedule_cron",
    "Schedule a cron job. cron is 5-field: min hour dom month dow.",
    scheduleCronSchema,
  ),
  zodTool("list_crons", "List all registered cron jobs.", listCronsSchema),
  zodTool("cancel_cron", "Cancel a cron job by ID.", cancelCronSchema),
];

// tools 以 s13（基础 + 任务 + bash 覆盖）为底，追加 3 个 cron 工具。
export const tools: Anthropic.Tool[] = [...s13Tools, ...cronTools];

// schema 表同理：以 s13 为底，追加 cron schema。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S13_TOOL_SCHEMAS,
  schedule_cron: scheduleCronSchema,
  list_crons: listCronsSchema,
  cancel_cron: cancelCronSchema,
};

// 合并后的工具名（基础 + 任务 + 后台 bash + cron），用于填 enabled_tools。
export const TOOL_NAMES: string[] = tools.map((t) => t.name);

// 复用 s12 的 memory/workspace 推导，只把 enabled_tools 换成含 cron 的完整列表，
// 这样 getSystemPrompt 组装出的「Available tools」也会带上 cron 工具。
export function updateContext(memoryIndex: string): Context {
  return { ...taskUpdateContext(memoryIndex), enabled_tools: TOOL_NAMES };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦 cron 调度（省略 s11 的错误恢复）
// ═══════════════════════════════════════════════════════════
// startCronScheduler 产出工作；startQueueProcessor 在有排队任务且无其他 agent
// 轮次运行时唤醒本循环；agentLoop 在循环开头消费 cron 队列并注入 messages。

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, memoryIndex, tasksDir, background, cron } = deps;
  let system = getSystemPrompt(context);
  // 基础工具（前台 bash / 文件工具）+ 任务工具 + cron 工具。
  const handlers: Handlers = {
    ...BASE_TOOL_HANDLERS,
    ...makeTaskHandlers(logger, tasksDir),
    ...makeCronHandlers(cron, logger),
  };

  while (true) {
    // Layer 4：消费已触发的 cron 任务，作为 user 消息注入。
    const fired = consumeCronQueue(cron);
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      logger.console(`  [inject cron] ${job.prompt.slice(0, 50)}`, "magenta");
    }

    logger.section(
      "SYSTEM PROMPT",
      `enabled_tools: ${JSON.stringify(Object.keys(handlers))}` +
        `\nworkspace: ${context.workspace}` +
        `\n\nBackgroundState:\n${JSON.stringify(background)}` +
        `\n\nCronState: ${cron.scheduledJobs.size} job(s), queue=${cron.cronQueue.length}`,
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
        const backgroundId = startBackgroundTask(
          background,
          handlers,
          block.name,
          block.id,
          input,
          logger,
        );
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

    // tool_result 块和后台通知一起放进同一条 user 消息。
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

  print("s14: Cron Scheduler — 独立定时器 + 队列处理器", "cyan");
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
  // 后台状态与 cron 状态各一份，跨轮复用。
  const background = new BackgroundState();
  const cron = new CronState();
  let context = updateContext(MEMORY_INDEX);

  // 启动时加载持久化任务，再拉起 1s 定时器。
  loadDurableJobs(cron, logger);
  startCronScheduler(cron, logger);
  logger.console("  [cron] scheduler timer started", "magenta");

  // agentBusy：单线程事件循环里 Python agent_lock 的等价物。
  let agentBusy = false;
  async function runAgentTurnLocked(userQuery?: string): Promise<void> {
    if (userQuery !== undefined) {
      history.push({ role: "user", content: userQuery });
    }
    const finalText = await agentLoop(history, context, {
      client,
      logger,
      memoryIndex: MEMORY_INDEX,
      background,
      cron,
    });
    context = updateContext(MEMORY_INDEX);
    print(finalText, "green");
    print();
  }

  // 队列处理器：cron 触发的任务在 agent 空闲时自动投递（200ms 轮询）。
  const queueProcessor = setInterval(async () => {
    if (!hasCronQueue(cron) || agentBusy) return;
    agentBusy = true;
    try {
      if (!hasCronQueue(cron)) return;
      logger.console(
        "\n  [queue processor] delivering scheduled work",
        "magenta",
      );
      await runAgentTurnLocked();
    } finally {
      agentBusy = false;
    }
  }, 200);
  queueProcessor.unref();
  logger.console("  [queue processor] started", "magenta");

  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s14 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    // 阻塞式获取锁：等队列处理器跑完当前一轮。
    while (agentBusy) await sleep(100);
    agentBusy = true;
    try {
      logger.userInput(query);
      await runAgentTurnLocked(query);
    } finally {
      agentBusy = false;
    }
  }
  rl.close();
}

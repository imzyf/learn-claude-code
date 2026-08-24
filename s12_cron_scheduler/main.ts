/**
 * s12_cron_scheduler/main.ts - Cron 调度器
 *
 * 按本地时间启动一轮 Agent Loop：定时器负责判断时间，队列负责解耦，
 * 队列处理器等 agent 空闲后再投递。
 *
 *     +--------------------+   09:00   +-----------------------+
 *     | 0 9 * * *          | --------> | [Scheduled] run tests |
 *     | prompt: run tests  |           +-----------+-----------+
 *     +--------------------+                       |
 *        scheduledJobs              cronQueue      | agent 空闲
 *                                                  v
 *                                          +-------------+
 *                                          | Agent Loop  |
 *                                          +-------------+
 *
 * 相比 s04 的变化：
 *   工具层与 hook 层直接复用，不再内联：tools / TOOL_SCHEMAS 复用 s02，
 *   TOOL_HANDLERS 复用 s03，hook 系统（loadHooks / HookSystem / Deps）复用 s04。
 *   这里不带 s10 的任务系统和 s11 的后台任务：本章传递的是一条待执行的 prompt，
 *   不是某个后台命令的执行结果。
 *   本文件只新增 cron 调度这一层：
 *   + CronJob 类型（id / cron / prompt / recurring / durable / pendingDelivery /
 *     lastFired）：pendingDelivery 表示已到期但模型还没接收，lastFired 防止同一
 *     分钟重复入队，两者都随 durable 任务落盘
 *   + CronState：scheduledJobs / cronQueue，由 session 持有、跨轮复用
 *   + cronFor：croner 模式的构造+缓存单一入口，匹配与校验都走它
 *     （DOM/DOW 的 OR 语义、步长/区间/取值范围都由库负责，不再手写字段匹配；
 *      只有 5 段这一条限制自己卡，因为 croner 也收 6/7 段；
 *      匹配内联进 runCronTick，校验靠构造抛错，均无需单独函数）
 *   + scheduleJob / cancelJob：注册/移除 cron 任务（带校验）
 *   + runCronTick：单次扫描，把到期任务推进 cronQueue（定时器每秒调用）
 *   + consumeCronQueue / hasCronQueue：agentLoop 与队列处理器读取触发结果
 *   + acknowledgeCronJobs / restoreCronJobs：至少一次交付的两端
 *   + makeCronHandlers + 3 个新工具：schedule_cron / list_crons / cancel_cron
 *   + agentLoop 在 s04 的基础上，进入循环前多一步「消费 cron 队列 -> 注入 messages」
 *
 * 四个层次：
 *   1. 调度器：1s 定时器检查时间 -> 到期任务进 cronQueue
 *   2. 队列：cronQueue 把调度器和 agent 循环解耦
 *   3. 队列处理器：有排队任务且 agent 空闲时唤醒 agent
 *   4. 消费者：agentLoop 消费排队任务，把它们注入 messages
 *
 * 交付语义为至少一次：任务先标记 pendingDelivery 落盘再进队列，模型成功接收后
 * 才销账（一次性任务此时删除，周期任务清 pendingDelivery）；模型调用失败则把注入
 * 的消息从会话里撤回、任务放回队列。进程若在接收后、销账落盘前退出，重启会重复交付。
 *
 * TS 特有说明：
 *   - Python 的守护线程 -> setInterval(...).unref() 定时器；REPL 关闭时进程可正常退出。
 *   - Python 的 agent_lock / threading.Lock -> agentBusy 布尔值（单线程事件循环，
 *     无需真锁）：用户输入阻塞等待它释放，队列处理器在它被占用时直接跳过
 *     （相当于 acquire(blocking=False)）。cron 状态的读写都在同一事件循环线程，
 *     调度器 tick 与 consumeCronQueue 天然互斥，也不需要 cron_lock。
 *   - Python 靠「不在主线程」判断定时回合、拒绝交互式批准；这里给定时回合单独装一套
 *     hook（confirm 直接拒绝），避免它和主终端抢 stdin。
 *   - cron 匹配/校验由 croner 库负责（new Cron(expr).match(date)）；无回调构造
 *     只解析、不启动定时器，模式实例按表达式缓存复用。轮询架构与 code.py 保持一致。
 *   - 提示符走 lib/terminal 的 createPrompt：等输入期间的异步输出先擦掉提示符行，
 *     输出完再连同已输入的内容重画到底部。
 *   - CronState 的 durablePath 必填：入口用 createCronState(import.meta.dirname)
 *     落到各自的 session 目录，测试传临时路径做隔离。
 *
 * 基于 s04（hooks）构建。Usage:
 *
 *     pnpm dev s12_cron_scheduler/main.ts
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { Cron } from "croner";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { createPrompt, print, printError } from "../lib/terminal";
import { hasToolUse, printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）+ errMsg + Handlers。
import {
  errMsg,
  type Handlers,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
  tools as s02Tools,
} from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）+ 权限确认抽象（Confirm / makeConfirm）。
import {
  type Confirm,
  makeConfirm,
  TOOL_HANDLERS,
} from "../s03_permission/main";
// 来自 s04：hook 系统（装配 + 触发）与 Deps（client + logger + hooks）。
import { loadHooks, type Deps as S04Deps } from "../s04_hooks/main";

const WORKDIR = process.cwd();
const SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
  `Use schedule_cron for work that should start at a future local time.`;

// deps 与 s04 一致，另加 cron：调度状态由 session 持有并跨轮传入。
export type Deps = S04Deps & { cron: CronState };

// ═══════════════════════════════════════════════════════════
//  s12 新增：cron 任务与调度状态
// ═══════════════════════════════════════════════════════════

// 持久化文件名；具体目录由 createCronState 决定。
export const DURABLE_FILE = ".scheduled_tasks.json";

export type CronJob = {
  id: string;
  cron: string; // "0 9 * * *"
  prompt: string; // 触发时注入的消息
  recurring: boolean; // true = 周期，false = 一次性
  durable: boolean; // true = 持久化到磁盘
  pendingDelivery: boolean; // 已到期、模型还没接收
  lastFired: string | null; // "YYYY-MM-DD HH:MM"，同分钟去重
};

// cron 生命周期状态：由 session 持有、跨轮复用（对齐 code.py 的模块全局）。
// durablePath 必填，避免不同 session 共用同一份磁盘状态。
export class CronState {
  // 已注册的任务，按 job.id 索引。
  scheduledJobs = new Map<string, CronJob>();
  // 已触发、等待投递给 agent 的任务（与 scheduledJobs 里的是同一批对象）。
  cronQueue: CronJob[] = [];
  constructor(public durablePath: string) {}
}

// 按 session 目录建 CronState，让每个 session 的 durable 任务落在自己目录下。
export function createCronState(sessionDir: string): CronState {
  return new CronState(path.join(sessionDir, DURABLE_FILE));
}

// croner 每个模式解析一次即可复用；match 是纯计算、不启定时器，可安全缓存。
const patternCache = new Map<string, Cron>();
// cronFor：构造 + 匹配 + 校验的单一入口，解析结果按表达式缓存复用。
// croner 本身也接受 6 段（带秒）和 7 段（带年）表达式，但 runCronTick 是分钟粒度、
// 匹配前会把秒清零，收下 `*/30 * * * * *` 只会每分钟触发一次。段数在进 croner 前
// 自己卡死，让模型拿到明确的错误，而不是一个被悄悄降级的任务。
function cronFor(expr: string): Cron {
  let cron = patternCache.get(expr);
  if (!cron) {
    const fields = expr.trim().split(/\s+/).length;
    if (fields !== 5) throw new Error(`Expected 5 fields, got ${fields}`);
    cron = new Cron(expr);
    patternCache.set(expr, cron);
  }
  return cron;
}

// 启动时从磁盘加载 durable 任务；损坏或非法的任务跳过。
// 上次退出时还挂着 pendingDelivery 的任务重新进队列，等 agent 空闲后再投递一次。
export function loadDurableJobs(state: CronState, logger: SessionLogger): void {
  if (!fs.existsSync(state.durablePath)) return;
  try {
    const jobs = JSON.parse(fs.readFileSync(state.durablePath, "utf8"));
    if (!Array.isArray(jobs)) throw new Error("expected a JSON array");
    let loaded = 0;
    for (const job of jobs as CronJob[]) {
      try {
        if (!job?.id?.startsWith("cron_")) throw new Error("invalid job ID");
        if (!job.prompt?.trim()) throw new Error("prompt cannot be empty");
        cronFor(job.cron); // 构造抛错即非法，跳过
      } catch (e) {
        printError(e, "  [cron] skipping invalid job");
        continue;
      }
      job.pendingDelivery = job.pendingDelivery ?? false;
      job.lastFired = job.lastFired ?? null;
      state.scheduledJobs.set(job.id, job);
      if (job.pendingDelivery) state.cronQueue.push(job);
      loaded += 1;
    }
    if (loaded)
      logger.console(`  [cron] loaded ${loaded} durable job(s)`, "magenta");
  } catch (e) {
    printError(e, "  [cron] failed to load durable jobs");
  }
}

// 把 durable 任务持久化到磁盘：先写临时文件再 rename，
// 避免写到一半崩溃时留下半个 JSON。
export function saveDurableJobs(state: CronState): void {
  const durable = [...state.scheduledJobs.values()].filter((j) => j.durable);
  const tmp = `${state.durablePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(durable, null, 2));
    fs.renameSync(tmp, state.durablePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ── Layer 1：调度器 ───────────────────────────────────────

// 拉起 1s 定时器（守护线程的 TS 版），unref 让 REPL 关闭时进程可退出。
export function startCronScheduler(
  state: CronState,
  logger: SessionLogger,
): NodeJS.Timeout {
  const timer = setInterval(() => runCronTick(state, new Date(), logger), 1000);
  // unref：定时器不算“活跃句柄”，REPL 关闭时进程能正常退出，不被它拖住。
  timer.unref();

  print("  [cron scheduler] timer started", "magenta");
  return timer;
}

// 单次扫描：把到期任务推进 cronQueue。一次性任务在这里保留注册，
// 等模型确认接收后才由 acknowledgeCronJobs 删除。
// 单个任务出错就地捕获，避免一个坏任务拖垮调度器。
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
      // 还没投递出去的任务不重复入队；同一分钟内也只入队一次。
      if (job.pendingDelivery || job.lastFired === minuteMarker) continue;
      if (!cronFor(job.cron).match(atMinute)) continue;
      enqueueDueJob(state, job, minuteMarker);
      logger.console(
        `  [cron push queue] ${job.id} -> ${job.prompt.slice(0, 40)}`,
        "magenta",
      );
    } catch (e) {
      printError(e, `  [cron error] ${job.id}`);
    }
  }
}

// 先把 pendingDelivery / lastFired 落盘，再把任务放进队列：
// 落盘失败就回滚字段并抛出，不让只存在于内存里的状态暴露给队列处理器。
function enqueueDueJob(
  state: CronState,
  job: CronJob,
  minuteMarker: string,
): void {
  const previous = { pending: job.pendingDelivery, lastFired: job.lastFired };
  job.pendingDelivery = true;
  job.lastFired = minuteMarker;
  try {
    if (job.durable) saveDurableJobs(state);
  } catch (e) {
    job.pendingDelivery = previous.pending;
    job.lastFired = previous.lastFired;
    throw e;
  }
  state.cronQueue.push(job);
}

// ── Layer 2：队列 ────────────────────────────────────────

// 取出已触发的任务（agentLoop 调用），清空队列。
// 任务此时仍带 pendingDelivery，要等 acknowledgeCronJobs 才销账。
export function consumeCronQueue(state: CronState): CronJob[] {
  const fired = [...state.cronQueue];
  state.cronQueue.length = 0;
  return fired;
}

// 是否有已触发、等待投递的任务。
export function hasCronQueue(state: CronState): boolean {
  return state.cronQueue.length > 0;
}

// 模型已成功接收注入的消息：一次性任务注销，周期任务清 pendingDelivery 等下次匹配。
// 落盘失败时把内存状态和队列一起回滚，宁可重复交付也不丢任务。
export function acknowledgeCronJobs(state: CronState, jobs: CronJob[]): void {
  const changed: CronJob[] = [];
  const removed: CronJob[] = [];
  for (const delivered of jobs) {
    const current = state.scheduledJobs.get(delivered.id);
    if (!current) continue; // 交付期间被 cancel_cron 取消
    changed.push(current);
    if (current.recurring) {
      current.pendingDelivery = false;
    } else {
      removed.push(current);
      state.scheduledJobs.delete(current.id);
    }
  }
  try {
    if (changed.some((job) => job.durable)) saveDurableJobs(state);
  } catch (e) {
    // 销账没落盘就当没销过：一次性任务重新注册，所有涉及的任务统一按待投递处理
    //（restoreCronJobs 会置回 pendingDelivery 并放回队列），宁可重复交付也不丢任务。
    for (const job of removed) state.scheduledJobs.set(job.id, job);
    restoreCronJobs(state, changed);
    throw e;
  }
}

// 模型调用失败：把已经取出的任务放回队列，下一轮重新投递。
export function restoreCronJobs(state: CronState, jobs: CronJob[]): void {
  const queued = new Set(state.cronQueue.map((job) => job.id));
  for (const delivered of jobs) {
    const current = state.scheduledJobs.get(delivered.id);
    if (!current) continue;
    current.pendingDelivery = true;
    if (!queued.has(current.id)) {
      state.cronQueue.push(current);
      queued.add(current.id);
    }
  }
}

// 多行展示 CronState（Map 无法直接 JSON.stringify，手写摘要）：列出每个已注册
// 任务的 id / 表达式 / 标志 / 上次触发 / prompt，再附带待投递队列。
export function cronStateSummary(state: CronState): string {
  const lines: string[] = [
    `  ${state.scheduledJobs.size} job(s), queue=${state.cronQueue.length}`,
  ];
  for (const job of state.scheduledJobs.values()) {
    const flags = [job.recurring ? "recurring" : "once"];
    if (job.durable) flags.push("durable");
    if (job.pendingDelivery) flags.push("pending");
    lines.push(
      `    ${job.id} '${job.cron}' [${flags.join(",")}] ` +
        `last=${job.lastFired ?? "never"} -> ${job.prompt.slice(0, 40)}`,
    );
  }
  if (state.cronQueue.length) {
    lines.push("  queued:");
    for (const job of state.cronQueue) {
      lines.push(`    ${job.id} -> ${job.prompt.slice(0, 40)}`);
    }
  }
  return lines.join("\n");
}

// ── 注册 / 取消 ──────────────────────────────────────────

// 随机 job ID，撞到已有 ID 就重取（对齐 code.py 的 secrets.token_hex(4)）。
function newCronId(state: CronState): string {
  for (let i = 0; i < 100; i += 1) {
    const id = `cron_${randomBytes(4).toString("hex")}`;
    if (!state.scheduledJobs.has(id)) return id;
  }
  throw new Error("Could not allocate a cron job ID");
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
  if (!prompt.trim()) return "Prompt cannot be empty";

  const job: CronJob = {
    id: newCronId(state),
    cron,
    prompt,
    recurring,
    durable,
    pendingDelivery: false,
    lastFired: null,
  };
  state.scheduledJobs.set(job.id, job);
  try {
    if (durable) saveDurableJobs(state);
  } catch (e) {
    // 落盘失败就撤销注册，让内存与磁盘保持一致。
    state.scheduledJobs.delete(job.id);
    return errMsg(e);
  }
  logger.console(
    `  [cron register] ${job.id} '${cron}' -> ${prompt.slice(0, 40)}`,
    "magenta",
  );
  return job;
}

// 移除一个 cron 任务，连同它排在队列里、还没投递的那一份。
export function cancelJob(
  state: CronState,
  jobId: string,
  logger: SessionLogger,
): string {
  const job = state.scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;

  const previousQueue = [...state.cronQueue];
  state.scheduledJobs.delete(jobId);
  state.cronQueue = state.cronQueue.filter((queued) => queued.id !== jobId);
  try {
    if (job.durable) saveDurableJobs(state);
  } catch (e) {
    state.scheduledJobs.set(jobId, job);
    state.cronQueue = previousQueue;
    return errMsg(e);
  }
  logger.console(`  [cron cancel] ${jobId}`, "red");
  return `Cancelled ${jobId}`;
}

// ── cron 工具 handler ─────────────────────────────────────

// schedule_cron 工具入口：包 scheduleJob，把结果或错误格式化成模型可读字符串。
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
  return `Scheduled ${result.id}: '${cron}' -> ${prompt}`;
}

// list_crons 工具入口：把已注册任务渲染成多行列表。
export function runListCrons(state: CronState): string {
  const jobs = [...state.scheduledJobs.values()];
  if (!jobs.length) return "No cron jobs. Use schedule_cron to add one.";
  return jobs
    .map((j) => {
      const tag = j.recurring ? "recurring" : "one-shot";
      const dur = j.durable ? "durable" : "session";
      return `  ${j.id}: '${j.cron}' -> ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`;
    })
    .join("\n");
}

// cancel_cron 工具入口：转发到 cancelJob。
export function runCancelCron(
  state: CronState,
  jobId: string,
  logger: SessionLogger,
): string {
  return cancelJob(state, jobId, logger);
}

// cron handler 需要 cron 状态 + logger，用工厂闭包捕获，再与 s03 的基础 handler 合并。
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
//  s12 新增：cron 工具定义，叠加到 s02 的工具集之上
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
    "Schedule a prompt with a 5-field cron expression: min hour dom month dow.",
    scheduleCronSchema,
  ),
  zodTool("list_crons", "List all registered cron jobs.", listCronsSchema),
  zodTool("cancel_cron", "Cancel a cron job by ID.", cancelCronSchema),
];

// tools 以 s02 的五个基础工具为底，追加 3 个 cron 工具。
export const tools: Anthropic.Tool[] = [...s02Tools, ...cronTools];

// schema 表同理：以 s02 为底，追加 cron schema。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
  schedule_cron: scheduleCronSchema,
  list_crons: listCronsSchema,
  cancel_cron: cancelCronSchema,
};

// ═══════════════════════════════════════════════════════════
//  工具执行 —— 和 s04 一样走 PreToolUse / PostToolUse
// ═══════════════════════════════════════════════════════════

export async function executeTool(
  block: Anthropic.ToolUseBlock,
  deps: Deps,
): Promise<string> {
  const { logger, hooks, cron } = deps;
  const blocked = await hooks.trigger("PreToolUse", block);
  if (blocked) return blocked;

  // 基础工具（s03 的 dispatch 表）+ 3 个 cron 工具。
  const handlers: Handlers = {
    ...TOOL_HANDLERS,
    ...makeCronHandlers(cron, logger),
  };
  const handler = handlers[block.name];
  const schema = TOOL_SCHEMAS[block.name];
  let output: string;
  if (!handler || !schema) {
    output = `Unknown: ${block.name}`;
  } else {
    try {
      output = handler(schema.parse(block.input));
    } catch (e) {
      output = `Error: ${errMsg(e)}`;
    }
  }
  logger.toolResult(block.name, output);

  await hooks.trigger("PostToolUse", block, output);
  return output;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s04 结构相同，只在开局多一步 cron 注入
// ═══════════════════════════════════════════════════════════
// 调度器产出工作；入口的队列处理器在有排队任务且 agent 空闲时唤醒本循环。
export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks, cron } = deps;

  // Layer 4：消费已触发的 cron 任务，作为 user 消息注入（每轮开头一次）。
  // scheduledStart 记住注入位置，模型调用失败时按它撤回。
  const fired = consumeCronQueue(cron);
  const scheduledStart = messages.length;
  for (const job of fired) {
    messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    logger.console(`  [inject cron] ${job.prompt.slice(0, 50)}`, "magenta");
  }
  let waitingForAck = fired;

  while (true) {
    logger.section("CRON STATE", cronStateSummary(cron));
    logger.request(messages, true);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        system: SYSTEM,
        messages,
        tools,
        max_tokens: 8000,
      });
    } catch (e) {
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      if (waitingForAck.length) {
        // 注入的 [Scheduled] 消息没被模型接收：撤回它们，任务放回队列重投。
        messages.length = scheduledStart;
        restoreCronJobs(cron, waitingForAck);
        return errText;
      }
      messages.push({ role: "assistant", content: errText });
      return errText;
    }
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });

    if (waitingForAck.length) {
      // 模型已经接收，销账；销账失败只记日志，任务会被重复投递而不是丢掉。
      try {
        acknowledgeCronJobs(cron, waitingForAck);
      } catch (e) {
        printError(e, "  [cron] acknowledgement failed");
      }
      waitingForAck = [];
    }

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

  print("s12: Cron Scheduler - 独立定时器 + 队列处理器", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });
  // 等输入期间，队列处理器 / cron 的输出都从提示符上方流过，不再顶掉它。
  const prompt = createPrompt(rl, "s12 >> ");

  const hooks = loadHooks(logger, makeConfirm(rl, logger));
  // 定时回合不能占用主终端问 y/N，需要确认的工具调用一律拒绝
  //（对应 code.py 里「不在主线程就拒绝交互式批准」）。
  const denyInteractive: Confirm = async (call, warning) => {
    logger.console(
      `  [permission] scheduled turn cannot ask: ${warning} ` +
        `(${call.name})`,
      "yellow",
    );
    return false;
  };
  const scheduledHooks = loadHooks(logger, denyInteractive);

  const history: Anthropic.MessageParam[] = [];
  // cron 状态一个 session 一份，跨轮复用。
  const cron = createCronState(import.meta.dirname);

  // 启动时加载持久化任务，再拉起 1s 定时器（Layer 1）。
  loadDurableJobs(cron, logger);
  startCronScheduler(cron, logger);

  // agentBusy：单线程事件循环里 Python agent_lock 的等价物。
  let agentBusy = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function runAgentTurn(
    turnHooks: typeof hooks,
    userQuery?: string,
  ): Promise<void> {
    if (userQuery !== undefined) {
      await turnHooks.trigger("UserPromptSubmit", userQuery);
      history.push({ role: "user", content: userQuery });
    }
    const finalText = await agentLoop(history, {
      client,
      logger,
      hooks: turnHooks,
      cron,
    });
    print(finalText, "green");
    print();
  }

  // Layer 3：队列处理器。它不判断时间，只看队列和 agent 是否空闲（200ms 轮询）。
  const queueProcessor = setInterval(async () => {
    if (!hasCronQueue(cron) || agentBusy) return;
    agentBusy = true;
    try {
      print("  [queue processor] delivering scheduled work", "magenta");
      await runAgentTurn(scheduledHooks);
    } catch (e) {
      printError(e);
    } finally {
      agentBusy = false;
    }
  }, 200);
  // unref：这个定时器不算“活跃句柄”，进程该退出时就退出，别被它拖住。
  queueProcessor.unref();
  print("  [queue processor] started", "magenta");

  while (true) {
    let query: string;
    try {
      query = await prompt.ask();
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
      await runAgentTurn(hooks, query);
    } catch (e) {
      printError(e);
    } finally {
      agentBusy = false;
    }
  }
  prompt.detach();
  rl.close();
}

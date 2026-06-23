/**
 * s08_context_compact/main.ts - 上下文压缩
 *
 * 在调用 LLM 之前插入四层压缩流水线：
 *
 *     L1: snipCompact       —— 消息数 > 50 时裁剪中间部分
 *     L2: microCompact      —— 用占位符替换较早的工具结果
 *     L3: toolResultBudget  —— 把大结果持久化到磁盘
 *     L4: compactHistory    —— LLM 完整摘要（1 次 API 调用）
 *
 *     应急：reactiveCompact —— API 仍返回 prompt_too_long 时触发
 *
 *     ┌─────────────────────────────────────────────────────────────┐
 *     │  messages[]                                                 │
 *     │    ↓                                                        │
 *     │  L3 budget ─→ L1 snip ─→ L2 micro ─→ [size > threshold?]   │
 *     │                                      ├─ No  → LLM          │
 *     │                                      └─ Yes → L4 summary   │
 *     │                                              ↓              │
 *     │                                          LLM call           │
 *     │                                    [prompt_too_long?]       │
 *     │                                      └─ Yes → reactive      │
 *     └─────────────────────────────────────────────────────────────┘
 *
 * 核心原则：先做便宜的，最后才做昂贵的。
 * 执行顺序与 CC 源码一致：budget → snip → micro → auto。
 *
 * 相比 s07 的变化：
 *   工具层：复用 s07 的三张表（base + todo + task + load_skill），只往「给 API 看」
 *          的 tools 列表追加一个 compact；schema/handler 表原样沿用 s07。
 *   Hook 层：hook 系统（触发器）复用 s04，默认 hook + nag 机制复用 s05，与 s07 一致。
 *   Subagent / Skill：spawnSubagent 复用 s06、技能层复用 s07，不再重复定义。
 *   + 压缩流水线（snip/micro/budget/auto + reactive）
 *   + compact 工具 —— 模型可以自己请求生成摘要（由 agentLoop 拦截，不走 handler 表）
 *
 * 一点需要注意：用压缩摘要替换历史记录后，不能再追加一个孤立的
 * tool_result（引用一个已经被摘要抹掉的 tool_use） —— 真实 API 会拒绝
 * 这种孤立的 tool_result，所以这里只用摘要本身继续推进循环。
 *
 * 基于 s07（skill loading）构建。Usage:
 *
 *     pnpm dev s08_context_compact/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s05：hook 装配（loadHooks = createHooks + registerDefaultHooks）+ nag 机制。
import {
  bumpNagCounter,
  loadHooks,
  nagIfStale,
  resetNagCounter,
} from "../s05_todo_write/main";
// 来自 s06：共享的 Deps 类型（client + logger）。
import type { Deps } from "../s06_subagent/main";
// 来自 s07：技能层 + LoopDeps + 装配好的三张工具表（base + todo + task + load_skill）。
// s08 只在 tools 列表上追加 compact，schema/handler 表原样复用。
import {
  buildSystem,
  type LoopDeps,
  loadSkills,
  SKILLS_DIR,
  tools as s07Tools,
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
} from "../s07_skill_loading/main";

// s08 导出自己拥有的东西：压缩流水线（L1~L4 + reactive）+ agentLoop。
// 复用来的符号（技能层 / spawnSubagent / permissionHook / nag）由测试各自从源头 import。

// 运行时产物落在 s08 文件夹下（同 logger 的 .log/）；SKILLS_DIR 复用 s07（仓库根目录的共享输入）。
const MODULE_DIR = import.meta.dirname;
const TRANSCRIPT_DIR = path.join(MODULE_DIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(MODULE_DIR, ".task_outputs", "tool-results");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  s08 新增：四层压缩流水线
// ═══════════════════════════════════════════════════════════

// 五个阈值启动时可用 COMPACT_* 环境变量覆盖（默认值见 defaults.env，
// 可复制到仓库根目录 .env，pnpm dev 会自动加载）。
// L1 裁剪阈值：消息数超过它就裁掉中间部分。
const SNIP_MAX_MESSAGES = Number(process.env.COMPACT_SNIP_MAX_MESSAGES ?? 50);
// L2 保留最近 N 条工具结果不动（最后一条消息整条不压），只压缩更早的。
const KEEP_RECENT = Number(process.env.COMPACT_KEEP_RECENT ?? 3);
// L3 预算：最新一轮 tool_result 总量超过它才开始落盘。
const TOOL_RESULT_BUDGET = Number(
  process.env.COMPACT_TOOL_RESULT_BUDGET ?? 200_000,
);
// L3 落盘阈值：单条工具结果超过该长度才值得写到磁盘。
const PERSIST_THRESHOLD = Number(
  process.env.COMPACT_PERSIST_THRESHOLD ?? 30_000,
);
// L4 触发阈值：估算大小（JSON 字符数，不是 token）超过它就做 LLM 摘要。
const CONTEXT_LIMIT = Number(process.env.COMPACT_CONTEXT_LIMIT ?? 50_000);

// 用 JSON 字符数估算上下文大小 —— 不是 token 数，但零成本，够做阈值判断。
export const estimateSize = (msgs: Anthropic.MessageParam[]): number =>
  JSON.stringify(msgs).length;

// 原地替换数组内容 —— 调用方持有同一个引用（对应 Python 的 `messages[:] = ...`）。
export function replaceMessages(
  messages: Anthropic.MessageParam[],
  next: Anthropic.MessageParam[],
): void {
  messages.splice(0, messages.length, ...next);
}

// 工具调用是携带 tool_use 内容块的 assistant 消息。
const messageHasToolCall = (m: Anthropic.MessageParam): boolean =>
  m.role === "assistant" &&
  Array.isArray(m.content) &&
  m.content.some((b) => b.type === "tool_use");

// tool_result 是携带 tool_result 内容块的 user 消息。
const isToolResultMessage = (m: Anthropic.MessageParam): boolean =>
  m.role === "user" &&
  Array.isArray(m.content) &&
  m.content.some((b) => typeof b !== "string" && b.type === "tool_result");

// 取 tool_result 的文本 —— content 可能是字符串或内容块数组，统一成字符串来量长度。
const outputText = (part: Anthropic.ToolResultBlockParam): string =>
  typeof part.content === "string"
    ? part.content
    : JSON.stringify(part.content);

// L1: snipCompact —— 裁剪中间消息，保留头 3 条，尾 (maxMessages - 3) 条
export function snipCompact(
  messages: Anthropic.MessageParam[],
  maxMessages: number,
  logger: SessionLogger,
): Anthropic.MessageParam[] {
  if (messages.length <= maxMessages) return messages;

  const keepHead = 3;
  const keepTail = maxMessages - 3;

  let headEnd = keepHead;
  let tailStart = messages.length - keepTail;
  // 头尾边界都不能把「工具调用 / 工具结果」这一对拆开。
  if (headEnd > 0 && messageHasToolCall(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd]))
      headEnd += 1;
  }
  // 取一条消息的单行内容预览 —— content 是字符串或内容块数组，压平成短文本。
  const messagePreview = (m: Anthropic.MessageParam): string => {
    const raw =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => {
              if (typeof b === "string") return b;
              if (b.type === "text") return b.text;
              if (b.type === "tool_use") return `[tool_use ${b.name}]`;
              if (b.type === "tool_result") return "[tool_result]";
              return `[${b.type}]`;
            })
            .join(" ");
    return raw.slice(0, 80).replace(/\s+/g, " ").trim();
  };

  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;

  // 被裁掉的每条消息记一行：索引 + 角色 + 内容预览。
  const removed = messages
    .slice(headEnd, tailStart)
    .map((m, i) => `- [${headEnd + i}] ${m.role}: ${messagePreview(m)}`);

  print(`[COMPACT L1] snip compact: ${snipped} messages removed`, "yellow");
  logger.section(
    `[COMPACT L1] snip compact (${snipped} removed)`,
    removed.join("\n"),
  );

  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}

// L2: microCompact —— 把较早的工具结果换成占位符
export function microCompact(
  messages: Anthropic.MessageParam[],
  logger: SessionLogger,
): Anthropic.MessageParam[] {
  const toolResults = collectToolResults(messages);
  // 最后一条消息可能是模型还没看到的最新一轮并行结果 —— 整条不压：
  // 保留数取 KEEP_RECENT 与它的块数中的较大值。
  const lastRound = collectToolResults(messages.slice(-1)).length;
  const keep = Math.max(KEEP_RECENT, lastRound);
  if (toolResults.length <= keep) return messages;

  // 最近 keep 条之外的长结果原地换成占位符（短结果不值得动）。
  const replaced: string[] = [];
  for (const part of toolResults.slice(0, -keep)) {
    if (typeof part.content === "string" && part.content.length > 120) {
      // tool_result 块上有啥记啥：id + 原长度 + 是否 error + 原内容开头预览。
      const flag = part.is_error ? " (error)" : "";
      const preview = part.content.slice(0, 80).replace(/\s+/g, " ").trim();
      replaced.push(
        `- ${part.tool_use_id}: ${part.content.length} chars${flag}\n    ${preview}…`,
      );
      part.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }

  if (replaced.length > 0) {
    print(
      `[COMPACT L2] micro compact: ${replaced.length} tool results replaced`,
      "yellow",
    );
    logger.section(
      `[COMPACT L2] micro compact (${replaced.length} replaced)`,
      replaced.join("\n"),
    );
  }

  return messages;
}
// 按出现顺序收集所有 tool_result 块 —— 返回原对象引用，调用方可原地修改。
export function collectToolResults(
  messages: Anthropic.MessageParam[],
): Anthropic.ToolResultBlockParam[] {
  const parts: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    // tool_result 只会出现在 content 为数组的 user 消息里，其余直接跳过。
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (typeof part !== "string" && part.type === "tool_result")
        parts.push(part);
    }
  }
  return parts;
}

// L3: toolResultBudget —— 把大结果持久化到磁盘
export function toolResultBudget(
  messages: Anthropic.MessageParam[],
  maxBytes: number,
  logger: SessionLogger,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  // 只看最后一条消息 —— 预算只管最新一轮的工具结果，更早的交给 L2。
  if (last?.role !== "user" || !Array.isArray(last.content)) return messages;

  // 取出本轮全部 tool_result 块。
  const blocks = last.content.filter(
    (b): b is Anthropic.ToolResultBlockParam =>
      typeof b !== "string" && b.type === "tool_result",
  );
  // 总量在预算内就什么都不做。
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;

  // 从最大的结果开始落盘，直到总量回到预算内。
  const ranked = [...blocks].sort(
    (a, b) => outputText(b).length - outputText(a).length,
  );
  // 每落盘一条记一行：id + 原长度。
  const persisted: string[] = [];
  for (const block of ranked) {
    if (total <= maxBytes) break;

    // 低于落盘阈值的块跳过 —— 写盘省不了多少空间。
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;

    // 原文写进磁盘，消息里只留文件路径 + 预览。
    block.content = persistLargeOutput(block.tool_use_id, content);
    persisted.push(`- ${block.tool_use_id}: ${content.length} chars → disk`);
    // 重新累计总量，回到预算内就停。
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }

  if (persisted.length > 0) {
    print(
      `[COMPACT L3] tool result budget: ${persisted.length} results persisted to disk`,
      "yellow",
    );
    logger.section(
      `[COMPACT L3] tool result budget (${persisted.length} persisted)`,
      persisted.join("\n"),
    );
  }

  return messages;
}
// 超长输出写到磁盘，返回「路径 + 预览」的占位文本；短输出原样返回。
export function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;

  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);

  // 模型看到路径和前 2000 字预览，需要全文时可自行读文件。
  return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

// L4: autoCompact —— LLM 完整摘要
export async function compactHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  const summary = await summarizeHistory(messages, deps);

  print(
    `[COMPACT L4] compact: ${messages.length} messages → summary (${summary.length} chars)`,
    "yellow",
  );
  deps.logger.section(
    `[COMPACT L4] compact (${messages.length} messages → ${summary.length} chars)`,
    `transcript archived: ${transcriptPath}`,
  );
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}
// 压缩前把完整历史落成 JSONL 存档 —— 信息只是移出上下文，并未真正丢失。
function writeTranscript(messages: Anthropic.MessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`,
  );
  fs.writeFileSync(
    filePath,
    `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );
  return filePath;
}
// 用一次独立的 API 调用把整段历史浓缩成结构化摘要。
export async function summarizeHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client } = deps;
  // 摘要是独立的子请求：用 child scope 打标记（同 s06 子 agent 的做法），
  // 日志里与主循环的 request/response 区分开，增量计数也互不干扰。
  const logger = deps.logger.child("compact");
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" +
    conversation;
  const request: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  logger.request(request, true);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 2000,
    messages: request,
  });

  logger.response(response);
  return textOf(response).trim() || "(empty summary)";
}

// 应急：reactiveCompact —— API 仍报 prompt_too_long 时触发
export async function reactiveCompact(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  // 与 L4 一样，先把完整历史落盘存档。
  writeTranscript(messages);
  // 保留最后 5 条消息原样，只摘要之前的部分。
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    // 尾部开头是 tool_result 时，把配对的 tool_use 一起留下，避免孤立引用。
    tailStart -= 1;
  }
  // 只对尾部之前的历史做 LLM 摘要。
  const summary = await summarizeHistory(messages.slice(0, tailStart), deps);

  deps.logger.console(
    `[COMPACT reactive] ${tailStart} messages summarized, ${messages.length - tailStart} kept`,
    "gray",
  );
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}

// ═══════════════════════════════════════════════════════════
//  工具装配：s07（base + todo + task + load_skill）+ compact
//  schema/handler 表原样复用 s07；compact 只加进「给 API 看」的 tools 列表，
//  由 agentLoop 拦截（它要重写整个 messages[]），不走 TOOL_HANDLERS 分发。
// ═══════════════════════════════════════════════════════════

const compactSchema = z.object({ focus: z.string().optional() });

const tools: Anthropic.Tool[] = [
  ...s07Tools,
  // s08 新增：compact（触发 compactHistory，不是空操作）
  zodTool(
    "compact",
    "Summarize earlier conversation to free context space.",
    compactSchema,
  ),
];

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s07 一样（nag 机制复用 s05，task/load_skill 自动分发），
//  s08 在其上包一层压缩：调 LLM 前跑三个预处理器 + 可选摘要，
//  compact 工具单独拦截，API 报超长时应急重试。
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1; // reactive compact 的重试上限

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, system, hooks } = deps;
  // 应急压缩（reactive）的连续使用次数，一次 API 调用成功即复位。
  let reactiveRetries = 0;
  while (true) {
    nagIfStale(messages, logger);

    // s08：三个预处理器（0 次 API 调用，先做便宜的）。顺序对齐 CC 源码：budget → snip → micro
    // L3: 先把大结果落盘
    replaceMessages(
      messages,
      toolResultBudget(messages, TOOL_RESULT_BUDGET, logger),
    );
    // L1: 裁剪中间
    replaceMessages(messages, snipCompact(messages, SNIP_MAX_MESSAGES, logger));
    // L2: 旧结果换占位符
    replaceMessages(messages, microCompact(messages, logger));

    // s08：仍超阈值 → LLM 摘要（1 次 API 调用）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      logger.console("[COMPACT L4] auto compact", "yellow");
      replaceMessages(messages, await compactHistory(messages, deps));
    }

    let response: Anthropic.Message;
    try {
      logger.request(messages, true);
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages,
        tools,
        max_tokens: 8000,
      });
      logger.response(response);
      reactiveRetries = 0; // API 调用成功即复位
    } catch (e) {
      const msg = errMsg(e).toLowerCase();
      // 只兜「上下文超长」这一类错误，且有重试上限；其他错误照常抛出。
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        logger.console("[COMPACT reactive] triggered", "yellow");
        // 摘要头部 + 保留尾部，替换历史后重试本次请求。
        replaceMessages(messages, await reactiveCompact(messages, deps));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

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
    // compact 工具会重写整个 messages[] —— 一旦触发，本轮剩余的 tool_result 全部作废。
    let didCompact = false;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }

      // s08：compact 工具用摘要重写整个历史。请求它的那次 tool_use 也会被摘要抹掉，
      // 所以不能再追加对应的 tool_result（会变成孤立引用，下一次请求被 API 拒绝）
      // —— 直接用摘要本身继续循环。
      if (block.name === "compact") {
        replaceMessages(messages, await compactHistory(messages, deps));
        didCompact = true;
        break; // 结束本轮，用压缩后的上下文重新开始
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
      // await —— task handler（spawnSubagent）是 async。
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await hooks.trigger("PostToolUse", block, output);

      if (block.name === "todo_write") resetNagCounter();

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    if (didCompact) continue;
    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
// Prompt example: Read the s01~s05 main.ts files README.md, then read code.py, then read s01_agent_loop/README.md
if (import.meta.main) {
  const client: ModelClient = createClient();
  const logger: SessionLogger = createLogger(import.meta.dirname);
  const skills = loadSkills(SKILLS_DIR, logger);
  const system = buildSystem(skills);

  logger.config({ model: MODEL_ID, system, tools });

  const hooks = loadHooks(logger);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print("s08: Context Compact — 四层压缩流水线，先便宜后昂贵", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s08 >> ", "cyan"));
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
      skills,
      system,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

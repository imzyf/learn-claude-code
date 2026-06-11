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
 *   + compact 工具——模型可以自己请求生成摘要（由 agentLoop 拦截，不走 handler 表）
 *
 * 一点需要注意：用压缩摘要替换历史记录后，不能再追加一个孤立的
 * tool_result（引用一个已经被摘要抹掉的 tool_use）——真实 API 会拒绝
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
// 来自 s04：hook 系统（触发器 + logger 注入）。
import { setHookLogger, triggerHooks } from "../s04_hooks/main";
// 来自 s05：默认 hook 注册 + nag 机制（nagIfStale / bumpNagCounter / resetNagCounter）。
import {
  bumpNagCounter,
  nagIfStale,
  registerDefaultHooks,
  resetNagCounter,
} from "../s05_todo_write/main";
// 来自 s06：共享的 Deps 类型（client + logger）。
import type { Deps } from "../s06_subagent/main";
// 来自 s07：技能层 + LoopDeps + 装配好的三张工具表（base + todo + task + load_skill）。
// s08 只在 tools 列表上追加 compact，schema/handler 表原样复用。
import {
  buildSystem,
  listSkills,
  type LoopDeps,
  scanSkills,
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
  tools as s07Tools,
} from "../s07_skill_loading/main";

// s08 导出自己拥有的东西：压缩流水线（L1~L4 + reactive）+ agentLoop。
// 复用来的符号（技能层 / spawnSubagent / permissionHook / nag）由测试各自从源头 import。

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  s08 新增：四层压缩流水线
// ═══════════════════════════════════════════════════════════

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30_000;

export const estimateSize = (msgs: Anthropic.MessageParam[]): number =>
  JSON.stringify(msgs).length;

// 原地替换数组内容——调用方持有同一个引用（对应 Python 的 `messages[:] = ...`）。
export function setMessages(
  messages: Anthropic.MessageParam[],
  next: Anthropic.MessageParam[],
): void {
  messages.splice(0, messages.length, ...next);
}

const messageHasToolCall = (m: Anthropic.MessageParam): boolean =>
  m.role === "assistant" &&
  Array.isArray(m.content) &&
  m.content.some((b) => b.type === "tool_use");

// tool_result 是携带 tool_result 内容块的 user 消息。
const isToolResultMessage = (m: Anthropic.MessageParam): boolean =>
  m.role === "user" &&
  Array.isArray(m.content) &&
  m.content.some((b) => typeof b !== "string" && b.type === "tool_result");

const outputText = (part: Anthropic.ToolResultBlockParam): string =>
  typeof part.content === "string"
    ? part.content
    : JSON.stringify(part.content);

// L1: snipCompact —— 裁剪中间消息，保留头尾
export function snipCompact(
  messages: Anthropic.MessageParam[],
  maxMessages = 50,
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
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}

// L2: microCompact —— 把较早的工具结果换成占位符
export function collectToolResults(
  messages: Anthropic.MessageParam[],
): Anthropic.ToolResultBlockParam[] {
  const parts: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (typeof part !== "string" && part.type === "tool_result")
        parts.push(part);
    }
  }
  return parts;
}

export function microCompact(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;
  for (const part of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content === "string" && part.content.length > 120) {
      part.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}

// L3: toolResultBudget —— 把大结果持久化到磁盘
export function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

export function toolResultBudget(
  messages: Anthropic.MessageParam[],
  maxBytes = 200_000,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return messages;
  const blocks = last.content.filter(
    (b): b is Anthropic.ToolResultBlockParam =>
      typeof b !== "string" && b.type === "tool_result",
  );
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort(
    (a, b) => outputText(b).length - outputText(a).length,
  );
  for (const block of ranked) {
    if (total <= maxBytes) break;
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;
    block.content = persistLargeOutput(block.tool_use_id, content);
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }
  return messages;
}

// L4: autoCompact —— LLM 完整摘要
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

export async function summarizeHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger } = deps;
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" +
    conversation;
  const request: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  logger.request(request);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 2000,
    messages: request,
  });
  logger.response(response);
  return textOf(response).trim() || "(empty summary)";
}

export async function compactHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  deps.logger.console(`[transcript saved: ${transcriptPath}]`, "gray");
  const summary = await summarizeHistory(messages, deps);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// 应急：reactiveCompact —— API 仍报 prompt_too_long 时触发
export async function reactiveCompact(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  writeTranscript(messages);
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  const summary = await summarizeHistory(messages.slice(0, tailStart), deps);
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
  const { client, logger, system } = deps;
  let reactiveRetries = 0;
  while (true) {
    nagIfStale(messages, logger);

    // s08：三个预处理器（0 次 API 调用，先做便宜的）。顺序对齐 CC 源码：budget → snip → micro
    setMessages(messages, toolResultBudget(messages)); // L3: 先把大结果落盘
    setMessages(messages, snipCompact(messages)); // L1: 裁剪中间
    setMessages(messages, microCompact(messages)); // L2: 旧结果换占位符

    // s08：仍超阈值 → LLM 摘要（1 次 API 调用）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      logger.console("[auto compact]", "yellow");
      setMessages(messages, await compactHistory(messages, deps));
    }

    let response: Anthropic.Message;
    try {
      logger.request(messages);
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
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        logger.console("[reactive compact]", "yellow");
        setMessages(messages, await reactiveCompact(messages, deps));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    bumpNagCounter();
    let didCompact = false;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }

      // s08：compact 工具用摘要重写整个历史。请求它的那次 tool_use 也会被摘要抹掉，
      // 所以不能再追加对应的 tool_result（会变成孤立引用，下一次请求被 API 拒绝）——
      // 直接用摘要本身继续循环。
      if (block.name === "compact") {
        setMessages(messages, await compactHistory(messages, deps));
        didCompact = true;
        break; // 结束本轮，用压缩后的上下文重新开始
      }

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
      // await —— task handler（spawnSubagent）是 async。
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await triggerHooks("PostToolUse", block, output);

      // todo_write 被调用即复位唠叨计数器。
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
// Prompt example: 让对话变长，观察四层压缩何时触发（或直接用 compact 工具）。
if (import.meta.main) {
  const client: ModelClient = createClient();
  const logger: SessionLogger = createLogger(import.meta.dirname);
  const skills = scanSkills(SKILLS_DIR);
  const system = buildSystem(skills);

  logger.config({ model: MODEL_ID, system, tools });
  // 启动时把技能清单单独记进 transcript，便于对照后续的 skill 加载事件。
  logger.section("SKILL CATALOG", listSkills(skills));

  setHookLogger(logger);
  registerDefaultHooks();

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
    await triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });

    const finalText = await agentLoop(history, {
      client,
      logger,
      skills,
      system,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

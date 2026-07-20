/**
 * s11_error_recovery/main.ts - 错误恢复
 *
 * 三条恢复路径 + 指数退避。
 *
 * 相比 s10 的变化：
 *   工具层、prompt 组装、context 推导全部直接复用，不再内联：
 *     tools / TOOL_SCHEMAS 复用 s02，TOOL_HANDLERS 复用 s03，
 *     getSystemPrompt / updateContext / Context 复用 s10。
 *   本文件只新增错误恢复这一层：
 *   + LLM 调用被 try/catch 包裹，带三条恢复路径
 *   + 路径 1：max_tokens -> 升级 8K->64K（第一次升级不追加内容），
 *             再不行就用续写 prompt（最多 3 次）
 *   + 路径 2：prompt_too_long -> 应急压缩 -> 重试（一次）
 *   + 路径 3：429/529 -> 带抖动的指数退避（最多 10 次），
 *             连续 529 时切换到备用模型
 *   + withRetry 包装器处理瞬时错误
 *   + RecoveryState 跟踪升级 / 压缩 / 529 / 模型状态
 *
 * ASCII 流程：
 *   messages -> prompt assembly -> [try] LLM [catch] -> tools -> loop
 *                                    |          |
 *                              stop_reason    error type
 *                              "max_tokens"?  prompt_too_long? -> compact
 *                              escalate /     429/529? -> backoff
 *                              continue       other? -> log + exit
 *
 * TS 特有说明：
 *   - client.messages.create 默认会自己重试 429/529；per-request
 *     `maxRetries: 0` 是为了让本文件教学用的重试层成为唯一一层
 *   - FALLBACK_MODEL_ID 环境变量用来选择 529 时的备用模型
 *
 * Usage:
 *     pnpm dev s11_error_recovery/main.ts
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf } from "../lib/tools";
// 来自 s02：tool 定义 + schema 表。
import { TOOL_SCHEMAS, tools } from "../s02_tool_use/main";
// 来自 s03：不含权限检查的基础 dispatch 表。
import { TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：默认记忆索引路径，s10 也复用同一份，不再各自拼接。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：运行时组装 + 缓存的 system prompt，及依据真实状态推导的 context。
import {
  type Context,
  getSystemPrompt,
  updateContext,
} from "../s10_system_prompt/main";

const PRIMARY_MODEL = MODEL_ID;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// deps 与 s10 一致，另加 memoryIndex（每轮工具后重新推导 context）。
export type Deps = { client: ModelClient; logger: SessionLogger };
export type LoopDeps = Deps & { memoryIndex: string };

// ── 常量 ──
// max_tokens 升级后的上限（首次撞上限时升到这里）。
const ESCALATED_MAX_TOKENS = 64_000;
// 每次请求的初始 max_tokens。
const DEFAULT_MAX_TOKENS = 8000;
// 64K 仍被截断时，续写 prompt 的最多次数。
const MAX_RECOVERY_RETRIES = 3;
// withRetry 对瞬时错误（429/529）的最多重试次数。
const MAX_RETRIES = 10;
// 指数退避的基准延迟（毫秒）。
const BASE_DELAY_MS = 500;
// 连续多少次 529 就切换到备用模型。
const MAX_CONSECUTIVE_529 = 3;
// 续写提示：让模型从截断处直接接着写，不要道歉/重述。
const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.";

// ═══════════════════════════════════════════════════════════
//  s11 新增：错误恢复
// ═══════════════════════════════════════════════════════════

// 跨循环跟踪恢复尝试的状态。
export class RecoveryState {
  // 是否已把 max_tokens 从 8K 升到 64K（只升一次）。
  hasEscalated = false;
  // 已用掉的续写次数。
  recoveryCount = 0;
  // 连续 529 计数，任一次成功即清零。
  consecutive529 = 0;
  // 是否已做过一次应急压缩（只做一次）。
  hasAttemptedReactiveCompact = false;
  // 当前使用的模型，初始为 PRIMARY_MODEL，连续 529 时切换到 FALLBACK_MODEL。
  currentModel = PRIMARY_MODEL;
}

// 带抖动的指数退避（秒）；Retry-After 优先。
export function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter;
  // 指数退避 + 25% 抖动，最大 32 秒。
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32_000) / 1000;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

// Anthropic SDK 的 APIError 带 status；取不到时下面兜底看错误文本。
export function errorStatus(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * 瞬时错误（429/529）的指数退避。
 * 非瞬时错误重新抛出，交给外层处理。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  state: RecoveryState,
  logger: SessionLogger,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e) {
      const name = e instanceof Error ? e.name.toLowerCase() : "";
      const msg = errMsg(e).toLowerCase();
      const status = errorStatus(e);

      // 429 限流 -> 指数退避
      if (status === 429 || name.includes("ratelimit") || msg.includes("429")) {
        const delay = retryDelay(attempt);
        logger.console(
          `  [429 rate limit] retry ${attempt + 1}/${MAX_RETRIES},` +
            ` wait ${delay.toFixed(1)}s`,
          "yellow",
        );
        await sleep(delay * 1000);
        continue;
      }

      // 529 过载 -> 指数退避 + 切备用模型
      if (
        status === 529 ||
        name.includes("overloaded") ||
        msg.includes("overloaded") ||
        msg.includes("529")
      ) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
          if (FALLBACK_MODEL) {
            state.currentModel = FALLBACK_MODEL;
            state.consecutive529 = 0;
            logger.console(
              `  [529 x${MAX_CONSECUTIVE_529}] switching to ${FALLBACK_MODEL}`,
              "red",
            );
          } else {
            state.consecutive529 = 0;
            logger.console(
              `  [529 x${MAX_CONSECUTIVE_529}]` +
                ` no FALLBACK_MODEL_ID configured, continuing retry`,
              "red",
            );
          }
        }
        const delay = retryDelay(attempt);
        logger.console(
          `  [529 overloaded] retry ${attempt + 1}/${MAX_RETRIES},` +
            ` wait ${delay.toFixed(1)}s`,
          "yellow",
        );
        await sleep(delay * 1000);
        continue;
      }

      // 非瞬时错误 -> 重新抛出，交给外层 try/catch
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

// 判断 API 错误是否属于「prompt/上下文过长」。
export function isPromptTooLongError(e: unknown): boolean {
  const msg = errMsg(e).toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window")
  );
}

/**
 * 应急压缩 —— 教学版只保留最后 N 条消息。
 * 真实 CC 会用 LLM 生成压缩摘要再重试；这里简化为只留尾部，
 * 因为基于 LLM 的压缩在 s08/s09 已经讲过。
 */
export function reactiveCompact(
  messages: Anthropic.MessageParam[],
  logger: SessionLogger,
): Anthropic.MessageParam[] {
  logger.console("  [reactive compact] trimming to last 5 messages", "red");
  const tail = messages.slice(-5);
  return [
    {
      role: "user",
      content:
        "[Reactive compact] Earlier conversation trimmed. Continue from where you left off.",
    },
    ...tail,
  ];
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 用错误恢复包裹 LLM 调用
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, memoryIndex } = deps;
  let system = getSystemPrompt(context);

  // 错误恢复状态
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    // ── LLM 调用：withRetry 处理 429/529，外层处理其余错误 ──
    const callLLM = () =>
      client.messages.create(
        {
          model: state.currentModel,
          system,
          messages,
          tools,
          max_tokens: maxTokens,
        },
        { maxRetries: 0 }, // 退避由上面的 withRetry 负责，不交给 SDK
      );

    logger.request(messages, true);
    let result: Anthropic.Message;
    try {
      result = await withRetry(callLLM, state, logger);
    } catch (e) {
      // 路径 2：prompt_too_long -> 应急压缩（一次）
      if (isPromptTooLongError(e)) {
        if (!state.hasAttemptedReactiveCompact) {
          messages.splice(
            0,
            messages.length,
            ...reactiveCompact(messages, logger),
          );
          state.hasAttemptedReactiveCompact = true;
          continue;
        }
        logger.console("  [unrecoverable] still too long after compact", "red");
        const errText = "[Error] Context too large, cannot continue.";
        messages.push({ role: "assistant", content: errText });
        return errText;
      }

      // 无法恢复
      const name = e instanceof Error ? e.name : "Error";
      logger.console(
        `  [unrecoverable] ${name}: ${errMsg(e).slice(0, 100)}`,
        "red",
      );
      const errText = `[Error] ${name}: ${errMsg(e).slice(0, 200)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }
    logger.response(result);

    // ── 路径 1：max_tokens（stop_reason "max_tokens"）-> 升级或续写 ──
    if (result.stop_reason === "max_tokens") {
      // 第一次升级：不追加被截断的输出，原样重试本次请求
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        logger.console(
          `  [max_tokens] escalating ${DEFAULT_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}`,
          "yellow",
        );
        continue;
      }
      // 64K 仍被截断：保存截断输出 + 续写 prompt
      messages.push({ role: "assistant", content: result.content });
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount += 1;
        logger.console(
          `  [max_tokens] continuation ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}`,
          "yellow",
        );
        continue;
      }
      logger.console("  [max_tokens] recovery limit reached", "red");
      return textOf(result);
    }

    // 正常结束：追加 assistant 回复
    messages.push({ role: "assistant", content: result.content });
    if (result.stop_reason !== "tool_use") {
      return textOf(result);
    }

    // ── 工具执行 ──
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of result.content) {
      printProse(block);
      if (block.type !== "tool_use") {
        continue;
      }

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    context = updateContext(memoryIndex);
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, tools });

  print("s11: Error Recovery — 三条恢复路径 + 指数退避", "cyan");
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
  let context = updateContext(MEMORY_INDEX);
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
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, context, {
      client,
      logger,
      memoryIndex: MEMORY_INDEX,
    });
    context = updateContext(MEMORY_INDEX);
    print(finalText, "green");
    print();
  }
  rl.close();
}

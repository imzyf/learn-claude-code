/**
 * s11_error_recovery/main.ts - 错误恢复
 *
 * 三条恢复路径 + 指数退避。
 *
 * 相比 s10 的变化：
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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";

const client = createClient();

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const PRIMARY_MODEL = MODEL_ID;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 常量 ──

const ESCALATED_MAX_TOKENS = 64_000;
const DEFAULT_MAX_TOKENS = 8000;
const MAX_RECOVERY_RETRIES = 3;
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;
const MAX_CONSECUTIVE_529 = 3;
const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.";

// ═══════════════════════════════════════════════════════════
//  来自 s10（同步）：Prompt 组装
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

type Context = {
  enabled_tools: string[];
  workspace: string;
  memories: string;
};

function assembleSystemPrompt(context: Context): string {
  const sections = [
    PROMPT_SECTIONS.identity,
    PROMPT_SECTIONS.tools,
    PROMPT_SECTIONS.workspace,
  ];
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }
  return sections.join("\n\n");
}

let lastContextKey: string | null = null;
let lastPrompt: string | null = null;

const contextKey = (context: Context): string =>
  JSON.stringify(context, Object.keys(context).sort());

function getSystemPrompt(context: Context): string {
  const key = contextKey(context);
  if (key === lastContextKey && lastPrompt) {
    print("  [cache hit] system prompt unchanged", "gray");
    return lastPrompt;
  }
  lastContextKey = key;
  lastPrompt = assembleSystemPrompt(context);

  const loaded = ["identity", "tools", "workspace"];
  if (context.memories) loaded.push("memory");
  print(`  [assembled] sections: ${loaded.join(", ")}`, "green");
  return lastPrompt;
}

// ═══════════════════════════════════════════════════════════
//  来自 s02（原样复用）：基础工具
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
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

function runRead(p: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    if (limit && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({
  path: z.string(),
  limit: z.number().int().optional(),
});
const writeSchema = z.object({ path: z.string(), content: z.string() });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
};

const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
};

// ═══════════════════════════════════════════════════════════
//  s11 新增：错误恢复
// ═══════════════════════════════════════════════════════════

// 跨循环跟踪恢复尝试的状态。
class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel = PRIMARY_MODEL;
}

// 带抖动的指数退避（秒）；Retry-After 优先。
function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32_000) / 1000;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

// Anthropic SDK 的 APIError 带 status；取不到时下面兜底看错误文本。
function errorStatus(e: unknown): number | undefined {
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
async function withRetry<T>(
  fn: () => Promise<T>,
  state: RecoveryState,
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
        print(
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
            print(
              `  [529 x${MAX_CONSECUTIVE_529}] switching to ${FALLBACK_MODEL}`,
              "red",
            );
          } else {
            state.consecutive529 = 0;
            print(
              `  [529 x${MAX_CONSECUTIVE_529}]` +
                ` no FALLBACK_MODEL_ID configured, continuing retry`,
              "red",
            );
          }
        }
        const delay = retryDelay(attempt);
        print(
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
function isPromptTooLongError(e: unknown): boolean {
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
function reactiveCompact(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  print("  [reactive compact] trimming to last 5 messages", "red");
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

// ── Context ──

// 由真实状态推导 context：有哪些工具、记忆文件是否存在。
function updateContext(): Context {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf8").trim();
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 用错误恢复包裹 LLM 调用
// ═══════════════════════════════════════════════════════════

async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
): Promise<string> {
  let system = getSystemPrompt(context);
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
    let result: Awaited<ReturnType<typeof callLLM>>;
    try {
      result = await withRetry(callLLM, state);
    } catch (e) {
      // 路径 2：prompt_too_long -> 应急压缩（一次）
      if (isPromptTooLongError(e)) {
        if (!state.hasAttemptedReactiveCompact) {
          messages.splice(0, messages.length, ...reactiveCompact(messages));
          state.hasAttemptedReactiveCompact = true;
          continue;
        }
        print("  [unrecoverable] still too long after compact", "red");
        const errText = "[Error] Context too large, cannot continue.";
        messages.push({ role: "assistant", content: errText });
        return errText;
      }

      // 无法恢复
      const name = e instanceof Error ? e.name : "Error";
      print(`  [unrecoverable] ${name}: ${errMsg(e).slice(0, 100)}`, "red");
      const errText = `[Error] ${name}: ${errMsg(e).slice(0, 200)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }

    // ── 路径 1：max_tokens（stop_reason "max_tokens"）-> 升级或续写 ──
    if (result.stop_reason === "max_tokens") {
      // 第一次升级：不追加被截断的输出，原样重试本次请求
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        print(
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
        print(
          `  [max_tokens] continuation ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}`,
          "yellow",
        );
        continue;
      }
      print("  [max_tokens] recovery limit reached", "red");
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
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }
      print(`> ${block.name}`, "cyan");
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      print(output.slice(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
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
let context = updateContext();
while (true) {
  let query: string;
  try {
    query = await rl.question(colorize("s11 >> ", "cyan"));
  } catch {
    break; // stdin 关闭（Ctrl+D）
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  print(finalText, "green");
  print();
}
rl.close();

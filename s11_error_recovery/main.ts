/**
 * s11_error_recovery/main.ts - Error Recovery
 *
 * Three recovery paths + exponential backoff.
 *
 * Changes from s10:
 *   + LLM call wrapped in try/catch with three recovery paths
 *   + Path 1: max_tokens -> escalate 8K->64K (no append on first escalation),
 *             then continuation prompt (max 3)
 *   + Path 2: prompt_too_long -> reactive compact -> retry (once)
 *   + Path 3: 429/529 -> exponential backoff with jitter (max 10),
 *             fallback model on consecutive 529
 *   + withRetry wrapper for transient errors
 *   + RecoveryState tracks escalation / compact / 529 / model
 *
 * ASCII flow:
 *   messages -> prompt assembly -> [try] LLM [catch] -> tools -> loop
 *                                    |          |
 *                              finishReason   error type
 *                              "length"?      prompt_too_long? -> compact
 *                              escalate /     429/529? -> backoff
 *                              continue       other? -> log + exit
 *
 * TS-specific notes:
 *   - Anthropic's stop_reason "max_tokens" surfaces as finishReason "length"
 *   - generateText retries 429/529 itself by default; maxRetries: 0 keeps
 *     this teaching retry layer the only one
 *   - FALLBACK_MODEL_ID env selects the 529 fallback model
 *
 * Usage:
 *     pnpm dev s11_error_recovery/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { anthropic, MODEL_ID } from "../lib/model";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const PRIMARY_MODEL = MODEL_ID;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Constants ──

const ESCALATED_MAX_TOKENS = 64_000;
const DEFAULT_MAX_TOKENS = 8000;
const MAX_RECOVERY_RETRIES = 3;
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;
const MAX_CONSECUTIVE_529 = 3;
const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.";

// ═══════════════════════════════════════════════════════════
//  FROM s10 (synced): Prompt Assembly
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
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
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
    console.log("  \x1b[90m[cache hit] system prompt unchanged\x1b[0m");
    return lastPrompt;
  }
  lastContextKey = key;
  lastPrompt = assembleSystemPrompt(context);

  const loaded = ["identity", "tools", "workspace"];
  if (context.memories) loaded.push("memory");
  console.log(`  \x1b[32m[assembled] sections: ${loaded.join(", ")}\x1b[0m`);
  return lastPrompt;
}

// ═══════════════════════════════════════════════════════════
//  FROM s02 (unchanged): Basic tools
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
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
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

const tools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({ path: z.string(), limit: z.number().int().optional() }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
};

const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
};

// ═══════════════════════════════════════════════════════════
//  NEW in s11: Error Recovery
// ═══════════════════════════════════════════════════════════

// Track recovery attempts across the loop.
class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel = PRIMARY_MODEL;
}

// Exponential backoff with jitter (seconds). Retry-After takes priority.
function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32_000) / 1000;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

// AI SDK APICallError carries statusCode; fall back to message text below.
function errorStatus(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "statusCode" in e) {
    const s = (e as { statusCode?: unknown }).statusCode;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * Exponential backoff for transient errors (429/529).
 * Non-transient errors are re-thrown for the outer handler.
 */
async function withRetry<T>(fn: () => Promise<T>, state: RecoveryState): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e) {
      const name = e instanceof Error ? e.name.toLowerCase() : "";
      const msg = errMsg(e).toLowerCase();
      const status = errorStatus(e);

      // 429 rate limit -> exponential backoff
      if (status === 429 || name.includes("ratelimit") || msg.includes("429")) {
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[429 rate limit] retry ${attempt + 1}/${MAX_RETRIES},` +
            ` wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay * 1000);
        continue;
      }

      // 529 overloaded -> exponential backoff + fallback model
      if (status === 529 || name.includes("overloaded") || msg.includes("overloaded") || msg.includes("529")) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
          if (FALLBACK_MODEL) {
            state.currentModel = FALLBACK_MODEL;
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] switching to ${FALLBACK_MODEL}\x1b[0m`,
            );
          } else {
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}]` +
                ` no FALLBACK_MODEL_ID configured, continuing retry\x1b[0m`,
            );
          }
        }
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[529 overloaded] retry ${attempt + 1}/${MAX_RETRIES},` +
            ` wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay * 1000);
        continue;
      }

      // Not transient -> re-throw for outer try/catch
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

// Check whether an API error indicates prompt/context too long.
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
 * Emergency compact — teaching version keeps last N messages.
 * Real CC generates a compact summary via LLM, then retries with
 * the compacted message list. Teaching version simplifies to tail
 * retention since s08/s09 already cover LLM-based compact.
 */
function reactiveCompact(messages: ModelMessage[]): ModelMessage[] {
  console.log("  \x1b[31m[reactive compact] trimming to last 5 messages\x1b[0m");
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

// Derive context from real state: which tools exist, whether memory files exist.
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
//  agentLoop — error recovery wrapping LLM calls
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: ModelMessage[], context: Context): Promise<string> {
  let system = getSystemPrompt(context);
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    // ── LLM call: withRetry handles 429/529, outer handles rest ──
    const callLLM = () =>
      generateText({
        model: anthropic(state.currentModel),
        system,
        messages,
        tools,
        maxOutputTokens: maxTokens,
        maxRetries: 0, // withRetry above owns backoff, not the SDK
      });
    let result: Awaited<ReturnType<typeof callLLM>>;
    try {
      result = await withRetry(callLLM, state);
    } catch (e) {
      // Path 2: prompt_too_long -> reactive compact (once)
      if (isPromptTooLongError(e)) {
        if (!state.hasAttemptedReactiveCompact) {
          messages.splice(0, messages.length, ...reactiveCompact(messages));
          state.hasAttemptedReactiveCompact = true;
          continue;
        }
        console.log("  \x1b[31m[unrecoverable] still too long after compact\x1b[0m");
        const errText = "[Error] Context too large, cannot continue.";
        messages.push({ role: "assistant", content: errText });
        return errText;
      }

      // Unrecoverable
      const name = e instanceof Error ? e.name : "Error";
      console.log(`  \x1b[31m[unrecoverable] ${name}: ${errMsg(e).slice(0, 100)}\x1b[0m`);
      const errText = `[Error] ${name}: ${errMsg(e).slice(0, 200)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }

    // ── Path 1: max_tokens (finishReason "length") -> escalate or continue ──
    if (result.finishReason === "length") {
      // First escalation: don't append truncated output, retry same request
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(
          `  \x1b[33m[max_tokens] escalating ${DEFAULT_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}\x1b[0m`,
        );
        continue;
      }
      // 64K still truncated: save truncated output + continuation prompt
      messages.push(...result.response.messages);
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount += 1;
        console.log(
          `  \x1b[33m[max_tokens] continuation ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}\x1b[0m`,
        );
        continue;
      }
      console.log("  \x1b[31m[max_tokens] recovery limit reached\x1b[0m");
      return result.text;
    }

    // Normal completion: append assistant response
    messages.push(...result.response.messages);
    if (result.finishReason !== "tool-calls") {
      return result.text;
    }

    // ── Tool execution ──
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);
      const handler = TOOL_HANDLERS[call.toolName];
      const output = handler ? handler(call.input) : `Unknown: ${call.toolName}`;
      console.log(output.slice(0, 200));
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }
    messages.push({ role: "tool", content: results });

    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── Entry point ──────────────────────────────────────────
console.log("s11: error recovery");
console.log("输入问题，回车发送。输入 q 退出。\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

const history: ModelMessage[] = [];
let context = updateContext();
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms11 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history, context);
  context = updateContext();
  console.log(finalText);
  console.log();
}
rl.close();

/**
 * s10_system_prompt/main.ts - System Prompt
 *
 * Runtime prompt assembly with caching.
 *
 * Changes from s09:
 *   + PROMPT_SECTIONS: topic-keyed record of prompt fragments
 *   + assembleSystemPrompt(context): select + join sections by real state
 *   + getSystemPrompt(context): deterministic cache via stable JSON key
 *   + agentLoop uses getSystemPrompt(context) instead of hardcoded SYSTEM
 *
 * Memory section loads when .memory/MEMORY.md exists (real state, not keywords).
 *
 * Usage:
 *     pnpm dev s10_system_prompt/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { model } from "../lib/model";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  NEW in s10: Prompt Sections
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

// Select and join prompt sections based on current context.
function assembleSystemPrompt(context: Context): string {
  const sections: string[] = [];

  // Always loaded — identity, tools, workspace
  sections.push(PROMPT_SECTIONS.identity);
  sections.push(PROMPT_SECTIONS.tools);
  sections.push(PROMPT_SECTIONS.workspace);

  // Conditional — memory loaded when MEMORY.md exists and has content
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }

  return sections.join("\n\n");
}

let lastContextKey: string | null = null;
let lastPrompt: string | null = null;

// JSON.stringify keeps insertion order; passing a sorted key array makes the
// serialization deterministic (the TS analog of Python's
// json.dumps(sort_keys=True) — and unlike hashing object identity, it
// survives rebuilt-but-equal contexts).
const contextKey = (context: Context): string =>
  JSON.stringify(context, Object.keys(context).sort());

/**
 * Cache wrapper — reassemble only when context changes.
 *
 * This cache only avoids redundant string assembly within a process.
 * Real Claude Code additionally protects API-level prompt cache via
 * stable section ordering and SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
 */
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
//  NEW in s10: Context — real state, not keyword guessing
// ═══════════════════════════════════════════════════════════

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
//  agentLoop — uses assembled system prompt instead of hardcoded SYSTEM
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: ModelMessage[], context: Context): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
    const result = await generateText({
      model,
      system,
      messages,
      tools,
      maxOutputTokens: 8000,
    });
    messages.push(...result.response.messages);
    if (result.finishReason !== "tool-calls") {
      return result.text;
    }

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

    // Re-evaluate context and prompt after each tool round
    context = updateContext();
    system = getSystemPrompt(context);
  }
}

// ── Entry point ──────────────────────────────────────────
console.log("s10: system prompt — runtime assembly");
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
    query = await rl.question("\x1b[36ms10 >> \x1b[0m");
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

/**
 * s10_system_prompt/main.ts - System Prompt
 *
 * 运行时按需组装 prompt，并带缓存。
 *
 * 相比 s09 的变化：
 *   + PROMPT_SECTIONS：按主题分类的 prompt 片段集合
 *   + assembleSystemPrompt(context)：根据真实状态挑选并拼接各片段
 *   + getSystemPrompt(context)：用稳定的 JSON key 做确定性缓存
 *   + agentLoop 改用 getSystemPrompt(context)，不再用写死的 SYSTEM
 *
 * 记忆片段只在 .memory/MEMORY.md 存在时才加载（依据真实状态，而非关键词）。
 *
 * Usage:
 *     pnpm dev s10_system_prompt/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { client, MODEL_ID } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";

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

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
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

async function agentLoop(messages: Anthropic.MessageParam[], context: Context): Promise<string> {
  let system = getSystemPrompt(context);
  while (true) {
    const response = await client.messages.create({
      model: MODEL_ID,
      system,
      messages,
      tools,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output = handler && schema ? handler(schema.parse(block.input)) : `Unknown: ${block.name}`;
      console.log(output.slice(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

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

const history: Anthropic.MessageParam[] = [];
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

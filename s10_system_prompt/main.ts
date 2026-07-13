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
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// client 与 logger 通过参数注入到 agentLoop。agentLoop 还需要记忆索引路径，
// 以便每轮工具后重新推导 context。
export type Deps = { client: ModelClient; logger: SessionLogger };
export type LoopDeps = Deps & { memoryIndex: string };

// ═══════════════════════════════════════════════════════════
//  s10 新增：Prompt 片段
// ═══════════════════════════════════════════════════════════

const PROMPT_SECTIONS = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

export type Context = {
  enabled_tools: string[];
  workspace: string;
  memories: string;
};

// 根据当前 context 挑选并拼接 prompt 片段。
export function assembleSystemPrompt(context: Context): string {
  const sections: string[] = [];

  // 始终加载：identity / tools / workspace。
  sections.push(PROMPT_SECTIONS.identity);
  sections.push(PROMPT_SECTIONS.tools);
  sections.push(PROMPT_SECTIONS.workspace);

  // 条件加载：MEMORY.md 存在且非空时才加上记忆片段。
  if (context.memories) {
    sections.push(`Relevant memories:\n${context.memories}`);
  }

  return sections.join("\n\n");
}

let lastContextKey: string | null = null;
let lastPrompt: string | null = null;

// 测试用：重置进程内缓存，隔离用例。
export function resetPromptCache(): void {
  lastContextKey = null;
  lastPrompt = null;
}

// JSON.stringify 保持插入顺序；传入排序后的 key 数组让序列化结果确定
// （对应 Python 的 json.dumps(sort_keys=True)）—— 比对对象身份更可靠，
// 重建但内容相同的 context 也能命中缓存。
export const contextKey = (context: Context): string =>
  JSON.stringify(context, Object.keys(context).sort());

// 缓存包装 —— context 变了才重新组装。
// 这层缓存只省进程内的重复拼接；真正的 Claude Code 还会靠稳定的片段顺序 +
// SYSTEM_PROMPT_DYNAMIC_BOUNDARY 保护 API 层的 prompt cache。
export function getSystemPrompt(context: Context): string {
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

// 把路径限制在 WORKDIR 内，越界即抛错。
export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function runBash(command: string): string {
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

export function runRead(p: string, limit?: number): string {
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

export function runWrite(p: string, content: string): string {
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
//  s10 新增：Context —— 依据真实状态，而非关键词猜测
// ═══════════════════════════════════════════════════════════

// 由真实状态推导 context：有哪些工具、记忆文件是否存在。
export function updateContext(memoryIndex: string): Context {
  let memories = "";
  if (fs.existsSync(memoryIndex)) {
    memories = fs.readFileSync(memoryIndex, "utf8").trim();
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 用组装出来的 system prompt，替代写死的 SYSTEM
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, memoryIndex } = deps;
  let system = getSystemPrompt(context);
  while (true) {
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system,
      messages,
      tools,
      max_tokens: 8000,
    });
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
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

    // 每轮工具后重新推导 context 并重组 prompt。
    context = updateContext(memoryIndex);
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
// import.meta.main 只在文件被直接运行时为 true。
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  let context = updateContext(MEMORY_INDEX);
  logger.config({ model: MODEL_ID, system: getSystemPrompt(context), tools });

  print("s10: System Prompt — 运行时组装 + 缓存", "cyan");
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
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s10 >> ", "cyan"));
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

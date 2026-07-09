/**
 * s02_tool_use/main.ts - 工具使用
 *
 * 在 s01 的循环基础上新增：
 *   + runRead / runWrite / runEdit / runGlob —— 四个新的工具实现
 *     （bash 工具直接复用 s01 导出的 runBash）
 *   + TOOL_HANDLERS 分发表（取代 s01 里写死的 runBash 调用）
 *   + safePath 工作区越界检查
 *
 * 循环本身（agentLoop）和 s01 完全一样，内部唯一改变的一行是：
 *   s01: output = runBash(input.command)
 *   s02: output = TOOL_HANDLERS[block.name](input)
 *
 * messages.create 依然不会自己执行工具，只会把 tool_use 块交还给我们，
 * 所以循环的控制权还在这份代码里。
 *
 * Usage:
 *     pnpm dev s02_tool_use/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type AgentLogger } from "../lib/logger";
import { runBash as s01RunBash } from "../s01_agent_loop/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  FROM s01 (reused)
// ═══════════════════════════════════════════════════════════

export function runBash(command: string): string {
  return s01RunBash(command);
}

// ═══════════════════════════════════════════════════════════
//  NEW in s02: four new tools
// ═══════════════════════════════════════════════════════════

export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function runRead(p: string, limit?: number): string {
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

export function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf8");
    // indexOf + slice instead of String.replace: replace would treat
    // `$&`-style patterns in newText as special replacement syntax.
    const i = text.indexOf(oldText);
    if (i === -1) return `Error: text not found in ${p}`;
    fs.writeFileSync(filePath, text.slice(0, i) + newText + text.slice(i + oldText.length));
    return `Edited ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export function runGlob(pattern: string): string {
  try {
    const results = fs
      .globSync(pattern, { cwd: WORKDIR })
      .filter((m) => path.resolve(WORKDIR, m).startsWith(WORKDIR + path.sep));
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ═══════════════════════════════════════════════════════════
//  NEW in s02: tool definitions (s01 had only bash, now five)
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });

const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
];

// ═══════════════════════════════════════════════════════════
//  NEW in s02: dispatch map (s01 hardcoded runBash, now a lookup)
// ═══════════════════════════════════════════════════════════

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

// `input: any` mirrors Python's `handler(**block.input)` — each handler
// destructures the shape its schema guarantees after `.parse()`.
const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// ═══════════════════════════════════════════════════════════
//  agentLoop — same structure as s01, only tool execution changed
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: AgentLogger },
): Promise<string> {
  const { client, logger } = deps;
  while (true) {
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system: SYSTEM,
      messages,
      tools,
      max_tokens: 8000,
    });
    logger.response(response);

    // Append assistant turn (includes any tool-call blocks)
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    // Execute each tool call via the dispatch map, collect results
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[33m> ${block.name}\x1b[0m`);
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output = handler && schema ? handler(schema.parse(block.input)) : `Unknown: ${block.name}`;
      console.log(output.slice(0, 200));
      logger.toolResult(block.name, output);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    // Feed tool results back, loop continues
    messages.push({ role: "user", content: results });
  }
}

// ── Entry point ──────────────────────────────────────────
// import.meta.main 只在文件被直接运行时为 true。
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  console.log("s02: Tool Use — s01 plus four new tools");
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
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms02 >> \x1b[0m");
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger });
    console.log(finalText);
    console.log();
  }
  rl.close();
}

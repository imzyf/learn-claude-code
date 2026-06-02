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
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { textOf, zodTool } from "../lib/tools";
import { bashSchema, runBash as s01RunBash } from "../s01_agent_loop/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  来自 s01（未改动）
// ═══════════════════════════════════════════════════════════

export function runBash(command: string, timeoutMs = 120_000): string {
  return s01RunBash(command, timeoutMs);
}

// ═══════════════════════════════════════════════════════════
//  s02 新增：四个新 tool
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

export function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf8");
    // 用 indexOf + slice 而不是 String.replace：replace 会把 newText 里
    // `$&` 这类 pattern 当成特殊的替换语法处理。
    const i = text.indexOf(oldText);
    if (i === -1) return `Error: text not found in ${p}`;
    fs.writeFileSync(
      filePath,
      text.slice(0, i) + newText + text.slice(i + oldText.length),
    );
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
//  s02 新增：tool 定义（s01 只有 bash，现在有五个）
// ═══════════════════════════════════════════════════════════

const readSchema = z.object({
  path: z.string(),
  limit: z.number().int().optional(),
});
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({
  path: z.string(),
  old_text: z.string(),
  new_text: z.string(),
});
const globSchema = z.object({ pattern: z.string() });
const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
];

// ═══════════════════════════════════════════════════════════
//  s02 新增：dispatch 分发表（s01 写死 runBash，现在改成查表）
// ═══════════════════════════════════════════════════════════

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

// `input: any` 对应 Python 的 `handler(**block.input)` —— 每个 handler
// 解构出各自 schema 在 `.parse()` 之后保证的结构。
// biome-ignore lint/suspicious/noExplicitAny: handlers destructure schema-validated input
const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 结构和 s01 一样，只有 tool 执行部分变了
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger },
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

    // 追加 assistant 这一轮（包含所有 tool-call block）
    messages.push({ role: "assistant", content: response.content });

    // 如果 model 没有调用 tool，就结束
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    // 通过 dispatch 分发表逐个执行 tool call，收集结果
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      /*
        block 结构
        {
          "type": "tool_use",
          "id": "call_00_e3IosLtwiBk4IpGPy0QC7370",
          "name": "bash",
          "input": {
            "command": "node --version"
          }
        }
      */
      print(`> ${block.name}`, "yellow");
      // 按 tool 名字查出对应的 schema
      const schema = TOOL_SCHEMAS[block.name];
      // 按 tool 名字查出对应的 handler
      const handler = TOOL_HANDLERS[block.name];
      // schema 先 parse 校验 input，再交给 handler 执行；查不到就返回 Unknown
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      print(output.slice(0, 200), "gray");
      logger.toolResult(block.name, output);

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    // 把 tool 结果喂回去，loop 继续
    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
// import.meta.main 只在文件被直接运行时为 true。
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  print("s02: Tool Use — s01 plus four new tools", "cyan");
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
      query = await rl.question(colorize("s02 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger });
    print(finalText, "green");
    print();
  }
  rl.close();
}

/**
 * s02_tool_use/main.ts - 工具使用
 *
 * s01 的 agent 循环不变。这一节新增四个工具和一张分发表：
 *
 *     +----------+      +-------+      +--------------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch            |
 *     |  prompt  |      |       |      | bash       -> runBash    |
 *     +----------+      +---+---+      | read_file  -> runRead    |
 *                           ^          | write_file -> runWrite   |
 *                           |          | edit_file  -> runEdit    |
 *                           +----------+ glob       -> runGlob    |
 *                           tool_result+--------------------------+
 *
 *   + runRead / runWrite / runEdit / runGlob
 *     （bash 工具直接复用 s01 导出的 runBash）
 *   + TOOL_HANDLERS 分发表，取代 s01 里写死的 runBash 调用
 *   + safePath 把文件工具限制在工作区内
 *
 * 关键点：循环本身不变，长出来的只有 tool 注册和 dispatch。
 * agentLoop 内部唯一改变的一行是：
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
import { createLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, preview, printProse, textOf, zodTool } from "../lib/tools";
import { bashSchema, type Deps, runBash } from "../s01_agent_loop/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

export const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

// ═══════════════════════════════════════════════════════════
//  s02 新增：四个新 tool
// ═══════════════════════════════════════════════════════════

// 把路径限制在 WORKDIR 内，三个文件工具的公共前置检查，越界抛错由各 handler 捕获。
export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// read_file：读文件内容，可用 limit 截断行数，避免大文件塞爆 context。
export function runRead(p: string, limit?: number): string {
  try {
    // 按行拆分：结尾换行不产生多余空行，CRLF 不残留 \r。
    let lines = fs.readFileSync(safePath(p), "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
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

// write_file：整文件覆盖写，父目录不存在就递归创建。
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

// edit_file：按精确字符串替换第一处匹配，改局部时比整文件重写省 token。
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

// glob：按 pattern 找文件，让 model 先定位再读，不用 `ls` 一层层试。
// 结果排序，并截到 GLOB_MAX_MATCHES 条：一次 `**/*` 能刷出上万行，
// 整段进 messages 就是白烧 context，先在源头把结果压住。
const GLOB_MAX_MATCHES = 200;

export function runGlob(pattern: string): string {
  try {
    // Node 的 globSync 本身就递归展开 `**`、结果也不重复，code.py 那边的
    // recursive=True 与 set() 在这里都不必要，只需要补上排序。
    const matches = fs
      .globSync(pattern, { cwd: WORKDIR })
      .filter((m) => path.resolve(WORKDIR, m).startsWith(WORKDIR + path.sep))
      .sort();
    const shown: string[] = matches.slice(0, GLOB_MAX_MATCHES);
    if (matches.length > GLOB_MAX_MATCHES) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ═══════════════════════════════════════════════════════════
//  s02 新增：tool 定义（s01 只有 bash，现在有五个）
// ═══════════════════════════════════════════════════════════

export const readSchema = z.object({
  path: z.string(),
  limit: z.number().int().optional(),
});
export const writeSchema = z.object({ path: z.string(), content: z.string() });
export const editSchema = z.object({
  path: z.string(),
  old_text: z.string(),
  new_text: z.string(),
});
export const globSchema = z.object({ pattern: z.string() });
export const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool(
    "glob",
    "Find files matching a glob pattern; ** matches recursively.",
    globSchema,
  ),
];

// ═══════════════════════════════════════════════════════════
//  s02 新增：dispatch 分发表（s01 写死 runBash，现在改成查表）
// ═══════════════════════════════════════════════════════════

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

// 每个 handler 解构出各自 schema 在 `.parse()` 之后保证的结构。
export type Handlers = Partial<Record<string, (input: any) => string>>;

const TOOL_HANDLERS: Handlers = {
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
  deps: Deps,
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

    messages.push({ role: "assistant", content: response.content });

    if (!hasToolUse(response)) {
      return textOf(response);
    }

    // 通过 dispatch 分发表逐个执行 tool call，收集结果
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;

      // 按 tool 名字查出对应的 schema
      const schema = TOOL_SCHEMAS[block.name];
      // 按 tool 名字查出对应的 handler
      const handler = TOOL_HANDLERS[block.name];
      // schema 先 parse 校验 input，再交给 handler 执行；查不到就返回 Unknown
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      print(preview(output), "gray");
      logger.toolResult(block.name, output);

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  print("s02: Tool Use - four tools added to s01", "cyan");
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
      break;
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

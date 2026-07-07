/**
 * s03_permission/main.ts - 权限系统
 *
 * 在工具执行前插入三道关卡：
 *
 *     关卡 1：硬性拒绝名单（rm -rf /、sudo 等）
 *     关卡 2：规则匹配（是否写到工作区外？是否是破坏性命令？）
 *     关卡 3：用户批准（暂停并等待确认）
 *
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *     | Tool  | -> | Gate 1 | -> | Gate 2 | -> | Gate 3 | -> | Exec |
 *     | call  |    | deny?  |    | match? |    | allow? |    |      |
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *          |            |             |             |
 *          v            v             v             v
 *       (normal)     (blocked)    (ask user)   (user says no?)
 *
 * agent 循环里只加了一行：
 *
 *     if (!(await checkPermission(call))) continue;
 *
 * 相比 s02 还有两处改动：
 *   - runBash 内联的危险命令检查被移除——现在归关卡 1 管
 *   - 关卡 3（askUser）做成可注入依赖：入口用真实 readline，测试用 fake
 *
 * 基于 s02（多工具）构建。Usage:
 *
 *     pnpm dev s03_permission/main.ts
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type SessionLogger } from "../lib/logger";
import {
  runRead as s02RunRead,
  runWrite as s02RunWrite,
  runEdit as s02RunEdit,
  runGlob as s02RunGlob,
  safePath as s02SafePath,
} from "../s02_tool_use/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;

// ═══════════════════════════════════════════════════════════
//  FROM s02: Tool Implementations
//  - runBash changed: inline dangerous-check removed, Gate 1 replaces it
//  - safePath + 四个文件工具 unchanged：从 s02 导入并起别名，本地保留
//    同名 wrapper，结构与调用点（TOOL_HANDLERS）都不用动
// ═══════════════════════════════════════════════════════════

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

export function safePath(p: string): string {
  return s02SafePath(p);
}

export function runRead(p: string, limit?: number): string {
  return s02RunRead(p, limit);
}

export function runWrite(p: string, content: string): string {
  return s02RunWrite(p, content);
}

export function runEdit(p: string, oldText: string, newText: string): string {
  return s02RunEdit(p, oldText, newText);
}

export function runGlob(pattern: string): string {
  return s02RunGlob(pattern);
}

// ═══════════════════════════════════════════════════════════
//  FROM s02 (unchanged): Tool Definitions & Dispatch
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
//  NEW in s03: Three-Gate Permission Pipeline
// ═══════════════════════════════════════════════════════════

// Gate 1: Hard deny list — always forbidden
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda", "osascript"];

export function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

// Gate 2: Rule matching — context-dependent checks
const PERMISSION_RULES: { tools: string[]; check: (args: any) => boolean; message: string }[] = [
  {
    tools: ["write_file", "edit_file"],
    check: (args) => {
      const resolved = path.resolve(WORKDIR, args.path ?? "");
      return resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep);
    },
    message: "Writing outside workspace",
  },
  {
    tools: ["bash"],
    check: (args) => ["rm ", "> /etc/", "chmod 777"].some((kw) => (args.command ?? "").includes(kw)),
    message: "Potentially destructive command",
  },
];

export function checkRules(toolName: string, args: unknown): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}

// Gate 3: User approval — wait for confirmation after rule match.
// The prompt itself is injected (AskUser) so the pipeline stays free of
// readline: the entry point wires in a real terminal prompt, tests a fake.
export type AskUser = (
  toolName: string,
  args: unknown,
  reason: string,
) => Promise<"allow" | "deny">;

// Pipeline: all three gates chained
export async function checkPermission(
  block: Anthropic.ToolUseBlock,
  askUser: AskUser,
  logger: SessionLogger,
): Promise<boolean> {
  if (block.name === "bash") {
    const reason = checkDenyList((block.input as any).command ?? "");
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      logger.permission(block.name, block.input, reason, "deny");
      return false;
    }
  }
  const reason = checkRules(block.name, block.input);
  if (reason) {
    const decision = await askUser(block.name, block.input, reason);
    logger.permission(block.name, block.input, reason, decision);
    if (decision === "deny") return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s02, with checkPermission() inserted
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger; askUser: AskUser },
): Promise<string> {
  const { client, logger, askUser } = deps;
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

    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await checkPermission(block, askUser, logger))) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Permission denied.",
        });
        continue;
      }

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

  // Gate 3 的真实实现：readline 接口和 REPL 共用（Python 里就是 input()）。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const askUser: AskUser = async (toolName, args, reason) => {
    console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
    console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
    let choice: string;
    try {
      choice = (await rl.question("   Allow? [y/N] ")).trim().toLowerCase();
    } catch {
      return "deny"; // stdin closed — nobody left to approve
    }
    return choice === "y" || choice === "yes" ? "allow" : "deny";
  };

  console.log("s03: Permission");
  console.log("输入问题，回车发送。输入 q 退出。e.g., delete the README.md file\n");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms03 >> \x1b[0m");
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, askUser });
    console.log(finalText);
    console.log();
  }
  rl.close();
}

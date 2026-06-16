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
 *   - 关卡 3（Confirm）做成可注入依赖：入口用 makeConfirm 接真实 readline，
 *     测试用 fake；s04 也复用同一个 Confirm / makeConfirm
 *
 * 基于 s02（多工具）构建。Usage:
 *
 *     pnpm dev s03_permission/main.ts
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf } from "../lib/tools";
// 四个文件工具、tool 定义、schema 表在 s03 都没变，直接从 s02 复用，
// 不再包一层同名 wrapper。只有 runBash 是 s03 自己的版本（见下）。
import {
  runEdit,
  runGlob,
  runRead,
  runWrite,
  TOOL_SCHEMAS,
  tools,
} from "../s02_tool_use/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;

// ═══════════════════════════════════════════════════════════
//  来自 s02：工具实现
//  runBash 是 s03 本地版：内联的危险命令检查移除，改由关卡 1 负责。
//  四个文件工具没变，已在顶部直接从 s02 import 复用。
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

// ═══════════════════════════════════════════════════════════
//  来自 s02（未改动）：tool 定义与 dispatch
//  tools 和 TOOL_SCHEMAS 都是纯数据，直接从 s02 复用
// ═══════════════════════════════════════════════════════════

// `input: any` 对应 Python 的 `handler(**block.input)` —— 每个 handler
// 解构出各自 schema 在 `.parse()` 之后保证的结构。
export const TOOL_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// ═══════════════════════════════════════════════════════════
//  s03 新增：三道关卡的 permission pipeline
// ═══════════════════════════════════════════════════════════

// 关卡 1：硬性拒绝名单 —— 永远禁止
const DENY_LIST = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/sda",
  "osascript",
];

export function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

// 关卡 2：规则匹配 —— 依赖上下文的检查
const PERMISSION_RULES: {
  tools: string[];
  check: (args: any) => boolean;
  message: string;
}[] = [
  {
    // 规则 1：write_file / edit_file 的目标路径落在工作区之外
    tools: ["write_file", "edit_file"],
    check: (args) => {
      const resolved = path.resolve(WORKDIR, args.path ?? "");
      return resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep);
    },
    message: "Writing outside workspace",
  },
  {
    // 规则 2：bash 命令含破坏性关键字（rm、写入 /etc、chmod 777）
    tools: ["bash"],
    check: (args) =>
      ["rm ", "> /etc/", "chmod 777"].some((kw) =>
        (args.command ?? "").includes(kw),
      ),
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

// 把一次权限决定（放行/拦截）格式化后写进 transcript。
// 格式化归调用方管，logger 只提供通用的 section()。
export function logPermission(
  logger: SessionLogger,
  toolName: string,
  args: unknown,
  reason: string,
  decision: "allow" | "deny",
): void {
  logger.section(
    "PERMISSION",
    `${reason}\nTool: ${toolName}(${JSON.stringify(args)})\nDecision: ${decision}`,
  );
}

// 关卡 3：用户批准 —— 规则匹配后等待确认。
// 确认动作通过依赖注入传入（Confirm），让 pipeline 不依赖 readline：
// 入口用 makeConfirm 接入真实 terminal 提示，测试则注入 fake。
export type Confirm = (
  call: Anthropic.ToolUseBlock,
  warning: string,
) => Promise<boolean>;

// Confirm 的真实实现：打印告警、问 y/N，并自己记录放行/拦截决定。
// 工厂闭包捕获 rl 与 logger，返回纯 (call, warning) => boolean 的确认函数。
export function makeConfirm(
  rl: readline.Interface,
  logger: SessionLogger,
): Confirm {
  return async function confirmWithUser(call, warning) {
    print(`\n⚠  ${warning}`, "yellow");
    print(`   Tool: ${call.name}(${JSON.stringify(call.input)})`);
    let choice: string;
    try {
      choice = (await rl.question("   Allow? [y/N] ")).trim().toLowerCase();
    } catch {
      return false; // stdin 关闭 —— 没人能批准了
    }
    const allowed = choice === "y" || choice === "yes";
    logPermission(
      logger,
      call.name,
      call.input,
      warning,
      allowed ? "allow" : "deny",
    );
    return allowed;
  };
}

// Pipeline：三道关卡串起来
export async function checkPermission(
  block: Anthropic.ToolUseBlock,
  confirm: Confirm,
  logger: SessionLogger,
): Promise<boolean> {
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
  if (block.name === "bash") {
    const reason = checkDenyList((block.input as any).command ?? "");
    if (reason) {
      print(`\n⛔ ${reason}`, "red");
      logPermission(logger, block.name, block.input, reason, "deny");
      return false;
    }
  }

  const reason = checkRules(block.name, block.input);
  if (reason) {
    // confirm 自己记录放行/拦截，这里只看它返回的布尔结果。
    if (!(await confirm(block, reason))) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s02 一样，只是插入了 checkPermission()
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: { client: ModelClient; logger: SessionLogger; confirm: Confirm },
): Promise<string> {
  const { client, logger, confirm } = deps;
  while (true) {
    logger.request(messages, true);
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
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }

      // s03 改动：执行前先过一遍 permission pipeline
      if (!(await checkPermission(block, confirm, logger))) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Permission denied by rule or user.",
        });
        continue;
      }

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
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

    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
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

  const confirm = makeConfirm(rl, logger);

  print("s03: Permission", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s03 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, confirm });
    print(finalText, "green");
    print();
  }
  rl.close();
}

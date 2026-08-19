/**
 * s03_permission/main.ts - 权限系统
 *
 * 在工具执行前插入三道关卡：
 *
 *     关卡 1：硬性拒绝名单（rm -rf /、sudo 等）
 *     关卡 2：规则匹配（是否写到工作区外？是否是破坏性命令？）
 *     关卡 3：用户批准（暂停并等待确认）
 *
 *     +----------+      +-------+      +--------------+      +---------------+
 *     |   User   | ---> |  LLM  | ---> | Permission   | ---> | Tool Dispatch |
 *     |  prompt  |      |       |      | 1. deny list |      | execute       |
 *     +----------+      +---+---+      | 2. rules     |      +-------+-------+
 *                           ^          | 3. approval  |              |
 *                           |          +------+-------+              |
 *                           |                 | deny                 |
 *                           |                 v                      v
 *                           |          +-------------------------------+
 *                           +----------+ tool_result: denied or output |
 *                                      +-------------------------------+
 *
 * agent 循环里只加了一行：
 *
 *     if (!(await checkPermission(call))) continue;
 *
 * 相比 s02 还有三处改动：
 *   - runBash 内联的危险命令检查被移除——现在归关卡 1 管
 *   - 文件工具的 safePath 硬拦截被移除——越界与否交给关卡 2/3 判断。
 *     两层同时存在的话 safePath 会先抛错，用户在关卡 3 点「允许」也没用
 *   - 关卡 3（Confirm）做成可注入依赖：入口用 makeConfirm 接真实 readline，
 *     测试用 fake；s04 也复用同一个 Confirm / makeConfirm
 *
 * 基于 s02（多工具）构建。Usage:
 *
 *     pnpm dev s03_permission/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, preview, printProse, textOf } from "../lib/tools";
import type { Deps as S01Deps } from "../s01_agent_loop/main";
// tool 定义、schema 表在 s03 没变，直接从 s02 复用。runBash 和三个
// 文件工具是 s03 自己的版本（见下）；runGlob 自带 WORKDIR 过滤，照常复用。
import {
  errMsg,
  type Handlers,
  runGlob,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
  tools,
} from "../s02_tool_use/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;

// ═══════════════════════════════════════════════════════════
//  来自 s02：工具实现（s03 本地版）
//  runBash 内联的危险命令检查、三个文件工具的 safePath 硬拦截全部移除，
//  统一交给下面三道关卡负责。runGlob 自带 WORKDIR 过滤，仍复用 s02 的。
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

export function runRead(p: string, limit?: number): string {
  try {
    // 对齐 Python 的 splitlines()：结尾换行不产生多余空行，CRLF 不残留 \r。
    let lines = fs
      .readFileSync(path.resolve(WORKDIR, p), "utf8")
      .split(/\r?\n/);
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

export function runWrite(p: string, content: string): string {
  try {
    const filePath = path.resolve(WORKDIR, p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = path.resolve(WORKDIR, p);
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

// ═══════════════════════════════════════════════════════════
//  来自 s02（未改动）：tool 定义与 dispatch
//  tools 和 TOOL_SCHEMAS 都是纯数据，直接从 s02 复用
// ═══════════════════════════════════════════════════════════

// `input: any` 对应 Python 的 `handler(**block.input)` —— 每个 handler
// 解构出各自 schema 在 `.parse()` 之后保证的结构。
export const TOOL_HANDLERS: Handlers = {
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
    // 规则 1：文件工具的目标路径落在工作区之外
    tools: ["read_file", "write_file", "edit_file"],
    check: (args) => {
      const resolved = path.resolve(WORKDIR, args.path ?? "");
      return resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep);
    },
    message: "Access outside workspace",
  },
  {
    // 规则 2：bash 命令含破坏性关键字（rm、写入 /etc、chmod 777）
    tools: ["bash"],
    check: (args) =>
      ["rm ", "unlink ", "> /etc/", "chmod 777"].some((kw) =>
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
    print(`\n[permission] ${warning}`, "yellow");
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

// ═══════════════════════════════════════════════════════════
//  Pipeline：三道关卡串起来
// ═══════════════════════════════════════════════════════════

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
      print(`\n[blocked] ${reason}`, "red");
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

export type Deps = S01Deps & { confirm: Confirm };

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
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

    if (!hasToolUse(response)) {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;

      // s03 改动：执行前先过一遍 permission pipeline
      if (!(await checkPermission(block, confirm, logger))) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Permission denied by rule or user.",
        });
        continue;
      }

      const schema = S02_TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
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

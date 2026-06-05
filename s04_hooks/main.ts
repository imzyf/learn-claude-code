/**
 * s04_hooks/main.ts - Hooks
 *
 * 把扩展逻辑从循环里搬出来，交给 hooks 管理：
 *
 *   User types query
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │ UserPromptSubmit │ ── triggerHooks() before LLM
 *   └────────┬─────────┘
 *            ▼
 *   ┌────────────┐     ┌──────────────────────────────┐
 *   │  messages  │────▶│ LLM (stop_reason=tool_use?)   │
 *   └────────────┘     │   No ──▶ Stop hooks ──▶ exit  │
 *                      │   Yes ──▶ tool call ────────┐ │
 *                      └─────────────────────────────┘ │
 *                                                      ▼
 *                                          ┌──────────────────┐
 *                                          │ triggerHooks()    │
 *                                          │  PreToolUse:      │
 *                                          │   permissionHook  │
 *                                          │   logHook         │
 *                                          └───────┬──────────┘
 *                                                  │ (not blocked)
 *                                          ┌───────▼──────────┐
 *                                          │ TOOL_HANDLERS[x]  │
 *                                          └───────┬──────────┘
 *                                                  │
 *                                          ┌───────▼──────────┐
 *                                          │ triggerHooks()    │
 *                                          │  PostToolUse:     │
 *                                          │   largeOutput     │
 *                                          └───────┬──────────┘
 *                                                  │
 *                                          results ──▶ back to messages
 *
 * 相比 s03 的变化：
 *   + HOOKS 注册表（事件 -> 回调列表）
 *   + registerHook() / triggerHooks()
 *   + contextInjectHook（UserPromptSubmit）
 *   + permissionHook、logHook（PreToolUse）
 *   + largeOutputHook（PostToolUse）
 *   + summaryHook（Stop）—— 可能通过一条用户消息强制再来一轮
 *   - checkPermission() 从循环体里移除
 *     （逻辑搬进了 permissionHook，通过 PreToolUse 触发）
 *   - 循环自身的 `> toolName` / 输出日志被移除——改由 logHook 负责
 *
 * 基于 s03（权限）构建。Usage:
 *
 *     pnpm dev s04_hooks/main.ts
 */

import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { textOf } from "../lib/tools";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）——纯数据，原样复用。
import { TOOL_SCHEMAS, tools } from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）+ 权限确认抽象（Confirm / makeConfirm）。
import {
  type Confirm,
  makeConfirm,
  TOOL_HANDLERS,
} from "../s03_permission/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ═══════════════════════════════════════════════════════════
//  来自 s02-s03：工具层直接复用，s04 不再重复定义
//  - tools / TOOL_SCHEMAS 复用 s02（schema 从没变过，s03 也是这么用的）
//  - TOOL_HANDLERS 复用 s03：它的 bash handler 指向 s03 的 runBash
//    （去掉了内联危险检查，改由 permissionHook 把关）
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  s04 新增：Hook 系统（s03 的权限逻辑现在通过 hook 实现）
// ═══════════════════════════════════════════════════════════

// hook 是 async 的，因为 permissionHook 要 await rl.question()
//（Python 里就是 input()）。`...args: any[]` 对应 Python 的
// `callback(*args)` —— 每个事件传入各自的参数结构。
type Hook = (...args: any[]) => string | null | Promise<string | null>;

const HOOKS: Record<string, Hook[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

// hook 系统的日志出口，设计成模块级单例（而非当参数传给 registerHook/
// triggerHooks）：
//   1. HOOKS 注册表本身已是模块级单例，logger 跟随同一模式，风格一致；
//   2. triggerHooks 是变长参数（...args），logger 无处安放；当参数传还要
//      改所有调用点和测试的签名。
// 入口调用 setHookLogger 注入一次，测试不注入即静默（null）。
let hookLogger: SessionLogger | null = null;
export function setHookLogger(logger: SessionLogger | null): void {
  hookLogger = logger;
}

export function registerHook(event: string, callback: Hook): void {
  HOOKS[event].push(callback);
}

export async function triggerHooks(
  event: string,
  ...args: any[]
): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    // 执行记录集中在这里，而不是散落进每个 hook。
    hookLogger?.hookResult(event, callback.name, args, result);
    if (result != null) return result; // teaching shortcut: block this tool call
  }
  return null;
}

// 清空所有已注册 hook。入口不会自动注册（见 registerDefaultHooks），
// 测试用它在每个用例前重置注册表，避免用例间互相污染。
export function clearHooks(): void {
  for (const event of Object.keys(HOOKS)) HOOKS[event] = [];
}

// PreToolUse/PostToolUse hook 收到的结构 —— 原始的 tool_use block
//（和 Python hook 收到的一致）。
type ToolCallInfo = Anthropic.ToolUseBlock;

// permissionHook 需要「问用户」的能力，但不该自己持有 readline。
// Confirm 抽象复用 s03（见顶部 import）：入口注入真实提示，测试注入 fake。

// s03 的权限检查逻辑，现在包装成 hook
const DENY_LIST = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "osascript",
];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// PreToolUse：s03 的 checkPermission() 逻辑搬到这里。
// 工厂函数：闭包捕获 confirm，返回真正的 hook（这就是给回调注入依赖的标准手法）。
export function makePermissionHook(confirm: Confirm): Hook {
  return async function permissionHook(
    call: ToolCallInfo,
  ): Promise<string | null> {
    const input = call.input as any;
    if (call.name === "bash") {
      const command: string = input.command ?? "";
      for (const pattern of DENY_LIST) {
        if (command.includes(pattern)) {
          hookLogger?.console(
            `[HOOK] PreToolUse(makePermissionHook): ⛔ Blocked: '${pattern}'`,
            "red",
          );
          return "Permission denied by deny list";
        }
      }
      if (DESTRUCTIVE.some((kw) => command.includes(kw))) {
        if (!(await confirm(call, "Potentially destructive command"))) {
          return "Permission denied by user";
        }
      }
    }
    if (call.name === "write_file" || call.name === "edit_file") {
      const resolved = path.resolve(WORKDIR, input.path ?? "");
      if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
        if (!(await confirm(call, "Writing outside workspace"))) {
          return "Permission denied by user";
        }
      }
    }
    return null;
  };
}

// PreToolUse：记录每一次工具调用。
export function logHook(call: ToolCallInfo): null {
  const argsPreview = JSON.stringify(
    Object.values((call.input as any) ?? {}).slice(0, 2),
  ).slice(0, 60);
  hookLogger?.console(
    `[HOOK] PreToolUse(logHook): ${call.name}(${argsPreview})`,
    "gray",
  );
  return null;
}

// PostToolUse：输出过大时告警。
export function largeOutputHook(call: ToolCallInfo, output: string): null {
  if (output.length > 100_000) {
    hookLogger?.console(
      `[HOOK] PostToolUse(largeOutputHook): ⚠ Large output from ${call.name}: ${output.length} chars`,
      "yellow",
    );
  }
  return null;
}

// UserPromptSubmit hook：在用户输入抵达 LLM 前记录它
export function contextInjectHook(_query: string): null {
  hookLogger?.console(
    `[HOOK] UserPromptSubmit(contextInjectHook): working in ${WORKDIR}`,
    "gray",
  );
  return null;
}

// Stop hook：循环即将退出时打印小结
export function summaryHook(messages: Anthropic.MessageParam[]): null {
  const toolCount = messages.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_result").length
        : 0),
    0,
  );
  hookLogger?.console(
    `[HOOK] Stop(summaryHook): session used ${toolCount} tool calls`,
    "gray",
  );
  return null;
}

// 默认 hook 注册收进函数，只在入口调用一次；import 该模块不产生副作用。
// permissionHook 需要 confirm，所以注册时才把它注入进去。
export function registerDefaultHooks(confirm: Confirm): void {
  registerHook("UserPromptSubmit", contextInjectHook);
  registerHook("PreToolUse", makePermissionHook(confirm));
  registerHook("PreToolUse", logHook);
  registerHook("PostToolUse", largeOutputHook);
  registerHook("Stop", summaryHook);

  // 注册完一次性记录：格式化由 logger.hookRegister 负责。
  hookLogger?.hookRegister(HOOKS);
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s03 结构相同，只是不再硬编码检查
//  s03: if (!(await checkPermission(call))) ...
//  s04: if (await triggerHooks("PreToolUse", call)) ...
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
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // 特殊点 1：模型想停，但 Stop hook 的返回值会被当成一条 user 消息，
      // 强制再跑一轮——循环能「自己续命」，不直接退出。
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      print(`> [${block.name}] ${JSON.stringify(block.input)}`, "cyan");
      // 特殊点 2：PreToolUse hook 取代 s03 的 checkPermission()——
      // 返回非 null 即拦截，返回值直接当成 tool_result 内容回给模型。
      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      // 特殊点 3：PostToolUse hook 拿到输出做观察（如大输出告警），不改结果。
      await triggerHooks("PostToolUse", block, output);

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

  // 共用的 readline：hook（Allow? 提示）和 REPL 都用它。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  // confirm 复用 s03 的 makeConfirm：握着 logger，用它专门的 permission()
  // 记录放行/拦截决定。
  const confirm = makeConfirm(rl, logger);

  setHookLogger(logger);
  registerDefaultHooks(confirm);

  print("s04: Hooks — extension logic on hooks, loop stays clean", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s04 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    await triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger });
    print(finalText, "green");
    print();
  }
  rl.close();
}

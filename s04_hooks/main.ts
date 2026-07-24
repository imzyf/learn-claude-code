/**
 * s04_hooks/main.ts - Hooks
 *
 * 把扩展逻辑从循环里搬出来，交给 hooks 管理：
 *
 *   User types query
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │ UserPromptSubmit │ ── hooks.trigger() before LLM
 *   └────────┬─────────┘
 *            ▼
 *   ┌────────────┐     ┌──────────────────────────────┐
 *   │  messages  │────▶│ LLM (stop_reason=tool_use?)   │
 *   └────────────┘     │   No ──▶ Stop hooks ──▶ exit  │
 *                      │   Yes ──▶ tool call ────────┐ │
 *                      └─────────────────────────────┘ │
 *                                                      ▼
 *                                          ┌──────────────────┐
 *                                          │ hooks.trigger()   │
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
 *                                          │ hooks.trigger()   │
 *                                          │  PostToolUse:     │
 *                                          │   largeOutput     │
 *                                          └───────┬──────────┘
 *                                                  │
 *                                          results ──▶ back to messages
 *
 * 相比 s03 的变化：
 *   + hook 实例 createHooks()（注册表 + logger 收进闭包，经 deps 传递）
 *   + hooks.register() / hooks.trigger()
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
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf } from "../lib/tools";
import type { Deps as S01Deps } from "../s01_agent_loop/main";
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
//（Python 里就是 input()）。第一参 logger 由 trigger 注入；其后的
// `...args: any[]` 对应 Python 的 `callback(*args)` —— 每个事件传入
// 各自的参数结构。
export type Hook = (
  logger: SessionLogger,
  ...args: any[]
) => string | null | Promise<string | null>;

// hook 系统做成实例：注册表和 logger 都收进 createHooks 的闭包，实例经 deps
// 传给 agentLoop。没有模块级可变状态——入口建一个带真 logger 的实例，
// 测试各建各的（noopLogger），互不污染。
export interface HookSystem {
  // 注册一个 hook
  register(event: string, callback: Hook): void;
  // 记录所有注册情况
  logRegistration(): void;
  // 触发一个 event，跑所其有 hook
  trigger(event: string, ...args: any[]): Promise<string | null>;
}

export function createHooks(logger: SessionLogger): HookSystem {
  const registry: Record<string, Hook[]> = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };
  return {
    register(event: string, callback: Hook): void {
      registry[event].push(callback);
    },

    async trigger(event: string, ...args: any[]): Promise<string | null> {
      for (const callback of registry[event]) {
        const result = await callback(logger, ...args);
        // 执行记录集中在这里，而不是散落进每个 hook。
        logHookResult(logger, event, callback.name, args, result);
        if (result != null) return result; // teaching shortcut: block this tool call
      }
      return null;
    },

    // 注册完一次性把各 event 的 hook 名单写进 transcript（按最长 event 名对齐）。
    logRegistration(): void {
      // 转成 [event, hooks] 键值对数组，只留至少注册了一个 hook 的 event。
      const entries = Object.entries(registry).filter(
        ([, hs]) => hs.length > 0,
      );
      // 按最长 event 名补空格，让各行的 hook 列表左对齐。
      const pad = Math.max(...entries.map(([event]) => event.length)) + 2;
      const summary = entries
        .map(
          ([event, hs]) =>
            `${event}:`.padEnd(pad) +
            hs.map((h) => h.name || "(anonymous)").join(", "),
        )
        .join("\n");
      logger.section("HOOK REGISTER", summary);
    },
  };
}

// 把一次 hook 执行结果写进 transcript：仅当该 hook 拦截了调用（blocked 非空）时落一条，
// 并把触发时的 args 序列化进去（超长会截断），便于看清被拦的是什么输入。
export function logHookResult(
  logger: SessionLogger,
  event: string,
  name: string,
  args: unknown[],
  blocked: string | null,
): void {
  if (!blocked) return;
  const hookName = name || "(anonymous)";
  const serialized = JSON.stringify(args).slice(0, 500);
  logger.section(
    "HOOK RESULT",
    `${event} → ${hookName}(${serialized}) blocked: ${blocked}`,
  );
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
    logger: SessionLogger,
    call: ToolCallInfo,
  ): Promise<string | null> {
    const input = call.input as any;
    if (call.name === "bash") {
      const command: string = input.command ?? "";
      for (const pattern of DENY_LIST) {
        if (command.includes(pattern)) {
          logger.console(
            `[HOOK] PreToolUse(permissionHook): ⛔ Blocked: '${pattern}'`,
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
export function logHook(logger: SessionLogger, call: ToolCallInfo): null {
  const argsPreview = JSON.stringify(
    Object.values((call.input as any) ?? {}).slice(0, 2),
  ).slice(0, 60);
  logger.console(
    `[HOOK] PreToolUse(logHook): ${call.name}(${argsPreview})`,
    "gray",
  );
  return null;
}

// PostToolUse：输出过大时告警。
export function largeOutputHook(
  logger: SessionLogger,
  call: ToolCallInfo,
  output: string,
): null {
  if (output.length > 100_000) {
    logger.console(
      `[HOOK] PostToolUse(largeOutputHook): ⚠ Large output from ${call.name}: ${output.length} chars`,
      "yellow",
    );
  }
  return null;
}

// UserPromptSubmit hook：在用户输入抵达 LLM 前记录它
export function contextInjectHook(logger: SessionLogger, _query: string): null {
  logger.console(
    `[HOOK] UserPromptSubmit(contextInjectHook): working in ${WORKDIR}`,
    "gray",
  );
  return null;
}

// Stop hook：循环即将退出时打印小结
export function summaryHook(
  logger: SessionLogger,
  messages: Anthropic.MessageParam[],
): null {
  const toolCount = messages.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "tool_result").length
        : 0),
    0,
  );
  logger.console(
    `[HOOK] Stop(summaryHook): session used ${toolCount} tool calls`,
    "gray",
  );
  return null;
}

// 默认 hook 注册收进函数，只在入口调用一次；import 该模块不产生副作用。
// permissionHook 需要 confirm，所以注册时才把它注入进去。
function registerDefaultHooks(hooks: HookSystem, confirm: Confirm): void {
  hooks.register("UserPromptSubmit", contextInjectHook);
  hooks.register("PreToolUse", makePermissionHook(confirm));
  hooks.register("PreToolUse", logHook);
  hooks.register("PostToolUse", largeOutputHook);
  hooks.register("Stop", summaryHook);

  // 注册完一次性记录注册结果。
  hooks.logRegistration();
}

// 入口层 helper：建 hook 实例 + 注册默认 hook（含 permissionHook 所需的 confirm）。
export function loadHooks(logger: SessionLogger, confirm: Confirm): HookSystem {
  const hooks = createHooks(logger);
  registerDefaultHooks(hooks, confirm);
  return hooks;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s03 结构相同，只是不再硬编码检查
//  s03: if (!(await checkPermission(call))) ...
//  s04: if (await hooks.trigger("PreToolUse", call)) ...
// ═══════════════════════════════════════════════════════════

export type Deps = S01Deps & { hooks: HookSystem };

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks } = deps;
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
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }

      // 特殊点 2：PreToolUse hook 取代 s03 的 checkPermission()——
      // 返回非 null 即拦截，返回值直接当成 tool_result 内容回给模型。
      const blocked = await hooks.trigger("PreToolUse", block);
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
      await hooks.trigger("PostToolUse", block, output);

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

  // confirm 复用 s03 的 makeConfirm：握着 logger，用 s03 的 logPermission
  // 记录放行/拦截决定。
  const confirm = makeConfirm(rl, logger);

  const hooks = loadHooks(logger, confirm);

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

    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, hooks });
    print(finalText, "green");
    print();
  }
  rl.close();
}

/**
 * s04_hooks/main.ts - Hooks
 *
 * 把扩展逻辑从循环里搬出来，交给 hooks 管理：hook 在 agent 循环的固定位置
 * 被回调触发。
 *
 *     User prompt
 *          |
 *          v
 *     UserPromptSubmit
 *          |
 *          v
 *     +----------+      +-------+      +------------+      +-------+
 *     | messages | ---> |  LLM  | ---> | PreToolUse | ---> | Tool  |
 *     +----------+      +---+---+      | permission |      +---+---+
 *          ^                | stop     | log        |          |
 *          |                v          +------------+          v
 *          |            Stop hook                         PostToolUse
 *          |                                               |
 *          +---------------- tool_result ------------------+
 *
 * 相比 s03 的变化：
 *   + hook 实例 createHooks()（注册表 + logger 收进闭包，经 deps 传递）
 *   + hooks.register() / hooks.trigger()
 *     （另有 hooks.triggerSkippingPermission()：对应 code.py 的
 *      trigger_hooks(skip_permission=True)，给自己判过权限的调用方用）
 *   + contextInjectHook（UserPromptSubmit）
 *   + permissionHook、logHook（PreToolUse）
 *   + largeOutputHook（PostToolUse）
 *   + summaryHook（Stop）—— 可能通过一条用户消息强制再来一轮
 *   - checkPermission() 从循环体里移除
 *     （逻辑搬进了 permissionHook，通过 PreToolUse 触发）
 *   - 循环自身的 `> toolName` 日志被移除——改由 logHook 负责；
 *     工具输出的预览仍由循环打印（和 s02/s03 一致）
 *
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, preview, printProse, textOf } from "../lib/tools";
import type { Deps as S01Deps } from "../s01_agent_loop/main";
// 来自 s02：tool 定义（tools）与 schema 表（TOOL_SCHEMAS）——纯数据，原样复用。
import { TOOL_SCHEMAS as S02_TOOL_SCHEMAS, tools } from "../s02_tool_use/main";
// 来自 s03：dispatch 表（TOOL_HANDLERS）、权限确认抽象（Confirm / makeConfirm），
// 以及关卡 1/2 的判定函数（checkDenyList / checkRules）——permissionHook 直接复用，
// 名单只在 s03 维护一份。
import {
  type Confirm,
  checkDenyList,
  checkRules,
  makeConfirm,
  TOOL_HANDLERS as S03_TOOL_HANDLERS,
} from "../s03_permission/main";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ═══════════════════════════════════════════════════════════
//  来自 s02-s03：工具层直接复用，s04 不再重复定义
//  - tools / TOOL_SCHEMAS 复用 s02（schema 从没变过，s03 也是这么用的）
//  - TOOL_HANDLERS 复用 s03：它的 bash handler 指向 s03 的 runBash
//    （去掉了内联危险检查，改由 permissionHook 把关）
//  - checkDenyList / checkRules 复用 s03：s04 换的是「什么时候检查」
//    （硬编码 -> hook），不是「检查什么」，名单没必要抄第二份
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  s04 新增：Hook 系统（s03 的权限逻辑现在通过 hook 实现）
// ═══════════════════════════════════════════════════════════

// 四个事件名写成字面量联合类型。Python 靠 HOOKS 这个 dict 的 key 约定，
// 名字写错只能在运行时抛 KeyError；TS 这里能让 register("PreToolsUse", ...)
// 直接编译不过。
export type HookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop";

// hook 是 async 的，因为 permissionHook 要 await rl.question()
//（Python 里就是 input()）。第一参 logger 由 trigger 注入；其后的
// `...args: any[]` 对应 Python 的 `callback(*args)` —— 每个事件传入
// 各自的参数结构：PreToolUse/PostToolUse 收到原始的 Anthropic.ToolUseBlock
//（和 Python hook 收到的一致），UserPromptSubmit 收到 query 字符串，
// Stop 收到整个 messages 数组。
export type Hook = (
  logger: SessionLogger,
  ...args: any[]
) => string | null | Promise<string | null>;

// hook 系统做成实例：注册表和 logger 都收进 createHooks 的闭包，实例经 deps
// 传给 agentLoop。没有模块级可变状态——入口建一个带真 logger 的实例，
// 测试各建各的（noopLogger），互不污染。
export interface HookSystem {
  // 注册一个 hook
  register(event: HookEvent, callback: Hook): void;
  // 记录所有注册情况
  logRegistration(): void;
  // 触发一个 event，跑其所有 hook
  trigger(event: HookEvent, ...args: any[]): Promise<string | null>;
  // 跳过 permissionHook 触发一个 event：调用方已经自己判过权限，
  // 且没有终端可以问用户。对应 code.py 的
  // trigger_hooks(..., skip_permission=True)，s13 的队友工具通道用它。
  triggerSkippingPermission(
    event: HookEvent,
    ...args: any[]
  ): Promise<string | null>;
}

export function createHooks(logger: SessionLogger): HookSystem {
  const registry: Record<HookEvent, Hook[]> = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };
  async function run(
    event: HookEvent,
    skipPermission: boolean,
    args: any[],
  ): Promise<string | null> {
    for (const callback of registry[event]) {
      if (skipPermission && isPermissionHook(callback)) continue;
      const result = await callback(logger, ...args);
      // 拦截记录集中在这里，而不是散落进每个 hook。
      logHookResult(logger, event, callback.name, args, result);
      if (result != null) return result; // hook 返回非 null 即拦截这次 tool call
    }
    return null;
  }

  return {
    register(event: HookEvent, callback: Hook): void {
      registry[event].push(callback);
    },

    trigger(event: HookEvent, ...args: any[]): Promise<string | null> {
      return run(event, false, args);
    },

    triggerSkippingPermission(
      event: HookEvent,
      ...args: any[]
    ): Promise<string | null> {
      return run(event, true, args);
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
  event: HookEvent,
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

// permissionHook 需要「问用户」的能力，但不该自己持有 readline。
// Confirm 抽象复用 s03（见顶部 import）：入口注入真实提示，测试注入 fake。

// PreToolUse：s03 的 checkPermission() 逻辑搬到这里。
// 关卡 1（checkDenyList）和关卡 2（checkRules）连同名单本身都留在 s03，
// 这里只负责把「判定结果」翻译成 hook 的返回值：非 null 即拦截。
// 工厂函数：闭包捕获 confirm，返回真正的 hook（这就是给回调注入依赖的标准手法）。
// code.py 用 `callback is permission_hook` 认出要跳过的 hook；这里的 hook 由工厂
// 生成，没有模块级的那一份可比，所以把产出登记进 WeakSet，同样按身份识别
//（不看函数名，改名不会悄悄失效）。
const permissionHooks = new WeakSet<Hook>();

export function isPermissionHook(callback: Hook): boolean {
  return permissionHooks.has(callback);
}

export function makePermissionHook(confirm: Confirm): Hook {
  const hook: Hook = async function permissionHook(
    logger: SessionLogger,
    call: Anthropic.ToolUseBlock,
  ): Promise<string | null> {
    // 关卡 1：拒绝名单，命中即拦，不问用户。
    if (call.name === "bash") {
      const denied = checkDenyList((call.input as any).command ?? "");
      if (denied) {
        logger.console(`[HOOK] PreToolUse(permissionHook): ${denied}`, "red");
        return "Permission denied by deny list";
      }
    }
    // 关卡 2/3：规则命中就问用户（越界路径、破坏性命令）。
    const reason = checkRules(call.name, call.input);
    if (reason && !(await confirm(call, reason))) {
      return "Permission denied by user";
    }
    return null;
  };
  permissionHooks.add(hook);
  return hook;
}

// PreToolUse：记录每一次工具调用。
// 只打工具名：参数已经由循环里的 printProse 打过一次（`🔧 bash({...})`），
// 这里再打一遍就是同一行信息的两个版本。
export function logHook(
  logger: SessionLogger,
  call: Anthropic.ToolUseBlock,
): null {
  logger.console(`[HOOK] PreToolUse(logHook): ${call.name}`, "gray");
  return null;
}

// PostToolUse：输出过大时告警。
export function largeOutputHook(
  logger: SessionLogger,
  call: Anthropic.ToolUseBlock,
  output: string,
): null {
  if (output.length > 100_000) {
    logger.console(
      `[HOOK] PostToolUse(largeOutputHook): Large output from ${call.name}: ${output.length} chars`,
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

  // 仅用于 manual-check.md 第 6 节演示「Stop hook 强制续轮」：默认不注册，
  // 避免干扰其余场景；跑那节验证时设 S04_FORCE_STOP_HOOK=1。
  if (process.env.S04_FORCE_STOP_HOOK) {
    let fired = false;
    hooks.register("Stop", () => {
      if (fired) return null;
      fired = true;
      return "Before you finish, list the files you touched.";
    });
  }

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

    if (!hasToolUse(response)) {
      // 特殊点 1：模型想停，但 Stop hook 的返回值会被当成一条 user 消息，
      // 强制再跑一轮——循环能「自己续命」，不直接退出。
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        logger.console(
          `[HOOK] Stop hook forced another round: ${force}`,
          "yellow",
        );
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;

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

      const schema = S02_TOOL_SCHEMAS[block.name];
      const handler = S03_TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      print(preview(output), "gray");
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

  print("s04: Hooks - extension logic on hooks, loop stays clean", "cyan");
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

/**
 * s06_subagent/main.ts - Subagent
 *
 * 用全新的 messages[] 派生子 agent，实现上下文隔离：
 *
 *   Parent Agent                           Subagent
 *   +------------------+                  +------------------+
 *   | messages=[...]   |                  | messages=[task]  | <-- fresh
 *   |                  |   dispatch       |                  |
 *   | tool: task       | ---------------> | own while loop   |
 *   |   prompt="..."   |                  |   bash/read/...  |
 *   |                  |   summary only   |   (max 30 turns) |
 *   | result = "..."   | <--------------- | return last text |
 *   +------------------+                  +------------------+
 *         ^                                      |
 *         |      intermediate results DISCARDED  |
 *         +--------------------------------------+
 *
 *   子 agent 的工具：bash、read、write、edit、glob（没有 task——不能递归）
 *
 * 相比 s05 的变化：
 *   工具层：parent 复用 s05 的 tools / TOOL_SCHEMAS / TOOL_HANDLERS（base + todo），
 *          只 append 一个 task；subagent 只拿 s02 的基础工具层 + s03 的 handler。
 *   Hook 层：注册表/触发器与默认 hook 全部复用 s05（它又复用 s04），s06 不再重复定义。
 *   + task 工具 + 带全新 messages[] 的 spawnSubagent()
 *   + 安全限制：每个子 agent 最多 30 轮
 *   子 agent 不能再派生子子 agent（subTools 里没有 task 工具）。
 *   主循环几乎没变：task 通过 TOOL_HANDLERS 自动分发——
 *   唯一区别是 `await handler(...)`，因为 spawnSubagent 是异步的。
 *
 * 基于 s05（todo_write）构建。Usage:
 *
 *     pnpm dev s06_subagent/main.ts
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { textOf, zodTool } from "../lib/tools";
// 来自 s02：基础工具层（bash + 四个文件工具）——subagent 只用这一层。
import {
  TOOL_SCHEMAS as BASE_SCHEMAS,
  tools as baseTools,
} from "../s02_tool_use/main";
// 来自 s03：基础 dispatch 表（bash/文件工具的 handler）——subagent 复用。
import { TOOL_HANDLERS as BASE_HANDLERS } from "../s03_permission/main";
// 来自 s04：hook 系统（触发器 + logger 注入）。
import { setHookLogger, triggerHooks } from "../s04_hooks/main";
// 来自 s05：默认 hook 注册 + 装配好的工具三张表，
// 以及 nag 机制（nagIfStale / bumpNagCounter / resetNagCounter）——单一出处在 s05。
import {
  bumpNagCounter,
  nagIfStale,
  registerDefaultHooks,
  resetNagCounter,
  TOOL_HANDLERS as S05_HANDLERS,
  TOOL_SCHEMAS as S05_SCHEMAS,
  tools as s05Tools,
} from "../s05_todo_write/main";

// s06 导出自己拥有的东西：agentLoop / spawnSubagent / Deps，
// 以及装配好的三张工具表（base + todo + task），供 s07 继续叠加。
// 复用来的符号由测试各自从源头（s04/s05）import，本模块不做 re-export 中转。

const WORKDIR = process.cwd();

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "For complex sub-problems, use the task tool to spawn a subagent.";

// s06: subagent 自己的 system prompt —— 没有 task，不能递归。
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// client 与 logger 通过参数注入到 agentLoop / spawnSubagent。
export type Deps = { client: ModelClient; logger: SessionLogger };

// ═══════════════════════════════════════════════════════════
//  工具装配：parent = s05（base + todo）+ task；subagent = s02 base
//  三张表都用展开语法在 s05 之上追加一个 task，调用点（agentLoop）不用改。
// ═══════════════════════════════════════════════════════════

const taskSchema = z.object({ description: z.string() });

// subagent 只拿基础工具层（没有 task），从源头杜绝递归派生。
const subTools = baseTools;

// 三张装配表导出，供 s07 在其上继续叠加（base + todo + task）。
export const tools: Anthropic.Tool[] = [
  ...s05Tools,
  // s06 新增：task 工具
  zodTool(
    "task",
    "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    taskSchema,
  ),
];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S05_SCHEMAS,
  task: taskSchema,
};

// handler 可能是 async：task -> spawnSubagent 返回 Promise。
// 第二参 deps 让 task 拿到 client/logger；基础 handler 是 (input)=>string，忽略它。
export const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: Deps) => string | Promise<string>>
> = {
  ...S05_HANDLERS,
  task: ({ description }, deps) => spawnSubagent(description, deps),
};

// ═══════════════════════════════════════════════════════════
//  s06 新增：Subagent —— 全新 messages[]，只回摘要
// ═══════════════════════════════════════════════════════════

export async function spawnSubagent(
  description: string,
  deps: Deps,
): Promise<string> {
  const { client } = deps;
  // 子 agent 用 scope="sub" 的 child logger：同一对文件，记录标注来源。
  const logger = deps.logger.child("sub");

  print("[Subagent spawned]", "magenta");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: description },
  ]; // fresh context
  let lastText = "";

  for (let turn = 0; turn < 30; turn++) {
    // safety limit
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system: SUB_SYSTEM,
      messages,
      tools: subTools,
      max_tokens: 8000,
    });
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });
    const text = textOf(response);
    if (text) lastText = text;
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      print(`> [sub] [${block.name}] ${JSON.stringify(block.input)}`, "cyan");
      // subagent 同样跑 hooks（权限一并生效）。
      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }

      const schema = BASE_SCHEMAS[block.name];
      const handler = BASE_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      await triggerHooks("PostToolUse", block, output);
      print(`  [sub] [${block.name}] ${output.slice(0, 100)}`, "gray");
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }

  logger.console("[Subagent done]", "magenta");
  // 兜底：命中安全上限时 lastText 保留最近一段 assistant 文本。
  // 只有摘要回到父 agent；subagent 的消息历史被丢弃。
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s05 一样（nag 机制复用 s05），task 自动分发到 subagent
//  唯一区别：handler 可能是 async，所以 `await handler(...)`。
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger } = deps;
  while (true) {
    nagIfStale(messages, logger);

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
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    bumpNagCounter();
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      print(`> [${block.name}] ${JSON.stringify(block.input)}`, "cyan");
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
      // s06: await —— task handler（spawnSubagent）是 async。
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await triggerHooks("PostToolUse", block, output);

      // todo_write 被调用即复位唠叨计数器。
      if (block.name === "todo_write") resetNagCounter();

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
// Prompt example: Use a subtask to find what testing framework this project uses
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  setHookLogger(logger);
  registerDefaultHooks();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print(
    "s06: Subagent — spawn sub-agents with fresh context, summary only",
    "cyan",
  );
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s06 >> ", "cyan"));
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

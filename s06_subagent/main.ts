/**
 * s06_subagent/main.ts - Subagent
 *
 * task 工具跑起第二个 agent loop，它的 messages[] 是全新的。两个循环共享
 * 工作目录，但只有最终文本会回到父对话里：
 *
 *   Parent agent                    Subagent
 *   +------------------+            +------------------+
 *   | messages=[...]   |            | messages=[prompt]|
 *   |                  |   task     |                  |
 *   | tool: task       | ---------> | own agent loop   |
 *   |                  |            | base tools only  |
 *   | tool_result      | <--------- | final text       |
 *   +------------------+            +------------------+
 *
 * 子 agent 没有 task 工具，所以无法继续委派。
 *
 * 相比 s05 的变化：
 *   工具层：父 agent 是 s02 的基础工具层 + 一个 task，和 code.py 一致；
 *          s05 的 todo_write 与唠叨提醒不在本章的工具表里。
 *          dispatch 复用 s05 的 BASE_HANDLERS（单一出处）。
 *   Hook 层：注册表/触发器与默认 hook 全部复用 s05（它又复用 s04），s06 不再重复定义。
 *   + task 工具 + 带全新 messages[] 的 spawnSubagent()
 *   + 安全限制：每个子 agent 最多 30 轮
 *   主循环几乎没变：task 通过 TOOL_HANDLERS 自动分发，唯一区别是
 *   `await handler(...)`，因为 spawnSubagent 是异步的。
 *
 * 基于 s05（todo_write）构建。Usage:
 *
 *     pnpm dev s06_subagent/main.ts
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger } from "../lib/logger";
import { createClient, MODEL_ID } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { hasToolUse, printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：基础工具层（bash + 四个文件工具）——父子 agent 都建立在这一层上。
import {
  tools as baseTools,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
} from "../s02_tool_use/main";
// 来自 s04：共享的 Deps 类型（client + logger + hooks）。
import type { Deps } from "../s04_hooks/main";
// 来自 s05：hook 装配（loadHooks = createHooks + registerDefaultHooks）+ 基础
// dispatch 表（BASE_HANDLERS）——单一出处在 s05。
import { BASE_HANDLERS, loadHooks } from "../s05_todo_write/main";

// s06 导出自己拥有的东西：agentLoop / spawnSubagent，
// 以及装配好的三张工具表（base + task），供 s07 继续叠加。
// 复用来的符号由测试各自从源头（s01/s04/s05）import。

const WORKDIR = process.cwd();

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task for focused exploration or a self-contained subtask.";

// s06: subagent 自己的 system prompt。
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the given task, then return a concise final answer.";

// ═══════════════════════════════════════════════════════════
//  工具装配：父 agent = base + task；subagent = base
//  三张表都用展开语法在基础之上追加一个 task，调用点（agentLoop）不用改。
// ═══════════════════════════════════════════════════════════

const taskSchema = z.object({ prompt: z.string().min(1) });

// subagent 只拿基础工具层（没有 task），从源头杜绝递归派生。
const subTools = baseTools;

// 三张装配表导出，供 s07 在其上继续叠加。
export const tools: Anthropic.Tool[] = [
  ...baseTools,
  // s06 新增：task 工具
  zodTool(
    "task",
    "Run a subagent with fresh conversation context and return its final text.",
    taskSchema,
  ),
];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
  task: taskSchema,
};

// handler 可能是 async：task -> spawnSubagent 返回 Promise。
// 第二参 deps 让 task 拿到 client/logger；基础 handler 是 (input)=>string，忽略它。
export const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: Deps) => string | Promise<string>>
> = {
  ...BASE_HANDLERS,
  task: ({ prompt }, deps) => spawnSubagent(prompt, deps),
};

// ═══════════════════════════════════════════════════════════
//  s06 新增：Subagent —— 全新 messages[]，只回最终文本
// ═══════════════════════════════════════════════════════════

export async function spawnSubagent(
  prompt: string,
  deps: Deps,
): Promise<string> {
  const { client, hooks } = deps;
  // 子 agent 用 scope="sub" 的 child logger：同一对文件，记录标注来源。
  const logger = deps.logger.child("sub");

  logger.console("[Subagent started]", "magenta");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ]; // fresh context

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

    if (!hasToolUse(response)) {
      // 子循环同样跑 Stop hook：拿到文案就再问一轮。
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      logger.console("[Subagent done]", "magenta");
      // 只有最终文本回到父 agent；subagent 的消息历史被丢弃。
      // 空回复由 textOf 补上占位文案，不会返回空字符串。
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      print(`> [sub] [${block.name}] ${JSON.stringify(block.input)}`, "cyan");
      // subagent 同样跑父实例的 hooks（权限一并生效）。
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
      const handler = BASE_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      await hooks.trigger("PostToolUse", block, output);
      print(`  [sub] [${block.name}] ${output.slice(0, 100)}`, "gray");
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }

  // 兜底：撞上 30 轮安全上限时，父 agent 收到的就是这句话。
  logger.console("[Subagent stopped]", "magenta");
  return "Subagent stopped after 30 turns without a final answer.";
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s05 一样，task 自动分发到 subagent
//  唯一区别：handler 可能是 async，所以 `await handler(...)`。
// ═══════════════════════════════════════════════════════════

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
      // s06: await —— task handler（spawnSubagent）是 async。
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

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
// Prompt example: Use a subtask to find what testing framework this project uses
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  const hooks = loadHooks(logger);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print("s06: Subagent - fresh messages, final text returns", "cyan");
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
    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });

    const finalText = await agentLoop(history, { client, logger, hooks });
    print(finalText, "green");
    print();
  }
  rl.close();
}

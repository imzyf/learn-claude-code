/**
 * s01_agent_loop/main.ts - Agent 循环
 *
 * AI 编程 agent 的全部秘密就在这一个模式里：
 *
 *     while stop_reason == "tool_use":
 *         result = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool result |
 *                           +---------------+
 *                           (loop continues)
 *
 * 这就是核心循环：把工具执行结果喂回给模型，
 * 直到模型自己决定停止。生产环境中的 agent 会在此之上
 * 叠加策略、hooks 和生命周期控制。
 *
 * Anthropic SDK 的 messages.create 本来就只返回 tool_use 块、不执行工具，
 * 循环控制权天然在这份代码里——这就是 s01 要讲的道理。
 *
 * Usage:
 *     pnpm dev s01_agent_loop/main.ts
 */

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type SessionLogger } from "../lib/logger";

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── Tool definition: just bash ────────────────────────────
const bashSchema = z.object({ command: z.string() });
const tools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
];

// ── Tool execution ────────────────────────────────────────
/** @internal 仅测试用，非公开 API */
export function isDangerous(command: string): boolean {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  return dangerous.some((d) => command.includes(d));
}

export function runBash(command: string, timeoutMs = 120_000): string {
  if (isDangerous(command)) {
    return "Error: Dangerous command blocked";
  }
  const r = spawnSync(command, {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT")
      return `Error: Timeout (${Math.round(timeoutMs / 1000)}s)`;
    return `Error: ${r.error.message}`;
  }
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return out ? out.slice(0, 50_000) : "(no output)";
}

// ── The core pattern: a while loop that calls tools until the model stops ──
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

    // Append assistant turn (includes any tool-call blocks)
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    // Execute each tool call, collect results
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = bashSchema.parse(block.input);
      console.log(`\x1b[33m$ ${input.command}\x1b[0m`);
      const output = runBash(input.command);
      console.log(output.slice(0, 200));
      logger.toolResult(input.command, output);
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

  console.log("s01: Agent Loop");
  console.log("输入问题，回车发送。输入 q 退出。\n");

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
      query = await rl.question("\x1b[36ms01 >> \x1b[0m");
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger });
    console.log(finalText);
    console.log();
  }
  rl.close();
}

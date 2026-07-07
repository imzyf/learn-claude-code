/**
 * s01_agent_loop/main.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while finishReason == "tool-calls":
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
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 *
 * The bash tool below has no `execute` function on purpose:
 * the AI SDK then returns tool calls instead of running them,
 * so this file owns the loop — that is the lesson of s01.
 *
 * Usage:
 *     pnpm dev s01_agent_loop/main.ts
 */

import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { model } from "../lib/model";

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── Tool definition: just bash ────────────────────────────
const tools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
    // no execute → the SDK hands the call back to us
  }),
};

// ── Tool execution ────────────────────────────────────────
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  const r = spawnSync(command, {
    shell: true,
    cwd: process.cwd(),
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

// ── The core pattern: a while loop that calls tools until the model stops ──
async function agentLoop(messages: ModelMessage[]): Promise<string> {
  while (true) {
    const result = await generateText({
      model,
      system: SYSTEM,
      messages,
      tools,
      maxOutputTokens: 8000,
    });

    // Append assistant turn (includes any tool-call blocks)
    messages.push(...result.response.messages);

    // If the model didn't call a tool, we're done
    if (result.finishReason !== "tool-calls") {
      return result.text;
    }

    // Execute each tool call, collect results
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[33m$ ${call.input.command}\x1b[0m`);
      const output = runBash(call.input.command);
      console.log(output.slice(0, 200));
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }

    // Feed tool results back, loop continues
    messages.push({ role: "tool", content: results });
  }
}

// ── Entry point ──────────────────────────────────────────
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

const history: ModelMessage[] = [];
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms01 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history);
  console.log(finalText);
  console.log();
}
rl.close();

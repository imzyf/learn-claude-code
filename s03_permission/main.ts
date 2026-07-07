/**
 * s03_permission/main.ts - Permission System
 *
 * Three gates inserted before tool execution:
 *
 *     Gate 1: Hard deny list (rm -rf /, sudo, ...)
 *     Gate 2: Rule matching (write outside workspace? destructive cmd?)
 *     Gate 3: User approval (pause and wait for confirmation)
 *
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *     | Tool  | -> | Gate 1 | -> | Gate 2 | -> | Gate 3 | -> | Exec |
 *     | call  |    | deny?  |    | match? |    | allow? |    |      |
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *          |            |             |             |
 *          v            v             v             v
 *       (normal)     (blocked)    (ask user)   (user says no?)
 *
 * Only one line added to the agent loop:
 *
 *     if (!(await checkPermission(call))) continue;
 *
 * Two other diffs from s02:
 *   - runBash lost its inline dangerous-command check — Gate 1 owns it now
 *   - the readline interface moved up: Gate 3 (askUser) shares it with the REPL
 *
 * Builds on s02 (multi-tool). Usage:
 *
 *     pnpm dev s03_permission/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { generateText, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { model } from "../lib/model";

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  FROM s02: Tool Implementations
//  (runBash changed: inline dangerous-check removed, Gate 1 replaces it)
// ═══════════════════════════════════════════════════════════

function runBash(command: string): string {
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

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runRead(p: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(p), "utf8").split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf8");
    // indexOf + slice instead of String.replace: replace would treat
    // `$&`-style patterns in newText as special replacement syntax.
    const i = text.indexOf(oldText);
    if (i === -1) return `Error: text not found in ${p}`;
    fs.writeFileSync(filePath, text.slice(0, i) + newText + text.slice(i + oldText.length));
    return `Edited ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const results = fs
      .globSync(pattern, { cwd: WORKDIR })
      .filter((m) => path.resolve(WORKDIR, m).startsWith(WORKDIR + path.sep));
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

// ═══════════════════════════════════════════════════════════
//  FROM s02 (unchanged): Tool Definitions & Dispatch
// ═══════════════════════════════════════════════════════════

const tools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({ path: z.string(), limit: z.number().int().optional() }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
  edit_file: tool({
    description: "Replace exact text in a file once.",
    inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
  }),
  glob: tool({
    description: "Find files matching a glob pattern.",
    inputSchema: z.object({ pattern: z.string() }),
  }),
};

// `input: any` mirrors Python's `handler(**block.input)` — each handler
// destructures the shape its inputSchema guarantees.
const TOOL_HANDLERS: Record<string, (input: any) => string> = {
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
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
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

function checkRules(toolName: string, args: unknown): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}

// Gate 3: User approval — wait for confirmation after rule match.
// Shares the REPL's readline interface (Python just calls input()).
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

async function askUser(toolName: string, args: unknown, reason: string): Promise<"allow" | "deny"> {
  console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  let choice: string;
  try {
    choice = (await rl.question("   Allow? [y/N] ")).trim().toLowerCase();
  } catch {
    return "deny"; // stdin closed — nobody left to approve
  }
  return choice === "y" || choice === "yes" ? "allow" : "deny";
}

// Pipeline: all three gates chained
async function checkPermission(call: { toolName: string; input: any }): Promise<boolean> {
  if (call.toolName === "bash") {
    const reason = checkDenyList(call.input.command ?? "");
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return false;
    }
  }
  const reason = checkRules(call.toolName, call.input);
  if (reason) {
    const decision = await askUser(call.toolName, call.input, reason);
    if (decision === "deny") return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s02, with checkPermission() inserted
// ═══════════════════════════════════════════════════════════

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

    // Execute each tool call via the dispatch map, collect results
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await checkPermission(call))) {
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: "Permission denied." },
        });
        continue;
      }

      const handler = TOOL_HANDLERS[call.toolName];
      const output = handler ? handler(call.input) : `Unknown: ${call.toolName}`;
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
console.log("s03: Permission");
console.log("输入问题，回车发送。输入 q 退出。\n");

const history: ModelMessage[] = [];
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms03 >> \x1b[0m");
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

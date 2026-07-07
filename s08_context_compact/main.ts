/**
 * s08_context_compact/main.ts - Context Compact
 *
 * Four-layer compaction pipeline inserted before LLM calls:
 *
 *     L1: snipCompact       — trim middle messages when count > 50
 *     L2: microCompact      — replace old tool results with placeholders
 *     L3: toolResultBudget  — persist large results to disk
 *     L4: compactHistory    — LLM full summary (1 API call)
 *
 *     Emergency: reactiveCompact — when API still returns prompt_too_long
 *
 *     ┌─────────────────────────────────────────────────────────────┐
 *     │  messages[]                                                 │
 *     │    ↓                                                        │
 *     │  L3 budget ─→ L1 snip ─→ L2 micro ─→ [size > threshold?]   │
 *     │                                      ├─ No  → LLM          │
 *     │                                      └─ Yes → L4 summary   │
 *     │                                              ↓              │
 *     │                                          LLM call           │
 *     │                                    [prompt_too_long?]       │
 *     │                                      └─ Yes → reactive      │
 *     └─────────────────────────────────────────────────────────────┘
 *
 * Core principle: cheap first, expensive last.
 * Execution order matches CC source: budget → snip → micro → auto.
 *
 * Changes from s07:
 *   + compaction pipeline (snip/micro/budget/auto + reactive)
 *   + compact tool — the model can ask for a summary itself
 *   - nag reminder and UserPromptSubmit/Stop hooks dropped (focus on compaction)
 *
 * TS-specific diffs:
 *   - Python detects tool results as user messages with tool_result blocks;
 *     the AI SDK gives them their own `role: "tool"` messages instead.
 *   - Python appends a tool_result AFTER replacing history with the compact
 *     summary — against the real API that orphan tool_result is rejected, so
 *     here the summary alone continues the loop.
 *
 * Builds on s07 (skill loading). Usage:
 *
 *     pnpm dev s08_context_compact/main.ts
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
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  FROM s07 (unchanged): Skill catalog + SYSTEM
// ═══════════════════════════════════════════════════════════

type Skill = { name: string; description: string; content: string };

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).trim().split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(end + 3).trim() };
}

const SKILL_REGISTRY: Record<string, Skill> = {};

function scanSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) return;
  const entries = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const { meta } = parseFrontmatter(raw);
    const name = meta.name ?? entry.name;
    const description = meta.description ?? (raw.split("\n")[0] ?? "").replace(/^#+/, "").trim();
    SKILL_REGISTRY[name] = { name, description, content: raw };
  }
}

scanSkills();

function listSkills(): string {
  const skills = Object.values(SKILL_REGISTRY);
  if (!skills.length) return "(no skills found)";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

function buildSystem(): string {
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${listSkills()}\n` +
    "Use load_skill to get full details when needed."
  );
}

const SYSTEM = buildSystem();

// s08: subagent gets its own system prompt — no compact, no skill loading
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// ═══════════════════════════════════════════════════════════
//  FROM s02-s07 (unchanged): Basic Tools
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

// FROM s05 (unchanged): todo_write

const todoItem = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
type Todo = z.infer<typeof todoItem>;

let currentTodos: Todo[] = [];

function normalizeTodos(todos: unknown): { todos?: Todo[]; error?: string } {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { error: "Error: todos must be a list or JSON array string" };
    }
  }
  const parsed = z.array(todoItem).safeParse(todos);
  if (!parsed.success) {
    return { error: "Error: todos must be a list of {content, status} objects" };
  }
  return { todos: parsed.data };
}

function runTodoWrite(todosInput: unknown): string {
  const { todos, error } = normalizeTodos(todosInput);
  if (error || !todos) return error ?? "Error: invalid todos";
  currentTodos = todos;
  const icons: Record<Todo["status"], string> = {
    pending: " ",
    in_progress: "\x1b[36m▸\x1b[0m",
    completed: "\x1b[32m✓\x1b[0m",
  };
  const lines = ["\n\x1b[33m## Current Tasks\x1b[0m"];
  for (const t of currentTodos) {
    lines.push(`  [${icons[t.status]}] ${t.content}`);
  }
  console.log(lines.join("\n"));
  return `Updated ${currentTodos.length} tasks`;
}

// ═══════════════════════════════════════════════════════════
//  NEW in s08: Four-Layer Compaction Pipeline
// ═══════════════════════════════════════════════════════════

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30_000;

const estimateSize = (msgs: ModelMessage[]): number => JSON.stringify(msgs).length;

// Replace an array's contents in place — callers hold the same reference
// (mirrors Python's `messages[:] = ...`).
function setMessages(messages: ModelMessage[], next: ModelMessage[]): void {
  messages.splice(0, messages.length, ...next);
}

const messageHasToolCall = (m: ModelMessage): boolean =>
  m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool-call");

// AI SDK diff: tool results are `role: "tool"` messages, not user messages
// carrying tool_result blocks as in the Anthropic SDK.
const isToolResultMessage = (m: ModelMessage): boolean => m.role === "tool";

const outputText = (part: ToolResultPart): string =>
  part.output.type === "text" ? part.output.value : JSON.stringify(part.output);

// L1: snipCompact — trim middle messages
function snipCompact(messages: ModelMessage[], maxMessages = 50): ModelMessage[] {
  if (messages.length <= maxMessages) return messages;
  const keepHead = 3;
  const keepTail = maxMessages - 3;
  let headEnd = keepHead;
  let tailStart = messages.length - keepTail;
  // never split a tool-call/tool-result pair at either boundary
  if (headEnd > 0 && messageHasToolCall(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) headEnd += 1;
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}

// L2: microCompact — old result placeholders
function collectToolResults(messages: ModelMessage[]): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const part of m.content) {
      if (part.type === "tool-result") parts.push(part);
    }
  }
  return parts;
}

function microCompact(messages: ModelMessage[]): ModelMessage[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;
  for (const part of toolResults.slice(0, -KEEP_RECENT)) {
    if (part.output.type === "text" && part.output.value.length > 120) {
      part.output = { type: "text", value: "[Earlier tool result compacted. Re-run if needed.]" };
    }
  }
  return messages;
}

// L3: toolResultBudget — persist large results to disk
function persistLargeOutput(toolCallId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolCallId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

function toolResultBudget(messages: ModelMessage[], maxBytes = 200_000): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool") return messages;
  const blocks = last.content.filter((b): b is ToolResultPart => b.type === "tool-result");
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort((a, b) => outputText(b).length - outputText(a).length);
  for (const block of ranked) {
    if (total <= maxBytes) break;
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;
    block.output = { type: "text", value: persistLargeOutput(block.toolCallId, content) };
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }
  return messages;
}

// L4: autoCompact — LLM full summary
function writeTranscript(messages: ModelMessage[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return filePath;
}

async function summarizeHistory(messages: ModelMessage[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" +
    conversation;
  const { text } = await generateText({ model, prompt, maxOutputTokens: 2000 });
  return text.trim() || "(empty summary)";
}

async function compactHistory(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// Emergency: reactiveCompact — on API error
async function reactiveCompact(messages: ModelMessage[]): Promise<ModelMessage[]> {
  writeTranscript(messages);
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolCall(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  const summary = await summarizeHistory(messages.slice(0, tailStart));
  return [{ role: "user", content: `[Reactive compact]\n\n${summary}` }, ...messages.slice(tailStart)];
}

// ═══════════════════════════════════════════════════════════
//  FROM s07: Tool Definitions
// ═══════════════════════════════════════════════════════════

// Shared by parent and subagent (Python re-declares SUB_TOOLS by hand)
const fileTools = {
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

const tools = {
  ...fileTools,
  todo_write: tool({
    description: "Create and manage a task list for your current coding session.",
    inputSchema: z.object({ todos: z.union([z.array(todoItem), z.string()]) }),
  }),
  task: tool({
    description:
      "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    inputSchema: z.object({ description: z.string() }),
  }),
  load_skill: tool({
    description: "Load the full content of a skill by name.",
    inputSchema: z.object({ name: z.string() }),
  }),
  // s08 change: new compact tool — triggers compactHistory, not a no-op
  compact: tool({
    description: "Summarize earlier conversation to free context space.",
    inputSchema: z.object({ focus: z.string().optional() }),
  }),
};

// NO "task" tool — prevent recursive spawning
const subTools = fileTools;

const SUB_HANDLERS: Record<string, (input: any) => string> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// compact is NOT here — the loop intercepts it (it rewrites messages[])
const TOOL_HANDLERS: Record<string, (input: any) => string | Promise<string>> = {
  ...SUB_HANDLERS,
  todo_write: ({ todos }) => runTodoWrite(todos),
  task: ({ description }) => spawnSubagent(description),
  load_skill: ({ name }) => loadSkill(name),
};

// ═══════════════════════════════════════════════════════════
//  FROM s06-s07 (unchanged): Subagent
// ═══════════════════════════════════════════════════════════

async function spawnSubagent(description: string): Promise<string> {
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: ModelMessage[] = [{ role: "user", content: description }]; // fresh context
  let lastText = "";

  for (let turn = 0; turn < 30; turn++) {
    // safety limit
    const result = await generateText({
      model,
      system: SUB_SYSTEM,
      messages,
      tools: subTools,
      maxOutputTokens: 8000,
    });
    messages.push(...result.response.messages);
    if (result.text) lastText = result.text;
    if (result.finishReason !== "tool-calls") break;

    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;

      const blocked = triggerHooks("PreToolUse", call);
      if (blocked) {
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: blocked },
        });
        continue;
      }

      const handler = SUB_HANDLERS[call.toolName];
      const output = handler ? handler(call.input) : `Unknown: ${call.toolName}`;
      triggerHooks("PostToolUse", call, output);
      console.log(`  \x1b[90m[sub] ${call.toolName}: ${output.slice(0, 100)}\x1b[0m`);
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }
    messages.push({ role: "tool", content: results });
  }

  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  // Only the summary returns; the subagent's message history is discarded.
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  FROM s04 (reduced): Hooks — s08 keeps only PreToolUse/PostToolUse
// ═══════════════════════════════════════════════════════════

type Hook = (...args: any[]) => string | null;
type ToolCallInfo = { toolName: string; input: any };

const HOOKS: Record<string, Hook[]> = { PreToolUse: [], PostToolUse: [] };

function triggerHooks(event: string, ...args: any[]): string | null {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result != null) return result;
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown"];

function permissionHook(call: ToolCallInfo): string | null {
  if (call.toolName === "bash") {
    for (const pattern of DENY_LIST) {
      if ((call.input.command ?? "").includes(pattern)) return "Permission denied";
    }
  }
  return null;
}

function logHook(call: ToolCallInfo): null {
  console.log(`\x1b[90m[HOOK] ${call.toolName}\x1b[0m`);
  return null;
}

HOOKS.PreToolUse.push(permissionHook, logHook);

// ═══════════════════════════════════════════════════════════
//  agentLoop — s08 core: run compaction pipeline before LLM
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1; // retry limit for reactive compact

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  let reactiveRetries = 0;
  while (true) {
    // s08 change: three preprocessors (0 API calls, cheap first)
    // Order matches CC source: budget → snip → micro
    setMessages(messages, toolResultBudget(messages)); // L3: persist large results first
    setMessages(messages, snipCompact(messages)); // L1: trim middle
    setMessages(messages, microCompact(messages)); // L2: old result placeholders

    // s08 change: size still over threshold → LLM summary (1 API call)
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      setMessages(messages, await compactHistory(messages));
    }

    let result;
    try {
      result = await generateText({
        model,
        system: SYSTEM,
        messages,
        tools,
        maxOutputTokens: 8000,
      });
      reactiveRetries = 0; // reset on successful API call
    } catch (e) {
      const msg = errMsg(e).toLowerCase();
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log("[reactive compact]");
        setMessages(messages, await reactiveCompact(messages));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

    messages.push(...result.response.messages);
    if (result.finishReason !== "tool-calls") return result.text;

    let didCompact = false;
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);

      // s08: compact tool rewrites the whole history with a summary. The
      // tool-call that asked for it is summarized away too, so appending its
      // tool result (as the Python does) would orphan it and the API would
      // reject the next request — the summary alone continues the loop.
      if (call.toolName === "compact") {
        setMessages(messages, await compactHistory(messages));
        didCompact = true;
        break; // end current turn, start fresh with compacted context
      }

      const blocked = triggerHooks("PreToolUse", call);
      if (blocked) {
        results.push({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: blocked },
        });
        continue;
      }

      const handler = TOOL_HANDLERS[call.toolName];
      const output = handler ? await handler(call.input) : `Unknown: ${call.toolName}`;
      triggerHooks("PostToolUse", call, output);
      console.log(output.slice(0, 200));
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }

    if (didCompact) continue;
    messages.push({ role: "tool", content: results });
  }
}

// ── Entry point ──────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

console.log("s08: Context Compact — four-layer compaction pipeline");
console.log("输入问题，回车发送。输入 q 退出。\n");

const history: ModelMessage[] = [];
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms08 >> \x1b[0m");
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

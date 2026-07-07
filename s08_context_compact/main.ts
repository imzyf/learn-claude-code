/**
 * s08_context_compact/main.ts - 上下文压缩
 *
 * 在调用 LLM 之前插入四层压缩流水线：
 *
 *     L1: snipCompact       —— 消息数 > 50 时裁剪中间部分
 *     L2: microCompact      —— 用占位符替换较早的工具结果
 *     L3: toolResultBudget  —— 把大结果持久化到磁盘
 *     L4: compactHistory    —— LLM 完整摘要（1 次 API 调用）
 *
 *     应急：reactiveCompact —— API 仍返回 prompt_too_long 时触发
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
 * 核心原则：先做便宜的，最后才做昂贵的。
 * 执行顺序与 CC 源码一致：budget → snip → micro → auto。
 *
 * 相比 s07 的变化：
 *   + 压缩流水线（snip/micro/budget/auto + reactive）
 *   + compact 工具——模型可以自己请求生成摘要
 *   - 去掉了唠叨提醒和 UserPromptSubmit/Stop hooks（专注于压缩本身）
 *
 * 一点需要注意：用压缩摘要替换历史记录后，不能再追加一个孤立的
 * tool_result（引用一个已经被摘要抹掉的 tool_use）——真实 API 会拒绝
 * 这种孤立的 tool_result，所以这里只用摘要本身继续推进循环。
 *
 * 基于 s07（skill loading）构建。Usage:
 *
 *     pnpm dev s08_context_compact/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";
import { createLogger, type SessionLogger } from "../lib/logger";

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// client 与 logger 通过参数注入到 agentLoop / spawnSubagent。
export type Deps = { client: ModelClient; logger: SessionLogger };

// ═══════════════════════════════════════════════════════════
//  FROM s07 (unchanged): Skill catalog + SYSTEM
// ═══════════════════════════════════════════════════════════

export type Skill = { name: string; description: string; content: string };
export type SkillRegistry = Record<string, Skill>;

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
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

// Scan a skills/ dir into a registry (pure: takes dir, returns registry).
export function scanSkills(dir: string): SkillRegistry {
  const registry: SkillRegistry = {};
  if (!fs.existsSync(dir)) return registry;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf8");
    const { meta } = parseFrontmatter(raw);
    const name = meta.name ?? entry.name;
    const description = meta.description ?? (raw.split("\n")[0] ?? "").replace(/^#+/, "").trim();
    registry[name] = { name, description, content: raw };
  }
  return registry;
}

export function listSkills(registry: SkillRegistry): string {
  const skills = Object.values(registry);
  if (!skills.length) return "(no skills found)";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

export function loadSkill(registry: SkillRegistry, name: string): string {
  const skill = registry[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

export function buildSystem(registry: SkillRegistry): string {
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${listSkills(registry)}\n` +
    "Use load_skill to get full details when needed."
  );
}

// s08: subagent gets its own system prompt — no compact, no skill loading
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// ═══════════════════════════════════════════════════════════
//  FROM s02-s07 (unchanged): Basic Tools
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

export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function runRead(p: string, limit?: number): string {
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

export function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export function runEdit(p: string, oldText: string, newText: string): string {
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

export function runGlob(pattern: string): string {
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

export function normalizeTodos(todos: unknown): { todos?: Todo[]; error?: string } {
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

export function runTodoWrite(todosInput: unknown): string {
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

export const estimateSize = (msgs: Anthropic.MessageParam[]): number => JSON.stringify(msgs).length;

// Replace an array's contents in place — callers hold the same reference
// (mirrors Python's `messages[:] = ...`).
export function setMessages(messages: Anthropic.MessageParam[], next: Anthropic.MessageParam[]): void {
  messages.splice(0, messages.length, ...next);
}

const messageHasToolCall = (m: Anthropic.MessageParam): boolean =>
  m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");

// Tool results are user messages carrying tool_result content blocks.
const isToolResultMessage = (m: Anthropic.MessageParam): boolean =>
  m.role === "user" &&
  Array.isArray(m.content) &&
  m.content.some((b) => typeof b !== "string" && b.type === "tool_result");

const outputText = (part: Anthropic.ToolResultBlockParam): string =>
  typeof part.content === "string" ? part.content : JSON.stringify(part.content);

// L1: snipCompact — trim middle messages
export function snipCompact(
  messages: Anthropic.MessageParam[],
  maxMessages = 50,
): Anthropic.MessageParam[] {
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
export function collectToolResults(
  messages: Anthropic.MessageParam[],
): Anthropic.ToolResultBlockParam[] {
  const parts: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (typeof part !== "string" && part.type === "tool_result") parts.push(part);
    }
  }
  return parts;
}

export function microCompact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;
  for (const part of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content === "string" && part.content.length > 120) {
      part.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}

// L3: toolResultBudget — persist large results to disk
export function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

export function toolResultBudget(
  messages: Anthropic.MessageParam[],
  maxBytes = 200_000,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return messages;
  const blocks = last.content.filter(
    (b): b is Anthropic.ToolResultBlockParam => typeof b !== "string" && b.type === "tool_result",
  );
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort((a, b) => outputText(b).length - outputText(a).length);
  for (const block of ranked) {
    if (total <= maxBytes) break;
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;
    block.content = persistLargeOutput(block.tool_use_id, content);
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }
  return messages;
}

// L4: autoCompact — LLM full summary
function writeTranscript(messages: Anthropic.MessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return filePath;
}

export async function summarizeHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger } = deps;
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" +
    conversation;
  const request: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  logger.request(request);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 2000,
    messages: request,
  });
  logger.response(response);
  return textOf(response).trim() || "(empty summary)";
}

export async function compactHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages, deps);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// Emergency: reactiveCompact — on API error
export async function reactiveCompact(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
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
  const summary = await summarizeHistory(messages.slice(0, tailStart), deps);
  return [{ role: "user", content: `[Reactive compact]\n\n${summary}` }, ...messages.slice(tailStart)];
}

// ═══════════════════════════════════════════════════════════
//  FROM s07: Tool Definitions
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });
const todoWriteSchema = z.object({ todos: z.union([z.array(todoItem), z.string()]) });
const taskSchema = z.object({ description: z.string() });
const loadSkillSchema = z.object({ name: z.string() });
const compactSchema = z.object({ focus: z.string().optional() });

// Shared by parent and subagent (Python re-declares SUB_TOOLS by hand)
const fileTools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
];

const FILE_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
  edit_file: editSchema,
  glob: globSchema,
};

const tools: Anthropic.Tool[] = [
  ...fileTools,
  zodTool(
    "todo_write",
    "Create and manage a task list for your current coding session.",
    todoWriteSchema,
  ),
  zodTool(
    "task",
    "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    taskSchema,
  ),
  zodTool("load_skill", "Load the full content of a skill by name.", loadSkillSchema),
  // s08 change: new compact tool — triggers compactHistory, not a no-op
  zodTool("compact", "Summarize earlier conversation to free context space.", compactSchema),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...FILE_SCHEMAS,
  todo_write: todoWriteSchema,
  task: taskSchema,
  load_skill: loadSkillSchema,
  compact: compactSchema,
};

// NO "task" tool — prevent recursive spawning
const subTools = fileTools;

const SUB_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path, limit }) => runRead(path, limit),
  write_file: ({ path, content }) => runWrite(path, content),
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
};

// agentLoop 需要的完整依赖：基础 Deps + 技能表 + 本轮 system prompt。
export type LoopDeps = Deps & { skills: SkillRegistry; system: string };

// compact is NOT here — the loop intercepts it (it rewrites messages[])
const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: LoopDeps) => string | Promise<string>>
> = {
  ...SUB_HANDLERS,
  todo_write: ({ todos }) => runTodoWrite(todos),
  task: ({ description }, deps) => spawnSubagent(description, deps),
  load_skill: ({ name }, deps) => loadSkill(deps.skills, name),
};

// ═══════════════════════════════════════════════════════════
//  FROM s06-s07 (unchanged): Subagent
// ═══════════════════════════════════════════════════════════

export async function spawnSubagent(description: string, deps: Deps): Promise<string> {
  const { client, logger } = deps;
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: description }]; // fresh context
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

      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
        });
        continue;
      }

      const schema = FILE_SCHEMAS[block.name];
      const handler = SUB_HANDLERS[block.name];
      const output = handler && schema ? handler(schema.parse(block.input)) : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      await triggerHooks("PostToolUse", block, output);
      console.log(`  \x1b[90m[sub] ${block.name}: ${output.slice(0, 100)}\x1b[0m`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }

  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  // Only the summary returns; the subagent's message history is discarded.
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  FROM s04 (reduced): Hooks — s08 keeps only PreToolUse/PostToolUse
// ═══════════════════════════════════════════════════════════

// `...args: any[]` mirrors Python's `callback(*args)`.
type Hook = (...args: any[]) => string | null | Promise<string | null>;
type ToolCallInfo = Anthropic.ToolUseBlock;

const HOOKS: Record<string, Hook[]> = { PreToolUse: [], PostToolUse: [] };

export function registerHook(event: string, callback: Hook): void {
  HOOKS[event].push(callback);
}

export async function triggerHooks(event: string, ...args: any[]): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) return result;
  }
  return null;
}

// 测试用：清空注册表，隔离用例（入口通过 registerDefaultHooks 注册）。
export function clearHooks(): void {
  for (const event of Object.keys(HOOKS)) HOOKS[event] = [];
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "osascript"];

export function permissionHook(call: ToolCallInfo): string | null {
  if (call.name === "bash") {
    for (const pattern of DENY_LIST) {
      if (((call.input as any).command ?? "").includes(pattern)) return "Permission denied";
    }
  }
  return null;
}

export function logHook(call: ToolCallInfo): null {
  console.log(`\x1b[90m[HOOK] ${call.name}\x1b[0m`);
  return null;
}

export function registerDefaultHooks(): void {
  registerHook("PreToolUse", permissionHook);
  registerHook("PreToolUse", logHook);
}

// ═══════════════════════════════════════════════════════════
//  agentLoop — s08 core: run compaction pipeline before LLM
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1; // retry limit for reactive compact

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, system } = deps;
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
      setMessages(messages, await compactHistory(messages, deps));
    }

    let response;
    try {
      logger.request(messages);
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages,
        tools,
        max_tokens: 8000,
      });
      logger.response(response);
      reactiveRetries = 0; // reset on successful API call
    } catch (e) {
      const msg = errMsg(e).toLowerCase();
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log("[reactive compact]");
        setMessages(messages, await reactiveCompact(messages, deps));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return textOf(response);

    let didCompact = false;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s08: compact tool rewrites the whole history with a summary. The
      // tool-call that asked for it is summarized away too, so appending its
      // tool result (as the Python does) would orphan it and the API would
      // reject the next request — the summary alone continues the loop.
      if (block.name === "compact") {
        setMessages(messages, await compactHistory(messages, deps));
        didCompact = true;
        break; // end current turn, start fresh with compacted context
      }

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
        handler && schema ? await handler(schema.parse(block.input), deps) : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
      await triggerHooks("PostToolUse", block, output);
      console.log(output.slice(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    if (didCompact) continue;
    messages.push({ role: "user", content: results });
  }
}

// ── Entry point ──────────────────────────────────────────
// import.meta.main 只在文件被直接运行时为 true。
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  const skills = scanSkills(SKILLS_DIR);
  const system = buildSystem(skills);
  logger.config({ model: MODEL_ID, system, tools });
  registerDefaultHooks();

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

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question("\x1b[36ms08 >> \x1b[0m");
    } catch {
      break; // stdin closed (Ctrl+D)
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, skills, system });
    console.log(finalText);
    console.log();
  }
  rl.close();
}

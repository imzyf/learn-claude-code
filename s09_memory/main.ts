/**
 * s09_memory/main.ts - 记忆系统
 *
 * 为编程 agent 提供持久化、跨会话的知识。
 *
 * 存储结构：
 *     .memory/
 *       MEMORY.md          ← 索引（每条记忆一行，不超过 200 行）
 *       feedback-tabs.md   ← 各个记忆文件（Markdown + YAML frontmatter）
 *       user-profile.md
 *       project-facts.md
 *
 * agentLoop 中的流程：
 *     1. 把 MEMORY.md 索引加载进 SYSTEM prompt（便宜，始终存在）
 *     2. 按文件名/描述筛选出相关记忆 → 注入具体内容
 *     3. 运行 s08 的压缩流水线
 *     4. 每轮结束后 → 从原始消息中提取新记忆
 *     5. 定期整合（Dream）
 *
 * 相比 s08 的变化（精简版——减少工具数量，聚焦记忆本身）：
 *   + 记忆文件 + MEMORY.md 索引，每轮都注入 SYSTEM
 *   + selectRelevantMemories/loadMemories —— 由 LLM 挑选，关键词兜底
 *   + 每轮后 extractMemories，文件数 ≥10 时 consolidateMemories
 *   - 去掉了 skills、todo_write 和 hooks
 *
 * 基于 s08（context compact）构建。Usage:
 *
 *     pnpm dev s09_memory/main.ts
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
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

fs.mkdirSync(MEMORY_DIR, { recursive: true });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  NEW in s09: Memory System
// ═══════════════════════════════════════════════════════════

// Python keeps a MEMORY_TYPES list; a union type does the same job in TS.
type MemoryType = "user" | "feedback" | "project" | "reference";

type MemoryFile = {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
};

// Note a JS gotcha vs Python: `text.split("---", 2)` in JS TRUNCATES the rest,
// while Python keeps it in the last part — so slice by index instead.
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

// Write a single memory file with YAML frontmatter.
function writeMemoryFile(name: string, memType: string, description: string, body: string): string {
  const slug = name.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-");
  const filepath = path.join(MEMORY_DIR, `${slug}.md`);
  fs.writeFileSync(
    filepath,
    `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`,
  );
  rebuildIndex();
  return filepath;
}

function memoryFilenames(): string[] {
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort();
}

// Rebuild MEMORY.md index from all memory files.
function rebuildIndex(): void {
  const lines: string[] = [];
  for (const filename of memoryFilenames()) {
    const raw = fs.readFileSync(path.join(MEMORY_DIR, filename), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name ?? path.basename(filename, ".md");
    const desc = meta.description ?? (body.split("\n")[0] ?? "").slice(0, 80);
    lines.push(`- [${name}](${filename}) — ${desc}`);
  }
  fs.writeFileSync(MEMORY_INDEX, lines.length ? lines.join("\n") + "\n" : "");
}

// Read MEMORY.md index (injected into SYSTEM every turn).
function readMemoryIndex(): string {
  if (!fs.existsSync(MEMORY_INDEX)) return "";
  return fs.readFileSync(MEMORY_INDEX, "utf8").trim();
}

// Read a single memory file's full content.
function readMemoryFile(filename: string): string | null {
  const filepath = path.join(MEMORY_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf8");
}

// List all memory files with metadata.
function listMemoryFiles(): MemoryFile[] {
  return memoryFilenames().map((filename) => {
    const raw = fs.readFileSync(path.join(MEMORY_DIR, filename), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      filename,
      name: meta.name ?? path.basename(filename, ".md"),
      description: meta.description ?? "",
      type: meta.type ?? "user",
      body,
    };
  });
}

// Collect the text of one message (string content or text parts).
function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

// Select relevant memory filenames by matching recent conversation against
// memory names/descriptions. Uses a simple LLM call (or falls back to
// keyword matching on name+description).
async function selectRelevantMemories(messages: ModelMessage[], maxItems = 5): Promise<string[]> {
  const files = listMemoryFiles();
  if (!files.length) return [];

  // Collect recent user text for context
  const recentTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentTexts.length < 3; i--) {
    if (messages[i].role === "user") recentTexts.push(messageText(messages[i]));
  }
  const recent = recentTexts.reverse().join(" ").slice(0, 2000);
  if (!recent.trim()) return [];

  // Build catalog of name + description for the LLM to choose from
  const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join("\n");

  const prompt =
    "Given the recent conversation and the memory catalog below, " +
    "select the indices of memories that are clearly relevant. " +
    "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
    "If none are relevant, return [].\n\n" +
    `Recent conversation:\n${recent}\n\n` +
    `Memory catalog:\n${catalog}`;

  try {
    const { text } = await generateText({ model, prompt, maxOutputTokens: 200 });
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const indices: unknown = JSON.parse(match[0]);
      const selected: string[] = [];
      for (const idx of Array.isArray(indices) ? indices : []) {
        if (Number.isInteger(idx) && idx >= 0 && idx < files.length) {
          selected.push(files[idx as number].filename);
          if (selected.length >= maxItems) break;
        }
      }
      return selected;
    }
  } catch {
    // fall through to keyword matching
  }

  // Fallback: keyword matching on name + description
  const keywords = recent
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.toLowerCase());
  const selected: string[] = [];
  for (const f of files) {
    const text = `${f.name} ${f.description}`.toLowerCase();
    if (keywords.some((kw) => text.includes(kw))) {
      selected.push(f.filename);
      if (selected.length >= maxItems) break;
    }
  }
  return selected;
}

// Load relevant memory content for injection into context.
async function loadMemories(messages: ModelMessage[]): Promise<string> {
  const selectedFiles = await selectRelevantMemories(messages);
  if (!selectedFiles.length) return "";

  const parts = ["<relevant_memories>"];
  for (const filename of selectedFiles) {
    const content = readMemoryFile(filename);
    if (content) parts.push(content);
  }
  parts.push("</relevant_memories>");
  return parts.join("\n\n");
}

type ExtractedMemory = { name?: string; type?: string; description?: string; body?: string };

// Extract new memories from recent dialogue. Runs after each turn.
async function extractMemories(messages: ModelMessage[]): Promise<void> {
  const dialogueParts: string[] = [];
  for (const m of messages.slice(-10)) {
    const content = messageText(m);
    if (content.trim()) dialogueParts.push(`${m.role}: ${content}`);
  }
  const dialogue = dialogueParts.join("\n");
  if (!dialogue.trim()) return;

  // Check existing memories to avoid duplicates
  const existing = listMemoryFiles();
  const existingDesc = existing.length
    ? existing.map((m) => `- ${m.name}: ${m.description}`).join("\n")
    : "(none)";

  const prompt =
    "Extract user preferences, constraints, or project facts from this dialogue.\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n" +
    "- name: short kebab-case identifier (e.g. 'user-preference-tabs')\n" +
    "- type: one of 'user' (user preference), 'feedback' (guidance), " +
    "'project' (project fact), 'reference' (external pointer)\n" +
    "- description: one-line summary for index lookup\n" +
    "- body: full detail in markdown\n" +
    "If nothing new or already covered by existing memories, return [].\n\n" +
    `Existing memories:\n${existingDesc}\n\n` +
    `Dialogue:\n${dialogue.slice(0, 4000)}`;

  try {
    const { text } = await generateText({ model, prompt, maxOutputTokens: 800 });
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: ExtractedMemory[] = JSON.parse(match[0]);
    if (!items.length) return;
    let count = 0;
    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      const memType: string = mem.type ?? ("user" satisfies MemoryType);
      if (mem.description && mem.body) {
        writeMemoryFile(name, memType, mem.description, mem.body);
        count += 1;
      }
    }
    if (count) console.log(`\n\x1b[33m[Memory: extracted ${count} new memories]\x1b[0m`);
  } catch {
    // extraction is best-effort; never break the main loop
  }
}

const CONSOLIDATE_THRESHOLD = 10;

// Merge duplicate/stale memories. Triggered when file count ≥ threshold.
async function consolidateMemories(): Promise<void> {
  const files = listMemoryFiles();
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files
    .map((f) => `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`)
    .join("\n\n");

  const prompt =
    "Consolidate the following memory files. Rules:\n" +
    "1. Merge duplicates into one\n" +
    "2. Remove outdated/contradicted memories\n" +
    "3. Keep the total under 30 memories\n" +
    "4. Preserve important user preferences above all\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n\n" +
    catalog.slice(0, 16_000);

  try {
    const { text } = await generateText({ model, prompt, maxOutputTokens: 3000 });
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: ExtractedMemory[] = JSON.parse(match[0]);

    // Remove old memory files (keep MEMORY.md)
    for (const filename of memoryFilenames()) {
      fs.unlinkSync(path.join(MEMORY_DIR, filename));
    }

    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      if (mem.description && mem.body) {
        writeMemoryFile(name, mem.type ?? "user", mem.description, mem.body);
      }
    }
    console.log(`\n\x1b[33m[Memory: consolidated ${files.length} → ${items.length} memories]\x1b[0m`);
  } catch {
    // consolidation is best-effort; never break the main loop
  }
}

// Build SYSTEM with memory index
function buildSystem(): string {
  const index = readMemoryIndex();
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  return (
    `You are a coding agent at ${WORKDIR}.` +
    `${memoriesSection}\n` +
    "Relevant memories are injected below. Respect user preferences from memory.\n" +
    "When the user says 'remember' or expresses a clear preference, extract it as a memory."
  );
}

const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// ═══════════════════════════════════════════════════════════
//  FROM s02-s08 (skeleton): Basic tools
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

function runRead(p: string): string {
  try {
    return fs.readFileSync(safePath(p), "utf8");
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
//  Tool Definitions (skeleton — fewer tools to focus on memory)
// ═══════════════════════════════════════════════════════════

// Shared by parent and subagent (Python re-declares SUB_TOOLS by hand)
const subTools = {
  bash: tool({
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
  }),
  read_file: tool({
    description: "Read file contents.",
    inputSchema: z.object({ path: z.string() }),
  }),
  write_file: tool({
    description: "Write content to a file.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
  }),
};

const tools = {
  ...subTools,
  edit_file: tool({
    description: "Replace exact text in a file once.",
    inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
  }),
  glob: tool({
    description: "Find files matching a glob pattern.",
    inputSchema: z.object({ pattern: z.string() }),
  }),
  task: tool({
    description: "Launch a subagent to handle a subtask.",
    inputSchema: z.object({ description: z.string() }),
  }),
};

const SUB_HANDLERS: Record<string, (input: any) => string> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path }) => runRead(path),
  write_file: ({ path, content }) => runWrite(path, content),
};

const TOOL_HANDLERS: Record<string, (input: any) => string | Promise<string>> = {
  ...SUB_HANDLERS,
  edit_file: ({ path, old_text, new_text }) => runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
  task: ({ description }) => spawnSubagent(description),
};

// ═══════════════════════════════════════════════════════════
//  FROM s06-s08 (simplified): Subagent — no hooks in s09
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
      const handler = SUB_HANDLERS[call.toolName];
      const output = handler ? handler(call.input) : `Unknown: ${call.toolName}`;
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
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  FROM s08 (skeleton): Compaction pipeline
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

function snipCompact(messages: ModelMessage[], maxMessages = 50): ModelMessage[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = 3;
  let tailStart = messages.length - (maxMessages - 3);
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
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${tailStart - headEnd} msgs]` },
    ...messages.slice(tailStart),
  ];
}

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
      part.output = { type: "text", value: "[Earlier tool result compacted.]" };
    }
  }
  return messages;
}

function persistLargeOutput(toolCallId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolCallId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
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
    "Preserve: 1. current goal, 2. key findings, 3. files changed, 4. remaining work, 5. user constraints.\n\n" +
    conversation;
  const { text } = await generateText({ model, prompt, maxOutputTokens: 2000 });
  return text.trim();
}

async function compactHistory(messages: ModelMessage[]): Promise<ModelMessage[]> {
  writeTranscript(messages);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

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
//  agentLoop — s09: inject memories + extract after each turn
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1;

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  let reactiveRetries = 0;
  // s09: inject relevant memory content into the current user turn
  const memoriesContent = await loadMemories(messages);
  const last = messages[messages.length - 1];
  const memoryTurn = last && typeof last.content === "string" ? messages.length - 1 : null;
  // s09: build system once per user turn; memory is updated after the loop returns
  const system = buildSystem();

  while (true) {
    // s09: save pre-compaction snapshot for accurate memory extraction
    const preCompact = structuredClone(messages);

    // s08: compaction pipeline (budget → snip → micro)
    setMessages(messages, toolResultBudget(messages));
    setMessages(messages, snipCompact(messages));
    setMessages(messages, microCompact(messages));

    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      setMessages(messages, await compactHistory(messages));
    }

    let result;
    try {
      // memories go into a request-time copy — history itself stays clean
      let requestMessages = messages;
      const turn = memoryTurn !== null && memoryTurn < messages.length ? messages[memoryTurn] : null;
      if (memoriesContent && turn && typeof turn.content === "string") {
        requestMessages = messages.slice();
        requestMessages[memoryTurn as number] = {
          role: "user",
          content: `${memoriesContent}\n\n${turn.content}`,
        };
      }
      result = await generateText({
        model,
        system,
        messages: requestMessages,
        tools,
        maxOutputTokens: 8000,
      });
      reactiveRetries = 0;
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
    if (result.finishReason !== "tool-calls") {
      // s09: extract from pre-compaction snapshot for full fidelity
      await extractMemories(preCompact);
      await consolidateMemories();
      return result.text;
    }

    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      if (call.dynamic) continue;
      console.log(`\x1b[36m> ${call.toolName}\x1b[0m`);
      const handler = TOOL_HANDLERS[call.toolName];
      const output = handler ? await handler(call.input) : `Unknown: ${call.toolName}`;
      console.log(output.slice(0, 200));
      results.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: output },
      });
    }
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

console.log("s09: Memory — persistent cross-session knowledge");
console.log("输入问题，回车发送。输入 q 退出。\n");

const history: ModelMessage[] = [];
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms09 >> \x1b[0m");
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

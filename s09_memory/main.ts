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
 * 记忆目录作为参数传入（analogous to s07 的 scanSkills(dir)）：入口用 .memory/，
 * 测试用临时目录，各函数不依赖模块级全局。
 *
 * 基于 s08（context compact）构建。Usage:
 *
 *     pnpm dev s09_memory/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// client 与 logger 通过参数注入到 agentLoop / spawnSubagent。
export type Deps = { client: ModelClient; logger: SessionLogger };
// agentLoop 还需要知道记忆目录。
export type LoopDeps = Deps & { memoryDir: string };

const memoryIndexPath = (dir: string): string => path.join(dir, "MEMORY.md");

// ═══════════════════════════════════════════════════════════
//  s09 新增：记忆系统
// ═══════════════════════════════════════════════════════════

// Python 用一个 MEMORY_TYPES 列表；TS 里用联合类型表达同一个约束。
type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryFile = {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
};

// 注意：JS 的 split("---", 2) 会截掉剩余部分，Python 不会 —— 这里改用 indexOf 按下标切。
export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
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

// 写入一个带 YAML frontmatter 的记忆文件，并重建索引。
export function writeMemoryFile(
  dir: string,
  name: string,
  memType: string,
  description: string,
  body: string,
): string {
  const slug = name.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-");
  const filepath = path.join(dir, `${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filepath,
    `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`,
  );
  rebuildIndex(dir);
  return filepath;
}

// 列出目录下所有记忆文件名（排除索引 MEMORY.md），按名排序。
export function memoryFilenames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort();
}

// 由所有记忆文件重建 MEMORY.md 索引。
export function rebuildIndex(dir: string): void {
  const lines: string[] = [];
  for (const filename of memoryFilenames(dir)) {
    const raw = fs.readFileSync(path.join(dir, filename), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name ?? path.basename(filename, ".md");
    const desc = meta.description ?? (body.split("\n")[0] ?? "").slice(0, 80);
    lines.push(`- [${name}](${filename}) — ${desc}`);
  }
  fs.writeFileSync(
    memoryIndexPath(dir),
    lines.length ? `${lines.join("\n")}\n` : "",
  );
}

// 读取 MEMORY.md 索引（每轮注入 SYSTEM）。
export function readMemoryIndex(dir: string): string {
  const indexPath = memoryIndexPath(dir);
  if (!fs.existsSync(indexPath)) return "";
  return fs.readFileSync(indexPath, "utf8").trim();
}

// 读取单个记忆文件的完整内容，不存在返回 null。
export function readMemoryFile(dir: string, filename: string): string | null {
  const filepath = path.join(dir, filename);
  if (!fs.existsSync(filepath)) return null;
  return fs.readFileSync(filepath, "utf8");
}

// 列出所有记忆文件及其元数据。
export function listMemoryFiles(dir: string): MemoryFile[] {
  return memoryFilenames(dir).map((filename) => {
    const raw = fs.readFileSync(path.join(dir, filename), "utf8");
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

// 取一条消息的文本（字符串内容或 text 块）。
export function messageText(m: Anthropic.MessageParam): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

// 用最近对话去匹配记忆的 name/description，挑出相关记忆文件名。
// 先让 LLM 选（返回下标数组），失败则回退到 name+description 上的关键词匹配。
export async function selectRelevantMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
  maxItems = 5,
): Promise<string[]> {
  const { client, logger } = deps;
  const files = listMemoryFiles(dir);
  if (!files.length) return [];

  // 收集最近的用户输入作为上下文。
  const recentTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentTexts.length < 3; i--) {
    if (messages[i].role === "user") recentTexts.push(messageText(messages[i]));
  }
  const recent = recentTexts.reverse().join(" ").slice(0, 2000);
  if (!recent.trim()) return [];

  // 给 LLM 一份「下标 + name + description」的目录供其挑选。
  const catalog = files
    .map((f, i) => `${i}: ${f.name} — ${f.description}`)
    .join("\n");

  const prompt =
    "Given the recent conversation and the memory catalog below, " +
    "select the indices of memories that are clearly relevant. " +
    "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
    "If none are relevant, return [].\n\n" +
    `Recent conversation:\n${recent}\n\n` +
    `Memory catalog:\n${catalog}`;

  try {
    const request: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    logger.request(request);
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 200,
      messages: request,
    });
    logger.response(response);
    const text = textOf(response);
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
    // 落到下面的关键词匹配兜底。
  }

  // 兜底：拿较长的词去 name + description 里做关键词匹配。
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

// 加载相关记忆的内容，包成一段注入上下文的文本。
export async function loadMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const selectedFiles = await selectRelevantMemories(dir, messages, deps);
  if (!selectedFiles.length) return "";

  const parts = ["<relevant_memories>"];
  for (const filename of selectedFiles) {
    const content = readMemoryFile(dir, filename);
    if (content) parts.push(content);
  }
  parts.push("</relevant_memories>");
  return parts.join("\n\n");
}

type ExtractedMemory = {
  name?: string;
  type?: string;
  description?: string;
  body?: string;
};

// 从最近对话里提取新记忆，每轮结束后运行。
export async function extractMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<void> {
  const { client, logger } = deps;
  const dialogueParts: string[] = [];
  for (const m of messages.slice(-10)) {
    const content = messageText(m);
    if (content.trim()) dialogueParts.push(`${m.role}: ${content}`);
  }
  const dialogue = dialogueParts.join("\n");
  if (!dialogue.trim()) return;

  // 把已有记忆一并给 LLM，避免重复提取。
  const existing = listMemoryFiles(dir);
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
    const request: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    logger.request(request);
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 800,
      messages: request,
    });
    logger.response(response);
    const text = textOf(response);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: ExtractedMemory[] = JSON.parse(match[0]);
    if (!items.length) return;
    let count = 0;
    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      const memType: string = mem.type ?? ("user" satisfies MemoryType);
      if (mem.description && mem.body) {
        writeMemoryFile(dir, name, memType, mem.description, mem.body);
        count += 1;
      }
    }
    if (count)
      logger.console(`[Memory] extracted ${count} new memories`, "yellow");
  } catch {
    // 提取是尽力而为，出错也不能中断主循环。
  }
}

const CONSOLIDATE_THRESHOLD = 10;

// 合并重复/过期记忆，文件数 ≥ 阈值时触发。
export async function consolidateMemories(
  dir: string,
  deps: Deps,
): Promise<void> {
  const { client, logger } = deps;
  const files = listMemoryFiles(dir);
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files
    .map(
      (f) =>
        `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`,
    )
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
    const request: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    logger.request(request);
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 3000,
      messages: request,
    });
    logger.response(response);
    const text = textOf(response);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: ExtractedMemory[] = JSON.parse(match[0]);

    // 删掉旧记忆文件（保留 MEMORY.md），再按整合结果重写。
    for (const filename of memoryFilenames(dir)) {
      fs.unlinkSync(path.join(dir, filename));
    }

    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      if (mem.description && mem.body) {
        writeMemoryFile(
          dir,
          name,
          mem.type ?? "user",
          mem.description,
          mem.body,
        );
      }
    }
    logger.console(
      `[Memory] consolidated ${files.length} → ${items.length} memories`,
      "yellow",
    );
  } catch {
    // 整合是尽力而为，出错也不能中断主循环。
  }
}

// 用记忆索引拼出 SYSTEM prompt。
export function buildSystem(dir: string): string {
  const index = readMemoryIndex(dir);
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  return (
    `You are a coding agent at ${WORKDIR}.` +
    `${memoriesSection}\n` +
    "Relevant memories are injected below. Respect user preferences from memory.\n" +
    "When the user says 'remember' or expresses a clear preference, extract it as a memory."
  );
}

// 子 agent 的 system prompt —— 没有 task，不能递归派生。
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// ═══════════════════════════════════════════════════════════
//  来自 s02-s08（精简骨架）：基础工具
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

// 把路径限制在 WORKDIR 内，越界即抛错。
export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (resolved !== WORKDIR && !resolved.startsWith(WORKDIR + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

export function runRead(p: string): string {
  try {
    return fs.readFileSync(safePath(p), "utf8");
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
    // 用 indexOf + slice 而非 String.replace：replace 会把 newText 里的
    // `$&` 之类当成特殊替换语法。
    const i = text.indexOf(oldText);
    if (i === -1) return `Error: text not found in ${p}`;
    fs.writeFileSync(
      filePath,
      text.slice(0, i) + newText + text.slice(i + oldText.length),
    );
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

// ═══════════════════════════════════════════════════════════
//  工具定义（精简骨架 —— 少几个工具，聚焦记忆本身）
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({
  path: z.string(),
  old_text: z.string(),
  new_text: z.string(),
});
const globSchema = z.object({ pattern: z.string() });
const taskSchema = z.object({ description: z.string() });

// parent 与 subagent 共用这三样基础工具（对应 Python 里手写的 SUB_TOOLS）。
const subTools: Anthropic.Tool[] = [
  zodTool("bash", "Run a shell command.", bashSchema),
  zodTool("read_file", "Read file contents.", readSchema),
  zodTool("write_file", "Write content to a file.", writeSchema),
];

const SUB_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  bash: bashSchema,
  read_file: readSchema,
  write_file: writeSchema,
};

// parent 在 subagent 三张基础表之上追加 edit/glob/task。
const tools: Anthropic.Tool[] = [
  ...subTools,
  zodTool("edit_file", "Replace exact text in a file once.", editSchema),
  zodTool("glob", "Find files matching a glob pattern.", globSchema),
  zodTool("task", "Launch a subagent to handle a subtask.", taskSchema),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...SUB_SCHEMAS,
  edit_file: editSchema,
  glob: globSchema,
  task: taskSchema,
};

const SUB_HANDLERS: Partial<Record<string, (input: any) => string>> = {
  bash: ({ command }) => runBash(command),
  read_file: ({ path }) => runRead(path),
  write_file: ({ path, content }) => runWrite(path, content),
};

// handler 可能是 async：task -> spawnSubagent 返回 Promise。
const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: Deps) => string | Promise<string>>
> = {
  ...SUB_HANDLERS,
  edit_file: ({ path, old_text, new_text }) =>
    runEdit(path, old_text, new_text),
  glob: ({ pattern }) => runGlob(pattern),
  task: ({ description }, deps) => spawnSubagent(description, deps),
};

// ═══════════════════════════════════════════════════════════
//  来自 s06-s08（精简版）：Subagent —— s09 没有 hooks
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
      const schema = SUB_SCHEMAS[block.name];
      const handler = SUB_HANDLERS[block.name];
      const output =
        handler && schema
          ? handler(schema.parse(block.input))
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
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
  return lastText || "Subagent stopped after 30 turns without final answer.";
}

// ═══════════════════════════════════════════════════════════
//  来自 s08（精简骨架）：压缩流水线
// ═══════════════════════════════════════════════════════════

const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30_000;

// 用 JSON 字符数估算上下文大小 —— 不是 token 数，但零成本，够做阈值判断。
export const estimateSize = (msgs: Anthropic.MessageParam[]): number =>
  JSON.stringify(msgs).length;

// 原地替换数组内容 —— 调用方持有同一个引用（对应 Python 的 `messages[:] = ...`）。
export function setMessages(
  messages: Anthropic.MessageParam[],
  next: Anthropic.MessageParam[],
): void {
  messages.splice(0, messages.length, ...next);
}

// 工具调用是携带 tool_use 内容块的 assistant 消息。
const messageHasToolCall = (m: Anthropic.MessageParam): boolean =>
  m.role === "assistant" &&
  Array.isArray(m.content) &&
  m.content.some((b) => b.type === "tool_use");

// tool_result 是携带 tool_result 内容块的 user 消息。
const isToolResultMessage = (m: Anthropic.MessageParam): boolean =>
  m.role === "user" &&
  Array.isArray(m.content) &&
  m.content.some((b) => typeof b !== "string" && b.type === "tool_result");

// 取 tool_result 的文本 —— content 可能是字符串或内容块数组，统一成字符串来量长度。
const outputText = (part: Anthropic.ToolResultBlockParam): string =>
  typeof part.content === "string"
    ? part.content
    : JSON.stringify(part.content);

// L1: snipCompact —— 裁剪中间消息，保留头 3 条、尾 (maxMessages - 3) 条。
export function snipCompact(
  messages: Anthropic.MessageParam[],
  maxMessages = 50,
): Anthropic.MessageParam[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = 3;
  let tailStart = messages.length - (maxMessages - 3);
  // 头尾边界都不能把「工具调用 / 工具结果」这一对拆开。
  if (headEnd > 0 && messageHasToolCall(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd]))
      headEnd += 1;
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

// 按出现顺序收集所有 tool_result 块 —— 返回原对象引用，调用方可原地修改。
export function collectToolResults(
  messages: Anthropic.MessageParam[],
): Anthropic.ToolResultBlockParam[] {
  const parts: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (typeof part !== "string" && part.type === "tool_result")
        parts.push(part);
    }
  }
  return parts;
}

// L2: microCompact —— 把较早的长工具结果换成占位符，保留最近 KEEP_RECENT 条。
export function microCompact(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;
  for (const part of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content === "string" && part.content.length > 120) {
      part.content = "[Earlier tool result compacted.]";
    }
  }
  return messages;
}

// 超长输出写到磁盘，返回「路径 + 预览」的占位文本；短输出原样返回。
export function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, output);
  return `<persisted-output>\nFull: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

// L3: toolResultBudget —— 最新一轮结果超预算时，从最大的开始落盘。
export function toolResultBudget(
  messages: Anthropic.MessageParam[],
  maxBytes = 200_000,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  // 只看最后一条消息 —— 预算只管最新一轮的工具结果，更早的交给 L2。
  if (last?.role !== "user" || !Array.isArray(last.content)) return messages;
  const blocks = last.content.filter(
    (b): b is Anthropic.ToolResultBlockParam =>
      typeof b !== "string" && b.type === "tool_result",
  );
  let total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort(
    (a, b) => outputText(b).length - outputText(a).length,
  );
  for (const block of ranked) {
    if (total <= maxBytes) break;
    const content = outputText(block);
    if (content.length <= PERSIST_THRESHOLD) continue;
    block.content = persistLargeOutput(block.tool_use_id, content);
    total = blocks.reduce((n, b) => n + outputText(b).length, 0);
  }
  return messages;
}

// 压缩前把完整历史落成 JSONL 存档 —— 信息只是移出上下文，并未真正丢失。
function writeTranscript(messages: Anthropic.MessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = path.join(
    TRANSCRIPT_DIR,
    `transcript_${Math.floor(Date.now() / 1000)}.jsonl`,
  );
  fs.writeFileSync(
    filePath,
    `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );
  return filePath;
}

// 用一次独立的 API 调用把整段历史浓缩成结构化摘要。
export async function summarizeHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client } = deps;
  // 摘要是独立子请求：用 child scope 打标记，日志里与主循环区分开。
  const logger = deps.logger.child("compact");
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings, 3. files changed, 4. remaining work, 5. user constraints.\n\n" +
    conversation;
  const request: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  logger.request(request, true);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 2000,
    messages: request,
  });
  logger.response(response);
  return textOf(response).trim();
}

// L4: autoCompact —— 落盘存档 + LLM 完整摘要，用摘要替换整段历史。
export async function compactHistory(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<Anthropic.MessageParam[]> {
  writeTranscript(messages);
  const summary = await summarizeHistory(messages, deps);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// 应急：reactiveCompact —— API 仍报 prompt_too_long 时触发，摘要头部、保留尾部。
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
    // 尾部开头是 tool_result 时，把配对的 tool_use 一起留下，避免孤立引用。
    tailStart -= 1;
  }
  const summary = await summarizeHistory(messages.slice(0, tailStart), deps);
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— s09：注入相关记忆 + 每轮结束后提取新记忆
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1;

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, memoryDir } = deps;
  let reactiveRetries = 0;
  // s09：把相关记忆内容注入到当前这轮 user 消息。
  const memoriesContent = await loadMemories(memoryDir, messages, deps);
  const last = messages[messages.length - 1];
  const memoryTurn =
    last && typeof last.content === "string" ? messages.length - 1 : null;
  // s09：每轮用户输入只构建一次 SYSTEM；记忆在本次循环返回后再更新。
  const system = buildSystem(memoryDir);

  while (true) {
    // s09：留一份压缩前快照，供后面精确提取记忆。
    const preCompact = structuredClone(messages);

    // s08：压缩流水线（budget → snip → micro）。
    setMessages(messages, toolResultBudget(messages));
    setMessages(messages, snipCompact(messages));
    setMessages(messages, microCompact(messages));

    if (estimateSize(messages) > CONTEXT_LIMIT) {
      logger.console("[auto compact]", "yellow");
      setMessages(messages, await compactHistory(messages, deps));
    }

    let response: Anthropic.Message;
    try {
      // 记忆只进请求时的临时副本 —— 历史本身保持干净。
      let requestMessages = messages;
      const turn =
        memoryTurn !== null && memoryTurn < messages.length
          ? messages[memoryTurn]
          : null;
      if (memoriesContent && turn && typeof turn.content === "string") {
        requestMessages = messages.slice();
        requestMessages[memoryTurn as number] = {
          role: "user",
          content: `${memoriesContent}\n\n${turn.content}`,
        };
      }
      logger.request(requestMessages);
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages: requestMessages,
        tools,
        max_tokens: 8000,
      });
      logger.response(response);
      reactiveRetries = 0;
    } catch (e) {
      const msg = errMsg(e).toLowerCase();
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        logger.console("[reactive compact]", "yellow");
        setMessages(messages, await reactiveCompact(messages, deps));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      // s09：用压缩前的快照提取，保证信息完整。
      await extractMemories(memoryDir, preCompact, deps);
      await consolidateMemories(memoryDir, deps);
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        printProse(block);
        continue;
      }
      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), deps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);
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
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  logger.config({ model: MODEL_ID, system: buildSystem(MEMORY_DIR), tools });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print("s09: Memory — 持久化的跨会话知识", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s09 >> ", "cyan"));
    } catch {
      break; // stdin 关闭（Ctrl+D）
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;

    logger.userInput(query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, {
      client,
      logger,
      memoryDir: MEMORY_DIR,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

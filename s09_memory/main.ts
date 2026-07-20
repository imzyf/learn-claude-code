/**
 * s09_memory/main.ts - 记忆系统
 *
 * 为编程 agent 提供持久化、跨会话的知识。
 *
 * 存储结构：
 *     .memory/
 *       MEMORY.md          ← 索引（每条记忆一行，写入时自动重建）
 *       feedback-tabs.md   ← 各个记忆文件（Markdown + YAML frontmatter）
 *       user-profile.md
 *       project-facts.md
 *
 * agentLoop 中的流程：
 *     1. 把 MEMORY.md 索引拼进 SYSTEM prompt（便宜，始终存在）
 *     2. 按 name/description 挑出相关记忆 → 注入当前 user turn（只进请求副本，历史保持干净）
 *     3. 运行 s08 的压缩流水线
 *     4. 本轮结束后 → 从压缩前快照提取新记忆
 *     5. 文件数达到阈值时整合（Dream：合并重复、剔除过期，控制在 30 条内）
 *
 * 相比 s08 的变化：
 *   工具层：tools（base + todo + task + load_skill + compact，共 9 个）直接复用 s08，
 *          schema/handler 表原样沿用 s07 —— s09 不新增工具，记忆读写全部由循环自动完成。
 *   Hook 层 / nag：复用 s05（与 s07/s08 一致）；技能层复用 s07；压缩流水线复用 s08。
 *   + 记忆层 —— writeMemoryFile / selectRelevantMemories / loadMemories /
 *     extractMemories / consolidateMemories
 *   + buildSystem() —— 在 s07 的技能版 SYSTEM 之上追加记忆索引；索引每轮会变，
 *     所以 system 不进 deps，由 agentLoop 每轮用户输入自行重建（s07/s08 是静态的）
 *
 * 记忆目录作为参数传入（analogous to s07 的 scanSkills(dir)）：入口用 .memory/，
 * 测试用临时目录，各函数不依赖模块级全局。
 *
 * 基于 s08（context compact）构建。Usage:
 *
 *     pnpm dev s09_memory/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { stringify as stringifyYaml } from "yaml";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf } from "../lib/tools";
// 来自 s05：hook 装配（loadHooks = createHooks + registerDefaultHooks）+ nag 机制。
import {
  bumpNagCounter,
  loadHooks,
  nagIfStale,
  resetNagCounter,
} from "../s05_todo_write/main";
// 来自 s06：共享的 Deps 类型（client + logger + hooks）。
import type { Deps } from "../s06_subagent/main";
// 来自 s07：技能层（SYSTEM 清单 + registry）+ frontmatter 解析 + LoopDeps +
// 装配好的 schema/handler 表（base + todo + task + load_skill）——与 s08 的用法一致。
import {
  buildSystem as buildSkillSystem,
  loadSkills,
  parseFrontmatter,
  type LoopDeps as S07LoopDeps,
  SKILLS_DIR,
  type SkillRegistry,
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
} from "../s07_skill_loading/main";
// 来自 s08：完整工具列表（base + todo + task + load_skill + compact）+
// 四层压缩流水线 + reactive 应急压缩 + 原地替换工具 + 各层阈值（env 可配）。
import {
  CONTEXT_LIMIT,
  compactHistory,
  estimateSize,
  MAX_REACTIVE_RETRIES,
  microCompact,
  reactiveCompact,
  replaceMessages,
  SNIP_MAX_MESSAGES,
  snipCompact,
  TOOL_RESULT_BUDGET,
  toolResultBudget,
  tools,
} from "../s08_context_compact/main";

// s09 导出自己拥有的东西：记忆层（存储/加载/提取/整理）+ agentLoop + LoopDeps。
// 复用来的符号（工具表 / hook / 压缩）由测试各自从源头 import。

// 记忆落在项目根的 .memory/（同 s07 的 SKILLS_DIR，以 process.cwd() 为项目根）。
export const MEMORY_DIR = path.join(process.cwd(), ".memory");

const memoryIndexPath = (dir: string): string => path.join(dir, "MEMORY.md");
// 默认记忆索引：s10 / s11 直接复用这个路径，不再各自拼接。
export const MEMORY_INDEX = memoryIndexPath(MEMORY_DIR);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// agentLoop 的完整依赖：Deps（client + logger + hooks）+ 技能表 + 记忆目录。
// system 不进 deps —— 记忆索引每轮都会变，由 agentLoop 自行重建（s07/s08 的 system 是静态的）。
export type LoopDeps = Deps & { skills: SkillRegistry; memoryDir: string };

// ═══════════════════════════════════════════════════════════
//  s09 新增：记忆系统
// ═══════════════════════════════════════════════════════════

// Python 用一个 MEMORY_TYPES 列表；TS 里用联合类型表达同一个约束。
export type MemoryType = "user" | "feedback" | "project" | "reference";
// 记忆文件的元数据 + 内容。
export type MemoryFile = {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
};

// STEP 1：在 s07 的技能版 SYSTEM 之上追加记忆索引 + 使用说明。
export function buildSystem(
  skills: SkillRegistry,
  dir: string,
  logger: SessionLogger,
): string {
  const index = readMemoryIndex(dir);
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  const systemPrompt =
    buildSkillSystem(skills) +
    `${memoriesSection}\n` +
    "Relevant memories are injected below. Respect user preferences from memory.\n" +
    "When the user says 'remember' or expresses a clear preference, extract it as a memory.";

  logger.section("SYSTEM PROMPT", systemPrompt);

  return systemPrompt;
}

// STEP 2：加载相关记忆的内容，包成一段注入上下文的文本。
export async function loadMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  // 先挑出相关记忆文件，无命中直接返回空串。
  const selectedFiles = await selectRelevantMemories(dir, messages, deps);
  if (!selectedFiles.length) return "";

  // 构建注入文本 <relevant_memories> ... </relevant_memories>。
  const parts = ["<relevant_memories>"];
  for (const filename of selectedFiles) {
    const content = readMemoryFile(dir, filename);
    if (content) parts.push(content);
  }
  parts.push("</relevant_memories>");

  deps.logger.section("MEMORY LOAD", parts.join("\n\n"));

  return parts.join("\n\n");
}
// 用最近对话去匹配记忆的 name/description，挑出相关记忆文件名。
// 先让 LLM 选（返回下标数组），失败则回退到 name+description 上的关键词匹配。
export async function selectRelevantMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
  maxItems = 5,
): Promise<string[]> {
  const { client, logger: sessionLogger } = deps;
  const logger = sessionLogger.child("select_relevant_memories");
  const files = listMemoryFiles(dir);
  if (!files.length) return [];

  // 收集最近的用户输入作为上下文。
  const recentTexts: string[] = [];
  // 最近三条用户消息（倒序）拼成一段，截断到 2000 字符。
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
    logger.request(request, true);
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

      logger.console(
        `[Memory] select relevant by LLM: ${selected.join(", ")}`,
        "yellow",
      );

      return selected;
    }
  } catch (e) {
    // 落到下面的关键词匹配兜底。
    logger.console(
      `[Memory] LLM select failed, fallback to keyword match ${errMsg(e)}`,
      "red",
    );
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
  logger.console(
    `[Memory] select relevant by keyword: ${selected.join(", ")}`,
    "yellow",
  );
  return selected;
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
      type: toMemoryType(meta.type),
      body,
    };
  });
}
// 列出目录下所有记忆文件名（排除索引 MEMORY.md），按名排序。
export function memoryFilenames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .sort();
}
// 把来源不可信的字符串（frontmatter / LLM 输出）收窄成 MemoryType，非法值退回 "user"。
function toMemoryType(value: string | undefined): MemoryType {
  switch (value) {
    case "user":
    case "feedback":
    case "project":
    case "reference":
      return value;
    default:
      return "user";
  }
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
// 取一条消息的文本（字符串内容或 text 块）。
export function messageText(m: Anthropic.MessageParam): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join(" ");
}

// STEP 4：从最近对话里提取新记忆，每轮结束后运行。
type ExtractedMemory = {
  name?: string;
  type?: string;
  description?: string;
  body?: string;
};
export async function extractMemories(
  dir: string,
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<void> {
  const { client, logger: sessionLogger } = deps;
  const logger = sessionLogger.child("extract_memories");
  const dialogueParts: string[] = [];
  // 只取最近 10 条消息，避免 prompt 太长。
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
    logger.request(request, true);
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
    const names: string[] = [];
    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      const memType = toMemoryType(mem.type);
      if (mem.description && mem.body) {
        writeMemoryFile(dir, name, memType, mem.description, mem.body);
        names.push(name);
      }
    }

    logger.console(
      `[Memory] extracted ${names.length} new memories: ${names.join(", ")}`,
      "yellow",
    );
  } catch (e) {
    // 提取是尽力而为，出错也不能中断主循环。
    logger.console(`[Memory] extract failed: ${errMsg(e)}`, "red");
  }
}
// 写入一个带 YAML frontmatter 的记忆文件，并重建索引。
export function writeMemoryFile(
  dir: string,
  name: string,
  memType: MemoryType,
  description: string,
  body: string,
): string {
  const slug = name.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-");
  const filepath = path.join(dir, `${slug}.md`);
  fs.mkdirSync(dir, { recursive: true });
  // frontmatter 交给 yaml.stringify，name/description 里的冒号、引号等特殊字符自动转义。
  const frontmatter = stringifyYaml({
    name,
    description,
    type: memType,
  }).trim();
  fs.writeFileSync(filepath, `---\n${frontmatter}\n---\n\n${body}\n`);
  rebuildIndex(dir);
  return filepath;
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

// STEP 5：合并重复/过期记忆，文件数 ≥ 阈值时触发。
const CONSOLIDATE_THRESHOLD = 10;
export async function consolidateMemories(
  dir: string,
  deps: Deps,
): Promise<void> {
  const { client, logger: sessionLogger } = deps;
  const logger = sessionLogger.child("consolidate_memories");
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
    logger.request(request, true);
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

    const names: string[] = [];
    for (const mem of items) {
      const name = mem.name ?? `memory_${Math.floor(Date.now() / 1000)}`;
      if (mem.description && mem.body) {
        writeMemoryFile(
          dir,
          name,
          toMemoryType(mem.type),
          mem.description,
          mem.body,
        );
        names.push(name);
      }
    }
    logger.console(
      `[Memory] consolidated ${files.length} → ${items.length} memories: ${names.join(", ")}`,
      "yellow",
    );
  } catch (e) {
    // 整合是尽力而为，出错也不能中断主循环。
    logger.console(`[Memory] consolidate failed: ${errMsg(e)}`, "red");
  }
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s08 一样（压缩流水线 + compact 拦截 + reactive 重试，
//  hook/nag 复用 s05，schema/handler 表复用 s07），s09 在其上叠加记忆：
//  请求前注入相关记忆，本轮结束后提取新记忆 + 定期整理。
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: LoopDeps,
): Promise<string> {
  const { client, logger, hooks, skills, memoryDir } = deps;
  let reactiveRetries = 0;
  // s09（STEP 2）：本轮开始挑一次相关记忆，注入请求副本。
  const memoriesContent = await loadMemories(memoryDir, messages, deps);
  //
  const last = messages[messages.length - 1];
  // s09 记忆注入锚点：末尾消息若是纯字符串内容，记下它的下标（本轮用户输入）。
  const memoryTurn =
    last && typeof last.content === "string" ? messages.length - 1 : null;

  // s09（STEP 1）：本轮开始把 MEMORY.md 索引拼进 SYSTEM（技能清单 + 记忆索引）。
  const system = buildSystem(skills, memoryDir, logger);
  const dispatchDeps: S07LoopDeps = { ...deps, system };

  while (true) {
    nagIfStale(messages, logger);
    // s09：留一份压缩前快照，供本轮结束时精确提取记忆。
    const preCompact = structuredClone(messages);

    // s08：三个预处理器：budget → snip → micro
    replaceMessages(
      messages,
      toolResultBudget(messages, TOOL_RESULT_BUDGET, logger),
    );
    replaceMessages(messages, snipCompact(messages, SNIP_MAX_MESSAGES, logger));
    replaceMessages(messages, microCompact(messages, logger));
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      logger.console("[COMPACT L4] auto compact", "yellow");
      replaceMessages(messages, await compactHistory(messages, deps));
    }

    let response: Anthropic.Message;
    try {
      // s09：记忆只进请求时的临时副本 —— 历史本身保持干净。
      let requestMessages = messages;
      // 取回锚点消息 —— 压缩可能改动过 messages，下标越界就放弃注入。
      const turn =
        memoryTurn !== null && memoryTurn < messages.length
          ? messages[memoryTurn]
          : null;
      if (memoriesContent && turn && typeof turn.content === "string") {
        // 复制一份数组，只改副本里的这一条，历史保持干净。
        requestMessages = messages.slice();
        // 把相关记忆拼到本轮用户输入前面。
        requestMessages[memoryTurn as number] = {
          role: "user",
          content: `${memoriesContent}\n\n${turn.content}`,
        };
      }

      logger.request(requestMessages, true);
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages: requestMessages,
        tools,
        max_tokens: 8000,
      });
      logger.response(response);

      reactiveRetries = 0; // API 调用成功即复位
    } catch (e) {
      const msg = errMsg(e).toLowerCase();
      if (
        (msg.includes("prompt_too_long") || msg.includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        logger.console("[COMPACT reactive] triggered", "yellow");
        replaceMessages(messages, await reactiveCompact(messages, deps));
        reactiveRetries += 1;
        continue;
      }
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      // s09（step 4）：对话告一段落 —— 用压缩前快照提取新记忆，必要时整理。
      await extractMemories(memoryDir, preCompact, deps);
      // s09（step 5）：文件数达阈值时合并去重（未到阈值内部直接返回）。
      await consolidateMemories(memoryDir, deps);

      return textOf(response);
    }

    bumpNagCounter();
    // compact 工具会重写整个 messages[] —— 一旦触发，本轮剩余的 tool_result 全部作废。
    let didCompact = false;
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

      // s08：compact 工具用摘要重写整个历史，不能再追加对应的 tool_result
      if (block.name === "compact") {
        replaceMessages(messages, await compactHistory(messages, deps));
        didCompact = true;
        break; // 结束本轮，用压缩后的上下文重新开始
      }

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      // await —— task handler（spawnSubagent）是 async。
      const output =
        handler && schema
          ? await handler(schema.parse(block.input), dispatchDeps)
          : `Unknown: ${block.name}`;
      logger.toolResult(block.name, output);

      await hooks.trigger("PostToolUse", block, output);

      if (block.name === "todo_write") resetNagCounter();

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

// ── 入口 ──────────────────────────────────────────
// Prompt example: I prefer using tabs for indentation, not spaces. Remember that.
if (import.meta.main) {
  const client: ModelClient = createClient();
  const logger: SessionLogger = createLogger(import.meta.dirname);
  const skills = loadSkills(SKILLS_DIR, logger);
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  logger.config({
    model: MODEL_ID,
    tools,
  });

  const hooks = loadHooks(logger);

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
    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });

    const finalText = await agentLoop(history, {
      client,
      logger,
      hooks,
      skills,
      memoryDir: MEMORY_DIR,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

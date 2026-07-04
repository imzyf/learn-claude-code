/**
 * s07_skill_loading/main.ts - Skill 加载
 *
 * 两级按需知识注入：
 *
 *   第一层（便宜，始终存在）：
 *     SYSTEM prompt 里包含 skill 名称 + 一行描述（约 100 tokens/skill）
 *     "Skills available: agent-builder, code-review, mcp-builder, pdf"
 *
 *   第二层（昂贵，按需）：
 *     Agent 调用 load_skill("code-review") → 完整 SKILL.md 内容
 *     通过 tool_result 注入（约 2000 tokens/skill）
 *
 *   skills/
 *     agent-builder/SKILL.md
 *     code-review/SKILL.md
 *     mcp-builder/SKILL.md
 *     pdf/SKILL.md
 *
 * 相比 s06 的变化：
 *   + buildSystem() —— 启动时扫描 skills/ 目录，把清单注入 SYSTEM
 *   + loadSkill(name) —— 通过 tool_result 返回完整 SKILL.md 内容
 *   + SKILLS_DIR 配置
 *   循环没变：load_skill 通过 TOOL_HANDLERS 自动分发。
 *
 * 一处 TS 特有的差异：Python 用 PyYAML 解析 frontmatter；这里用一个
 * 简单的 `key: value` 逐行解析器来避免这个依赖（s08 的 Python 版本也是这样做的）。
 *
 * 基于 s06（subagent）构建。Usage:
 *
 *     pnpm dev s07_skill_loading/main.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { client, MODEL_ID } from "../lib/model";
import { zodTool, textOf } from "../lib/tools";

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ═══════════════════════════════════════════════════════════
//  NEW in s07: Skill catalog scan + SYSTEM with catalog
// ═══════════════════════════════════════════════════════════

type Skill = { name: string; description: string; content: string };

// Parse frontmatter from SKILL.md. Returns { meta, body }.
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
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    meta[key] = value;
  }
  return { meta, body: text.slice(end + 3).trim() };
}

// Build skill registry at startup (used for safe lookup in loadSkill)
const SKILL_REGISTRY: Record<string, Skill> = {};

// Scan skills/ dir, populate SKILL_REGISTRY with name/description/content.
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

// List all skills (name + one-line description).
function listSkills(): string {
  const skills = Object.values(SKILL_REGISTRY);
  if (!skills.length) return "(no skills found)";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

// s07: SYSTEM includes skill catalog (cheap — just names + descriptions)
function buildSystem(): string {
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${listSkills()}\n` +
    "Use load_skill to get full details when needed."
  );
}

const SYSTEM = buildSystem();

// s07: subagent gets its own system prompt — no skill loading, no task
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// Load full skill content. Lookup via registry — no path traversal.
function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

// ═══════════════════════════════════════════════════════════
//  FROM s02-s06 (unchanged): Tool Implementations
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
//  Tool Definitions — parent gets everything, subagent a subset
// ═══════════════════════════════════════════════════════════

const bashSchema = z.object({ command: z.string() });
const readSchema = z.object({ path: z.string(), limit: z.number().int().optional() });
const writeSchema = z.object({ path: z.string(), content: z.string() });
const editSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string() });
const globSchema = z.object({ pattern: z.string() });
const todoWriteSchema = z.object({ todos: z.union([z.array(todoItem), z.string()]) });
const taskSchema = z.object({ description: z.string() });
const loadSkillSchema = z.object({ name: z.string() });

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
  // s07: skill tool (catalog is already in SYSTEM prompt, this loads full content)
  zodTool("load_skill", "Load the full content of a skill by name.", loadSkillSchema),
];

const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...FILE_SCHEMAS,
  todo_write: todoWriteSchema,
  task: taskSchema,
  load_skill: loadSkillSchema,
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

// Handlers may be async: task -> spawnSubagent returns a Promise
const TOOL_HANDLERS: Partial<Record<string, (input: any) => string | Promise<string>>> = {
  ...SUB_HANDLERS,
  todo_write: ({ todos }) => runTodoWrite(todos),
  task: ({ description }) => spawnSubagent(description),
  load_skill: ({ name }) => loadSkill(name),
};

// ═══════════════════════════════════════════════════════════
//  FROM s06 (unchanged): Subagent — fresh messages[], summary only
// ═══════════════════════════════════════════════════════════

async function spawnSubagent(description: string): Promise<string> {
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: description }]; // fresh context
  let lastText = "";

  for (let turn = 0; turn < 30; turn++) {
    // safety limit
    const response = await client.messages.create({
      model: MODEL_ID,
      system: SUB_SYSTEM,
      messages,
      tools: subTools,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    const text = textOf(response);
    if (text) lastText = text;
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      // subagent also runs hooks (permissions apply)
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
//  FROM s04 (unchanged): Hook System
// ═══════════════════════════════════════════════════════════

// `...args: any[]` mirrors Python's `callback(*args)`.
type Hook = (...args: any[]) => string | null | Promise<string | null>;

const HOOKS: Record<string, Hook[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: Hook): void {
  HOOKS[event].push(callback);
}

async function triggerHooks(event: string, ...args: any[]): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) return result;
  }
  return null;
}

type ToolCallInfo = Anthropic.ToolUseBlock;

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];

// PreToolUse: deny list check.
function permissionHook(call: ToolCallInfo): string | null {
  if (call.name === "bash") {
    for (const pattern of DENY_LIST) {
      if (((call.input as any).command ?? "").includes(pattern)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${pattern}'\x1b[0m`);
        return "Permission denied";
      }
    }
  }
  return null;
}

// PreToolUse: log tool calls.
function logHook(call: ToolCallInfo): null {
  console.log(`\x1b[90m[HOOK] ${call.name}\x1b[0m`);
  return null;
}

// UserPromptSubmit: log working directory.
function contextInjectHook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop: print tool call count.
function summaryHook(messages: Anthropic.MessageParam[]): null {
  const toolCount = messages.reduce(
    (n, m) =>
      n +
      (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result").length : 0),
    0,
  );
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("Stop", summaryHook);

// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s05-s06 + nag reminder, tools auto-dispatch
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  while (true) {
    // s05: nag reminder
    if (roundsSinceTodo >= 3 && messages.length) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    const response = await client.messages.create({
      model: MODEL_ID,
      system: SYSTEM,
      messages,
      tools,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    roundsSinceTodo += 1;
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

      const schema = TOOL_SCHEMAS[block.name];
      const handler = TOOL_HANDLERS[block.name];
      const output =
        handler && schema ? await handler(schema.parse(block.input)) : `Unknown: ${block.name}`;

      await triggerHooks("PostToolUse", block, output);

      if (block.name === "todo_write") roundsSinceTodo = 0;

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
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

console.log("s07: Skill Loading — catalog in SYSTEM, content on demand");
console.log("Type a question, press Enter. Type q to quit.\n");

const history: Anthropic.MessageParam[] = [];
while (true) {
  let query: string;
  try {
    query = await rl.question("\x1b[36ms07 >> \x1b[0m");
  } catch {
    break; // stdin closed (Ctrl+D)
  }
  const q = query.trim().toLowerCase();
  if (q === "" || q === "q" || q === "exit") break;

  await triggerHooks("UserPromptSubmit", query);
  history.push({ role: "user", content: query });
  const finalText = await agentLoop(history);
  console.log(finalText);
  console.log();
}
rl.close();

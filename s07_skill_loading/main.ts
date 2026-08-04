/**
 * s07_skill_loading/main.ts - Skill 加载
 *
 * SYSTEM prompt 里只放技能目录（名称 + 一行描述），完整的 SKILL.md 要等模型
 * 调用 load_skill 才进上下文：
 *
 *   skills/                    启动时
 *   +------------------+       +------------------+
 *   | code-review/     | ----> | scanSkills       |
 *   |   SKILL.md       |       | name + 描述      |
 *   | pdf/             |       +--------+---------+
 *   |   SKILL.md       |                |
 *   +------------------+                v
 *                              SYSTEM 里的技能目录
 *
 *   LLM -- load_skill(name) --> 完整 SKILL.md
 *    ^                              |
 *    +--------- tool_result --------+
 *
 * 相比 s06 的变化：
 *   工具层：s02 的基础工具层 + 一个 load_skill，和 code.py 一致；s05 的 todo_write、
 *          s06 的 task 都不在本章的工具表里。dispatch 复用 s05 的 BASE_HANDLERS。
 *   Hook 层：hook 实例与默认 hook 全部复用 s05（它又复用 s04），s07 不再重复定义。
 *   + scanSkills() / buildSystem() —— 启动时扫描 skills/ 目录，把目录注入 SYSTEM
 *   + loadSkill(name) —— 通过 tool_result 返回完整 SKILL.md 内容
 *   + SKILLS_DIR 配置
 *   agentLoop 与 s06 的区别只有一处：system 来自 deps，因为目录是启动时扫出来的。
 *
 * frontmatter 解析：和 Python 版一样用 YAML 库（Python 是 PyYAML，这里是 `yaml`），
 * 才能正确处理 `description: |` 这类多行块标量——手写的逐行 `key: value` 解析
 * 会把 `|` 当成值、把缩进续行误当新 key。
 *
 * 基于 s06（subagent）构建。Usage:
 *
 *     pnpm dev s07_skill_loading/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：基础工具层（bash + 四个文件工具）。
import {
  tools as baseTools,
  TOOL_SCHEMAS as S02_TOOL_SCHEMAS,
} from "../s02_tool_use/main";
import type { Deps as S04Deps } from "../s04_hooks/main";
// 来自 s05：hook 装配（loadHooks = createHooks + registerDefaultHooks）+ 基础
// dispatch 表（BASE_HANDLERS）——单一出处在 s05。
import { BASE_HANDLERS, loadHooks } from "../s05_todo_write/main";

// s07 导出自己拥有的东西：技能层 + agentLoop + Deps，
// 外加装配好的三张工具表（base + load_skill），供 s08 继续叠加。
// 复用来的符号（各 hook / 基础 handler）由测试各自从源头 import。

const WORKDIR = process.cwd();
export const SKILLS_DIR = path.join(WORKDIR, "skills");

// ═══════════════════════════════════════════════════════════
//  s07 新增：技能目录扫描 + 带目录的 SYSTEM
// ═══════════════════════════════════════════════════════════

export type Skill = { name: string; description: string; content: string };
export type SkillRegistry = Record<string, Skill>;

// 解析 SKILL.md 的 frontmatter，返回 { meta, body }。
// 用下标切出首尾 `---` 之间的 YAML 段，再交给 yaml.parse——块标量、引号、
// 多行值都由库处理，不自己逐行解析。（按下标切，而非 split("---")，是因为
// JS 的 split 带 limit 会丢掉剩余部分，会把 body 里后续的 `---` 一起吞掉。）
export function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: text };
  let meta: Record<string, string> = {};
  try {
    const parsed = parseYaml(text.slice(3, end));
    if (parsed && typeof parsed === "object") {
      meta = parsed as Record<string, string>;
    }
  } catch {
    meta = {}; // frontmatter 不是合法 YAML 时退回空 meta（scanSkills 自有兜底）
  }
  return { meta, body: text.slice(end + 3).trim() };
}

// 扫描 skills/ 目录得到 registry（纯函数：传目录、返回 registry，
// 不依赖模块级全局，入口自己持有它，测试也能各建各的）。
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
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name ?? entry.name).trim();
    // 描述优先取 frontmatter 的 description，缺省则退回正文首行；两种来源都压成
    // 单行（去掉开头的 # 号、合并空白），目录里每个技能只占一行。
    const description = collapse(meta.description ?? body.split("\n")[0] ?? "");
    registry[name] = { name, description, content: raw };
  }
  return registry;
}

// 去掉开头的 # 与空格，再把所有空白折成单个空格：多行块标量的 description
// 也能塞进目录的一行里。
function collapse(text: string): string {
  return text
    .replace(/^[#\s]+/, "")
    .split(/\s+/)
    .join(" ")
    .trim();
}

// 列出所有技能（名称 + 一行描述）。
export function listSkills(registry: SkillRegistry): string {
  const skills = Object.values(registry);
  if (!skills.length) return "(no skills found)";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

// s07：SYSTEM 里带上技能目录（便宜——只有名称 + 描述）。
export function buildSystem(registry: SkillRegistry): string {
  return (
    `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. ` +
    "Act, don't explain.\n\n" +
    `Skills available:\n${listSkills(registry)}\n\n` +
    "Use load_skill to read the full instructions when a skill applies."
  );
}

// 入口层 helper：扫描 + 把技能目录单独记进 transcript，返回 registry。
// scanSkills 保持纯净，副作用（日志）留在这层，s07/s08 入口复用。
export function loadSkills(dir: string, logger: SessionLogger): SkillRegistry {
  const registry = scanSkills(dir);
  logger.section("SKILL CATALOG", listSkills(registry));
  return registry;
}

// 加载技能完整内容。经 registry 查表——不做路径拼接，杜绝目录穿越。
// 查不到时把可选名字一并回给模型，它下一轮就能改用正确的名字。
export function loadSkill(registry: SkillRegistry, name: string): string {
  const skill = registry[name];
  if (skill) return skill.content;
  const available = Object.keys(registry).join(", ") || "none";
  return `Error: Unknown skill '${name}'. Available: ${available}`;
}

// agentLoop 需要的完整依赖：基础 Deps + 技能表 + 本轮 system prompt。
export type Deps = S04Deps & { skills: SkillRegistry; system: string };

// 记录一次技能加载：往 transcript 记一条摘要（加载了哪个技能、命中与否、多大）。
// 走独立的 SKILL 一节（而非普通 toolResult），便于区分和 grep；完整内容另由 toolResult 落一份。
export function logSkill(
  logger: SessionLogger,
  name: string,
  found: boolean,
  size: number,
): void {
  logger.section(
    "SKILL",
    found ? `load ${name} (${size} chars)` : `not found: ${name}`,
  );
}

// s07：技能加载走独立的 skill 日志通道（logSkill）—— 单独记一条「加载了哪个技能、
// 命中与否、多大」。（child 是给子 agent 做 main/sub 隔离的，技能不是 agent，不借它。）
// loadSkill 保持纯查表，日志这个副作用留在这层 wrapper。
export function runLoadSkill(name: string, deps: Deps): string {
  const content = loadSkill(deps.skills, name);
  const found = deps.skills[name] !== undefined;
  logSkill(deps.logger, name, found, content.length);
  return content;
}

// ═══════════════════════════════════════════════════════════
//  工具装配：s02 的基础工具层 + 一个 load_skill
//  三张表都用展开语法在基础之上追加，调用点（agentLoop）不用改。
// ═══════════════════════════════════════════════════════════

const loadSkillSchema = z.object({ name: z.string() });

export const tools: Anthropic.Tool[] = [
  ...baseTools,
  // s07 新增：load_skill（目录已在 SYSTEM 里，这里加载完整内容）
  zodTool(
    "load_skill",
    "Load the full SKILL.md content by skill name.",
    loadSkillSchema,
  ),
];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S02_TOOL_SCHEMAS,
  load_skill: loadSkillSchema,
};

// 基础 handler 是 (input)=>string，忽略第二参；load_skill 靠它拿到 skills/logger。
// handler 类型留着 Promise 分支，供 s08 在这张表上追加异步工具。
export const TOOL_HANDLERS: Partial<
  Record<string, (input: any, deps: Deps) => string | Promise<string>>
> = {
  ...BASE_HANDLERS,
  // load_skill 走 runLoadSkill：查表 + 专属 [skill] logger。
  load_skill: ({ name }, deps) => runLoadSkill(name, deps),
};

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 和 s06 一样，load_skill 通过 TOOL_HANDLERS 自动分发
//  和 s06 的唯一区别：system 来自 deps，因为目录是启动时扫出来的。
// ═══════════════════════════════════════════════════════════

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, system, hooks } = deps;
  while (true) {
    logger.request(messages);
    const response = await client.messages.create({
      model: MODEL_ID,
      system,
      messages,
      tools,
      max_tokens: 8000,
    });
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
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
      // await —— 表里的 handler 类型允许异步（s08 会往这张表里加 async 工具）。
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
// Prompt example: Use the code-review skill to review the last commit.
if (import.meta.main) {
  const client: ModelClient = createClient();
  const logger: SessionLogger = createLogger(import.meta.dirname);
  const skills = loadSkills(SKILLS_DIR, logger);
  const system = buildSystem(skills);

  logger.config({ model: MODEL_ID, system, tools });

  const hooks = loadHooks(logger);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  print("s07: Skill Loading - 目录进 SYSTEM，内容按需加载", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s07 >> ", "cyan"));
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
      system,
    });
    print(finalText, "green");
    print();
  }
  rl.close();
}

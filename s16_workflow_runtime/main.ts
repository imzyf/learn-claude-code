/**
 * s16_workflow_runtime/main.ts - Workflow 运行时
 *
 * 一次 tool_use 跑完一整套保存好的编排：脚本决定步骤，模型只决定单步。
 *
 *     +-------------+       +--------------------------------+
 *     | Agent loop  | ----> | Workflow(name, args, runId)    |
 *     +-------------+       +---------------+----------------+
 *                                           |
 *                            +--------------+--------------+
 *                            | agent | parallel | pipeline |
 *                            +--------------+--------------+
 *                                           |
 *                                    journal + result
 *
 *     .runtime/<runId>.json          快照：workflow 名、参数、任务状态
 *     .runtime/<runId>.output.json   最终结果
 *     .runtime/<runId>.journal.jsonl 每次 agent() 的结果，续跑靠它
 *     .runtime/<runId>.lock          同一次运行的互斥文件
 *
 * 相比 s15 的变化：
 *   主循环、工具池、system prompt、错误恢复全部复用 s15，不再内联。
 *   本文件只新增 workflow 这一层：
 *   + WorkflowRuntime：store 目录 + 已注册 workflow registry + runner 工厂，
 *     由入口持有、经参数传入（对齐 s12 CronState / s13 TeamState 的注入风格）
 *   + validateMeta / checkPermission：保存好的元数据在执行前校验、过权限闸门
 *   + ExecutionState：agent / parallel / pipeline / phase / log / workflow 六个原语，
 *     脚本拿不到文件与 shell
 *   + validateJson：agent({schema}) 的最小 JSON Schema 校验，不合法重试一次
 *   + WorkflowJournal：append-only jsonl，key 由调用内容算稳定哈希，
 *     resume 时命中的 agent() 直接返回缓存
 *   + Budget / ExecutionLimits：token 预算、agent() 上限与并发上限
 *   + LocalWorkflowTask：task_started -> 一串 progress -> task_notification
 *   + Workflow 工具与适配器：模型只能传 name / args / resume_from_run_id
 *
 * TS 特有说明：
 *   - code.py 用 asyncio.to_thread 把同步 runner 挪出事件循环；这里 runner 本身就是
 *     async，agent() 直接 await，并发上限由 ExecutionLimits 里的信号量控制。
 *   - code.py 用 threading.Lock + fcntl.flock 串行化同一次运行；这里是单线程事件循环，
 *     进程内用一个 activeRuns 集合，跨进程用 `wx` 独占创建 <runId>.lock（结束即删除）。
 *   - 模块级 STORE / RUNNER_FACTORY 全局收进 WorkflowRuntime：入口用
 *     createWorkflowRuntime(import.meta.dirname, ...) 落到本章目录，测试传临时目录做隔离。
 *   - code.py 靠 monkeypatch 往 s15 宿主的工具池里塞 Workflow；这里走 s15 Deps 上的
 *     extraPool，agentLoop 每轮组装工具池时把它叠在内置 + MCP 工具之后。
 *   - 本章入口只保留用户轮的读-跑-打印循环，cron / 团队 / 后台四路唤醒仍留在 s15。
 *
 * 基于 s15（集成 harness）构建。Usage:
 *
 *     pnpm dev s16_workflow_runtime/main.ts          # 主模型与 workflow 子 agent 都用真实 API
 *     pnpm dev s16_workflow_runtime/main.ts demo     # 固定 runner 数据，观察事件流与 journal
 *     pnpm dev s16_workflow_runtime/main.ts resume   # 用上次 runId 续跑，全部命中缓存
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { createPrompt, print, printError, printFinal } from "../lib/terminal";
import { zodTool } from "../lib/tools";
// 来自 s02：错误转文本（工具异常统一收敛成 tool_result）。
import { errMsg } from "../s02_tool_use/main";
// 来自 s03：权限确认抽象。
import { makeConfirm } from "../s03_permission/main";
// 来自 s07 / s09 / s11 / s12 / s13 / s14：入口要给 s15 agentLoop 备齐的跨轮状态。
import { loadSkills, SKILLS_DIR } from "../s07_skill_loading/main";
import { MEMORY_DIR } from "../s09_memory/main";
import { BackgroundManager } from "../s11_background_tasks/main";
import { createCronState } from "../s12_cron_scheduler/main";
import { createTeamState } from "../s13_agent_teams/main";
import { createMcpState, loadMcpHooks } from "../s14_mcp_plugin/main";
// 来自 s15：主循环与工具池类型，本章不改循环，只往池子里加一个工具。
import { agentLoop, type ToolPool } from "../s15_integrated_harness/main";

// ═══════════════════════════════════════════════════════════
//  运行时守卫
// ═══════════════════════════════════════════════════════════

// 一次运行里 agent() 的硬上限。
export const AGENT_CAP = 1000;
// 同时在跑的 agent() 数量上限。
export const CONCURRENCY = 8;
// 快照、输出与 journal 落盘的目录名。
export const RUNTIME_DIR = ".runtime";

const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;

// 元数据、schema、runId 这类输入问题统一用这个错误类型。
export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

// 进程稳定的哈希：journal 的 key 要跨进程（run 与 resume 两次执行）保持一致，
// 所以不能用随进程变化的哈希。
export function stableHash(input: string): bigint {
  return BigInt(`0x${createHash("sha256").update(input).digest("hex")}`);
}

const hashMod = (input: string, mod: number): number =>
  Number(stableHash(input) % BigInt(mod));

// key 里嵌 schema 时要保证同一份 schema 得到同一段文本，所以按 key 排序序列化。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function createRunId(name: string): string {
  return `wf_${name}_${randomBytes(8).toString("hex")}`;
}

export function validateRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new WorkflowInputError("invalid workflow runId");
  }
  return runId;
}

export function createTaskId(runId: string): string {
  return `local_workflow_${runId}`;
}

// 预留一个全新的 runId：先独占创建快照文件占位，再去开 journal，
// 这样新运行不可能截断另一次运行的 journal。
export function reserveRunId(store: string, name: string): string {
  fs.mkdirSync(store, { recursive: true });
  for (let i = 0; i < 32; i += 1) {
    const runId = validateRunId(createRunId(name));
    try {
      fs.closeSync(fs.openSync(path.join(store, `${runId}.json`), "wx"));
      return runId;
    } catch {
      // 撞名就换一个再试。
    }
  }
  throw new WorkflowInputError("could not allocate a unique workflow runId");
}

// ── 元数据校验与权限 ──────────────────────────────────────
export type WorkflowMeta = {
  name: string;
  description: string;
  phases?: string[];
};

// 保存好的 workflow 在执行前校验：坏的注册内容不要等到跑起来才发现（同 s12 的 cron 表达式）。
export function validateMeta(meta: unknown): WorkflowMeta {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new WorkflowInputError("meta must be an object literal");
  }
  const { name, description, phases } = meta as Record<string, unknown>;
  if (!name || !description) {
    throw new WorkflowInputError("meta requires `name` and `description`");
  }
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name)) {
    throw new WorkflowInputError(
      "meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'",
    );
  }
  if (typeof description !== "string") {
    throw new WorkflowInputError("meta.description must be a string");
  }
  if (
    phases !== undefined &&
    (!Array.isArray(phases) ||
      !phases.every((phase) => typeof phase === "string" && phase))
  ) {
    throw new WorkflowInputError(
      "meta.phases must be a list of non-empty strings",
    );
  }
  return {
    name,
    description,
    ...(phases ? { phases: phases as string[] } : {}),
  };
}

// s03 的 allow / deny 闸门：启动前先过一遍。
export function checkPermission(
  meta: WorkflowMeta,
  deny: string[] = [],
): "allow" {
  if (deny.includes(meta.name)) {
    throw new WorkflowInputError(`workflow '${meta.name}' denied by settings`);
  }
  return "allow";
}

// ═══════════════════════════════════════════════════════════
//  最小 JSON Schema：agent({schema}) 的校验层
// ═══════════════════════════════════════════════════════════

export type JsonSchema = {
  type?: "object" | "array" | "string" | "boolean" | "number" | "integer";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
};

// 合法返回 null，不合法返回可读原因（会被拼进重试提示与错误信息）。
export function validateJson(
  value: unknown,
  schema: JsonSchema,
): string | null {
  if (schema.enum && !schema.enum.includes(value)) {
    return `expected one of ${JSON.stringify(schema.enum)}`;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "expected object";
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) return `missing required key '${key}'`;
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (!(key in record)) continue;
        const err = validateJson(record[key], sub);
        if (err) return `${key}: ${err}`;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return "expected array";
      if (!schema.items) return null;
      for (const [i, element] of value.entries()) {
        const err = validateJson(element, schema.items);
        if (err) return `[${i}]: ${err}`;
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "boolean":
      return typeof value === "boolean" ? null : "expected boolean";
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "expected number";
    default:
      return null;
  }
}

// mock runner 遇到没有特判的 schema 时，用它按 schema 造一份确定性数据。
function fillSchema(schema: JsonSchema, seed: string): unknown {
  switch (schema.type) {
    case "object": {
      const properties = schema.properties ?? {};
      const keys = schema.required?.length
        ? schema.required
        : Object.keys(properties);
      return Object.fromEntries(
        keys
          .filter((key) => properties[key])
          .map((key) => [
            key,
            fillSchema(properties[key] as JsonSchema, `${seed}/${key}`),
          ]),
      );
    }
    case "array":
      return schema.items ? [fillSchema(schema.items, `${seed}/0`)] : [];
    case "boolean":
      return hashMod(seed, 4) !== 0;
    case "number":
    case "integer":
      return hashMod(seed, 5);
    default:
      return seed.split("/").pop() ?? seed;
  }
}

// ═══════════════════════════════════════════════════════════
//  Agent runner：workflow 与模型之间的唯一边界
// ═══════════════════════════════════════════════════════════

export type RunnerOutput = { value: unknown; tokens: number };

export interface AgentRunner {
  run(
    prompt: string,
    schema?: JsonSchema,
    label?: string,
  ): Promise<RunnerOutput>;
}

const SEVERITIES = ["high", "medium", "low"] as const;

// demo 与单元测试用的确定性 runner：同样的 prompt 永远得到同样的结果。
export class MockAgentRunner implements AgentRunner {
  async run(
    prompt: string,
    schema?: JsonSchema,
    label?: string,
  ): Promise<RunnerOutput> {
    if (!schema) {
      const value = `[mock] ${(label ?? prompt).slice(0, 60)}`;
      return { value, tokens: tokensOf(prompt, value) };
    }
    const properties = schema.properties ?? {};
    let value: unknown;
    if ("findings" in properties) {
      const n = 1 + hashMod(prompt, 2);
      value = {
        findings: Array.from({ length: n }, (_, i) => ({
          title: `${label ?? "audit"} #${i + 1}`,
          severity: SEVERITIES[hashMod(`${prompt}${i}`, 3)],
        })),
      };
    } else if ("isReal" in properties) {
      const isReal = hashMod(prompt, 4) !== 0;
      value = {
        isReal,
        reason: isReal ? "reproduced" : "could not reproduce",
      };
    } else {
      value = fillSchema(schema, prompt);
    }
    return { value, tokens: tokensOf(prompt, value) };
  }
}

function tokensOf(prompt: string, result: unknown): number {
  return (
    Math.floor(prompt.length / 4) +
    Math.floor(JSON.stringify(result).length / 4)
  );
}

const RUNNER_SYSTEM =
  "You are a focused workflow agent. Complete only the supplied step. " +
  "Do not claim access to files or results not included in the prompt.";

// 真实 runner：workflow 的子 agent 与宿主用同一个 client。
export class AnthropicAgentRunner implements AgentRunner {
  constructor(
    private readonly client: ModelClient,
    private readonly model: string = MODEL_ID,
  ) {}

  async run(
    prompt: string,
    schema?: JsonSchema,
    _label?: string,
  ): Promise<RunnerOutput> {
    const request = schema
      ? `${prompt}\n\nReturn only one JSON object matching this schema:\n` +
        stableStringify(schema)
      : prompt;
    const response = await this.client.messages.create({
      model: this.model,
      system: RUNNER_SYSTEM,
      messages: [{ role: "user", content: request }],
      max_tokens: 2000,
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    // 解析失败时原样返回文本，让 agent() 的 schema 校验去触发那一次重试。
    const value = schema ? (parseRunnerJson(text) ?? text) : text;
    const usage = response.usage;
    return {
      value,
      tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    };
  }
}

// 先剥掉 ``` 围栏整体解析，再退化成扫第一个成对的 { ... }。
export function parseRunnerJson(text: string): unknown {
  let body = text.trim();
  if (body.startsWith("```")) {
    const lines = body.split("\n").slice(1);
    if (lines.at(-1)?.trim() === "```") lines.pop();
    body = lines.join("\n").trim();
  }
  try {
    return JSON.parse(body);
  } catch {
    const slice = firstJsonObject(body);
    if (slice === null) return null;
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
}

// 数花括号找第一个完整对象，跳过字符串字面量里的括号。
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  Journal：断点续跑的存档
// ═══════════════════════════════════════════════════════════

// append-only 的 <runId>.journal.jsonl。resume 时语义 key 已在档的 agent()
// 直接读缓存，不再真的跑。
export class WorkflowJournal {
  readonly path: string;
  private readonly cache = new Map<string, unknown>();
  private readonly fd: number;

  constructor(store: string, runId: string, resume: boolean) {
    fs.mkdirSync(store, { recursive: true });
    this.path = path.join(store, `${runId}.journal.jsonl`);
    if (resume) {
      if (!fs.existsSync(this.path)) {
        throw new WorkflowInputError(`resume journal not found for ${runId}`);
      }
      const lines = fs.readFileSync(this.path, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line) continue;
        const record = parseJournalLine(line, index + 1);
        this.cache.set(record.key, record.value);
      }
    }
    this.fd = fs.openSync(this.path, resume ? "a" : "w"); // 新运行截断重写
  }

  // 语义 key 与并发完成顺序无关：parallel / pipeline 里的调用在 resume 时
  // 仍能对上各自那一条记录。
  key(
    kind: string,
    label: string,
    prompt: string,
    schema?: JsonSchema,
  ): string {
    const basis = `${kind}|${label}|${prompt}|${stableStringify(schema ?? null)}`;
    const digits = stableHash(basis) % 10_000_000_000n;
    return `${kind}-${String(digits).padStart(10, "0")}`;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get(key: string): unknown {
    return this.cache.get(key);
  }

  record(key: string, value: unknown): void {
    fs.writeSync(this.fd, `${JSON.stringify({ key, value })}\n`);
    this.cache.set(key, value);
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

function parseJournalLine(
  line: string,
  lineNumber: number,
): { key: string; value: unknown } {
  const invalid = new WorkflowInputError(
    `invalid resume journal record at line ${lineNumber}`,
  );
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    throw invalid;
  }
  if (
    typeof record !== "object" ||
    record === null ||
    typeof (record as { key?: unknown }).key !== "string" ||
    !Object.hasOwn(record, "value")
  ) {
    throw invalid;
  }
  return record as { key: string; value: unknown };
}

// ═══════════════════════════════════════════════════════════
//  预算与任务生命周期
// ═══════════════════════════════════════════════════════════

// 预算耗尽时 agent() 直接报错，不静默超支。
export class Budget {
  private used = 0;
  constructor(readonly total: number | null = null) {}

  add(n: number): void {
    if (this.total !== null && this.used + n > this.total) {
      throw new WorkflowInputError(
        `token budget exceeded (${this.used + n} > ${this.total})`,
      );
    }
    this.used += n;
  }

  spent(): number {
    return this.used;
  }

  remaining(): number {
    return this.total === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.used);
  }
}

export type ProgressEvent = { type: string } & Record<string, unknown>;

// 保存 workflow 的状态、用量与进度事件流。
export class LocalWorkflowTask {
  status: "running" | "completed" | "failed" = "running";
  usage = { agents: 0, tokens: 0 };
  progress: ProgressEvent[] = [];

  constructor(
    readonly taskId: string,
    readonly runId: string,
    readonly meta: WorkflowMeta,
    private readonly logger: SessionLogger,
  ) {}

  event(name: string, data: Record<string, unknown>): void {
    this.logger.console(
      `  event      ${name.padEnd(18)} ${formatFields(data)}`,
      "magenta",
    );
  }

  progressEvent(type: string, data: Record<string, unknown>): void {
    this.progress.push({ type, ...data });
    this.logger.console(
      `  progress   ${type.padEnd(16)} ${formatFields(data)}`,
      "gray",
    );
  }
}

const formatFields = (data: Record<string, unknown>): string =>
  Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

export type SerializedTask = {
  taskId: string;
  taskType: "local_workflow";
  runId: string;
  workflowName: string;
  status: string;
  usage: { agents: number; tokens: number };
  progress: ProgressEvent[];
};

export function serializeTask(task: LocalWorkflowTask): SerializedTask {
  return {
    taskId: task.taskId,
    taskType: "local_workflow",
    runId: task.runId,
    workflowName: task.meta.name,
    status: task.status,
    usage: { ...task.usage },
    progress: [...task.progress],
  };
}

// ═══════════════════════════════════════════════════════════
//  编排原语
// ═══════════════════════════════════════════════════════════

// 最小信号量：acquire 到名额才继续，release 直接把名额转交给等待者。
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

// 整次运行共享的上限，嵌套 workflow 也算在同一份里。
export class ExecutionLimits {
  agents = 0;
  readonly semaphore = new Semaphore(CONCURRENCY);

  claimAgent(): void {
    this.agents += 1;
    if (this.agents > AGENT_CAP) {
      throw new WorkflowInputError(`agent() cap reached (${AGENT_CAP})`);
    }
  }
}

export type WorkflowArgs = Record<string, unknown>;
export type WorkflowScript = (
  ctx: ExecutionState,
  args: WorkflowArgs,
) => Promise<unknown>;
export type WorkflowEntry = { meta: WorkflowMeta; script: WorkflowScript };
export type WorkflowRegistry = Record<string, WorkflowEntry>;

// stage 之间传递的值由脚本自己决定形状，和 code.py 一样保持动态类型。
export type PipelineStage = (
  value: any,
  item: any,
  index: number,
) => Promise<any>;

export type AgentOptions = {
  schema?: JsonSchema;
  label?: string;
  phase?: string;
};

export type ExecutionInit = {
  task: LocalWorkflowTask;
  journal: WorkflowJournal;
  runner: AgentRunner;
  budget: Budget;
  args: WorkflowArgs;
  workflows: WorkflowRegistry;
  depth?: number;
  limits?: ExecutionLimits;
};

// 注入给 workflow 脚本的编排原语；脚本读不到文件，也跑不了 shell。
export class ExecutionState {
  readonly task: LocalWorkflowTask;
  readonly journal: WorkflowJournal;
  readonly runner: AgentRunner;
  readonly budget: Budget;
  readonly args: WorkflowArgs;
  private readonly workflows: WorkflowRegistry;
  private readonly depth: number;
  private readonly limits: ExecutionLimits;
  private currentPhase: string | null = null;
  private readonly phasesSeen = new Set<string>();

  constructor(init: ExecutionInit) {
    this.task = init.task;
    this.journal = init.journal;
    this.runner = init.runner;
    this.budget = init.budget;
    this.args = init.args;
    this.workflows = init.workflows;
    this.depth = init.depth ?? 0;
    this.limits = init.limits ?? new ExecutionLimits();
  }

  // 开一个阶段，后续 agent() 归到它名下。同名阶段是 upsert：
  // pipeline 里每个 item 再喊一次也不会重复播报。
  phase(title: string): void {
    this.currentPhase = title;
    if (this.phasesSeen.has(title)) return;
    this.phasesSeen.add(title);
    this.task.progressEvent("workflow_phase", { title });
  }

  log(message: string): void {
    this.task.progressEvent("workflow_log", { message });
  }

  // 派一个子 agent。带 schema 就校验输出（不合法重试一次）；
  // resume 时 key 命中 journal 直接返回缓存。
  async agent<T = unknown>(
    prompt: string,
    options: AgentOptions = {},
  ): Promise<T> {
    const { schema, phase } = options;
    const label = options.label ?? `${prompt.slice(0, 24)}...`;
    this.limits.claimAgent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError("token budget exceeded");
    }

    const key = this.journal.key("agent", label, prompt, schema);
    if (this.journal.has(key)) {
      const cached = this.journal.get(key);
      if (schema) {
        const err = validateJson(cached, schema);
        if (err) {
          throw new WorkflowInputError(
            `cached agent output failed schema validation: ${err}`,
          );
        }
      }
      this.task.progressEvent("workflow_agent", {
        label,
        phase: phase ?? this.currentPhase,
        status: "cached",
      });
      return cached as T;
    }

    await this.limits.semaphore.acquire();
    let value: unknown;
    let tokens: number;
    try {
      const run = await this.runner.run(prompt, schema, label);
      value = run.value;
      tokens = run.tokens;
    } finally {
      this.limits.semaphore.release();
    }

    if (schema) {
      let err = validateJson(value, schema);
      if (err) {
        const retry = await this.runner.run(
          `${prompt}\n\nReturn valid JSON.`,
          schema,
          label,
        );
        value = retry.value;
        tokens += retry.tokens;
        err = validateJson(value, schema);
        if (err) {
          throw new WorkflowInputError(
            `agent({schema}) invalid output: ${err}`,
          );
        }
      }
    }

    this.budget.add(tokens);
    this.task.usage.agents += 1;
    this.task.usage.tokens += tokens;
    this.journal.record(key, value);
    this.task.progressEvent("workflow_agent", {
      label,
      phase: phase ?? this.currentPhase,
      status: "done",
    });
    return value as T;
  }

  // 等齐屏障：全部并发跑，任意一个失败就让整个 workflow 失败。
  async parallel<T>(thunks: (() => Promise<T>)[]): Promise<T[]> {
    return Promise.all(thunks.map((thunk) => thunk()));
  }

  // 每个 item 独立走完所有 stage，stage 之间没有屏障：item A 可能在第 3 阶段，
  // item B 还在第 1 阶段。stage 收到 (上一阶段结果, 原始 item, 序号)。
  async pipeline(items: any[], ...stages: PipelineStage[]): Promise<any[]> {
    const runItem = async (item: any, index: number): Promise<any> => {
      let value: any = item;
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    };
    return Promise.all(items.map(runItem));
  }

  // 把另一个保存好的 workflow 当子流程跑（只允许一层），
  // 与父流程共享 journal、预算和 agent 计数。
  async workflow(name: string, args: WorkflowArgs = {}): Promise<unknown> {
    if (this.depth >= 1) {
      throw new WorkflowInputError("workflow() nesting is one level only");
    }
    const entry = this.workflows[name];
    if (!entry) throw new WorkflowInputError(`unknown workflow '${name}'`);
    const child = new ExecutionState({
      task: this.task,
      journal: this.journal,
      runner: this.runner,
      budget: this.budget,
      args,
      workflows: this.workflows,
      depth: this.depth + 1,
      limits: this.limits,
    });
    return entry.script(child, args);
  }
}

// ═══════════════════════════════════════════════════════════
//  存储与运行时状态
// ═══════════════════════════════════════════════════════════

// 跨轮复用的 workflow 运行时：store 目录 + registry + runner 工厂。
// 入口用 createWorkflowRuntime(import.meta.dirname, ...)，测试传临时目录做隔离。
export type WorkflowRuntime = {
  store: string;
  workflows: WorkflowRegistry;
  createRunner: () => AgentRunner;
  logger: SessionLogger;
  deny: string[];
  // 本进程内正在跑的 runId：单线程事件循环下它就是那把「同一次运行只能有一个」的锁。
  active: Set<string>;
};

export function createWorkflowRuntime(
  sessionDir: string,
  options: {
    logger: SessionLogger;
    store?: string;
    workflows?: WorkflowRegistry;
    createRunner?: () => AgentRunner;
    deny?: string[];
  },
): WorkflowRuntime {
  return {
    store: options.store ?? path.join(sessionDir, RUNTIME_DIR),
    workflows: options.workflows ?? WORKFLOWS,
    createRunner: options.createRunner ?? (() => new MockAgentRunner()),
    logger: options.logger,
    deny: options.deny ?? [],
    active: new Set(),
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

export type WorkflowSnapshot = {
  runId: string;
  workflowName: string;
  args: WorkflowArgs;
  task: SerializedTask;
};

function readSnapshot(store: string, runId: string): WorkflowSnapshot {
  const file = path.join(store, `${runId}.json`);
  if (!fs.existsSync(file)) {
    throw new WorkflowInputError(`resume snapshot not found for ${runId}`);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  return snapshot as WorkflowSnapshot;
}

export function saveLastRun(store: string, runId: string): void {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "last_run.txt"), runId);
}

export function readLastRun(store: string): string | null {
  const file = path.join(store, "last_run.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

// 整次执行加最终落盘都握着这把锁：另一个进程不能同时 resume 同一次运行。
function acquireRunLock(runtime: WorkflowRuntime, runId: string): () => void {
  const busy = new WorkflowInputError(
    `workflow run ${runId} is already active`,
  );
  if (runtime.active.has(runId)) throw busy;
  fs.mkdirSync(runtime.store, { recursive: true });
  const lockFile = path.join(runtime.store, `${runId}.lock`);
  let fd: number;
  try {
    fd = fs.openSync(lockFile, "wx");
  } catch {
    throw busy;
  }
  runtime.active.add(runId);
  return () => {
    runtime.active.delete(runId);
    fs.closeSync(fd);
    fs.rmSync(lockFile, { force: true });
  };
}

// ═══════════════════════════════════════════════════════════
//  Workflow 工具：一次调用跑完整次运行
// ═══════════════════════════════════════════════════════════

export type Launched = {
  status: "async_launched";
  taskId: string;
  taskType: "local_workflow";
  runId: string;
  workflowName: string;
};

export type WorkflowOutcome = {
  launched: Launched;
  result: unknown;
  task: LocalWorkflowTask;
};

// 校验元数据、过权限、建 runId / taskId、注册任务，然后执行脚本并发生命周期事件。
export async function callWorkflow(
  runtime: WorkflowRuntime,
  meta: WorkflowMeta,
  script: WorkflowScript,
  options: { args?: WorkflowArgs | null; resumeFromRunId?: string } = {},
): Promise<WorkflowOutcome> {
  validateMeta(meta);
  checkPermission(meta, runtime.deny);
  const resuming = options.resumeFromRunId !== undefined;
  const runId = resuming
    ? validateRunId(options.resumeFromRunId)
    : reserveRunId(runtime.store, meta.name);

  const release = acquireRunLock(runtime, runId);
  try {
    return await runLocked(runtime, meta, script, {
      runId,
      resuming,
      args: options.args ?? null,
    });
  } finally {
    release();
  }
}

async function runLocked(
  runtime: WorkflowRuntime,
  meta: WorkflowMeta,
  script: WorkflowScript,
  init: { runId: string; resuming: boolean; args: WorkflowArgs | null },
): Promise<WorkflowOutcome> {
  const { runId, resuming } = init;
  let args: WorkflowArgs;
  let journal: WorkflowJournal;
  if (resuming) {
    const snapshot = readSnapshot(runtime.store, runId);
    if (snapshot.workflowName !== meta.name) {
      throw new WorkflowInputError("resume runId does not match workflow meta");
    }
    const savedArgs = snapshot.args ?? {};
    if (init.args === null) {
      args = savedArgs;
    } else if (stableStringify(init.args) !== stableStringify(savedArgs)) {
      throw new WorkflowInputError("resume args do not match the original run");
    } else {
      args = init.args;
    }
    journal = new WorkflowJournal(runtime.store, runId, true);
  } else {
    args = init.args ?? {};
    journal = new WorkflowJournal(runtime.store, runId, false);
  }

  const taskId = createTaskId(runId);
  const task = new LocalWorkflowTask(taskId, runId, meta, runtime.logger);
  // 执行开始前先把启动信封记下来。
  const launched: Launched = {
    status: "async_launched",
    taskId,
    taskType: "local_workflow",
    runId,
    workflowName: meta.name,
  };
  task.event("async_launched", { runId, taskId });
  task.event("task_started", {
    workflow: meta.name,
    phases: meta.phases?.join(",") || "-",
    resume: resuming,
  });
  const snapshotFile = path.join(runtime.store, `${runId}.json`);
  writeJson(snapshotFile, {
    runId,
    workflowName: meta.name,
    args,
    task: serializeTask(task),
  });

  const budgetArg = args.budget;
  let result: unknown;
  try {
    const ctx = new ExecutionState({
      task,
      journal,
      runner: runtime.createRunner(),
      budget: new Budget(typeof budgetArg === "number" ? budgetArg : null),
      args,
      workflows: runtime.workflows,
    });
    result = await script(ctx, args);
    task.status = "completed";
  } catch (e) {
    // 失败与中止也要走完收尾：状态、产物、通知一样不少。
    task.status = "failed";
    result = { error: errMsg(e) };
  } finally {
    journal.close();
  }

  writeJson(path.join(runtime.store, `${runId}.output.json`), result);
  writeJson(snapshotFile, {
    runId,
    workflowName: meta.name,
    args,
    task: serializeTask(task),
  });
  saveLastRun(runtime.store, runId);
  task.event("task_notification", {
    status: task.status,
    agents: task.usage.agents,
    tokens: task.usage.tokens,
    outputFile: `${RUNTIME_DIR}/${runId}.output.json`,
  });
  return { launched, result, task };
}

// 模型可见的输入：只有名称、参数和续跑 runId，可执行代码留在宿主 registry。
export const WORKFLOW_INPUT = z.strictObject({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  resume_from_run_id: z.string().optional(),
});

export const WORKFLOW_TOOL: Anthropic.Tool = zodTool(
  "Workflow",
  "Run a saved workflow by name. Pass input in args.",
  WORKFLOW_INPUT,
);

export type WorkflowToolResult = {
  launched: Launched;
  result: unknown;
  task: SerializedTask;
};

// 模型侧适配器：按名称从宿主 registry 取出可信的元数据与函数。
export async function runWorkflow(
  runtime: WorkflowRuntime,
  input: z.infer<typeof WORKFLOW_INPUT>,
): Promise<WorkflowToolResult> {
  const entry = runtime.workflows[input.name];
  if (!entry) throw new WorkflowInputError(`unknown workflow '${input.name}'`);
  const out = await callWorkflow(runtime, entry.meta, entry.script, {
    args: input.args ?? null,
    resumeFromRunId: input.resume_from_run_id,
  });
  return {
    launched: out.launched,
    result: out.result,
    task: serializeTask(out.task),
  };
}

// 挂到 s15 工具池上的那一层：名称未知或参数非法时回一条错误 tool_result，
// 宿主循环照常继续。
export function workflowToolPool(runtime: WorkflowRuntime): ToolPool {
  return {
    tools: [WORKFLOW_TOOL],
    handlers: {
      Workflow: async (input: unknown) => {
        try {
          const parsed = WORKFLOW_INPUT.parse(input);
          return JSON.stringify(await runWorkflow(runtime, parsed));
        } catch (e) {
          return `Error: ${errMsg(e)}`;
        }
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════
//  示例 workflow：review-changes
// ═══════════════════════════════════════════════════════════

export const FINDINGS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

export const VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["isReal", "reason"],
  properties: {
    isReal: { type: "boolean" },
    reason: { type: "string" },
  },
};

export const SAMPLE_META: WorkflowMeta = {
  name: "review-changes",
  description: "Review changed files across dimensions, verify each finding",
  phases: ["Review", "Verify"],
};

export const DIMENSIONS = ["correctness", "security", "performance", "style"];

export const DEMO_CHANGES =
  "def load_user(user_id):\n" +
  '    query = f"SELECT * FROM users WHERE id = {user_id}"\n' +
  "    return db.execute(query).fetchone()\n";

type Finding = { title: string; severity: "high" | "medium" | "low" };
type Verdict = { isReal: boolean; reason: string };

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// pipeline 让每个维度独立走「审计 -> 逐条验证」，只留验证确认的发现。
// 编排是代码，不是一轮轮聊出来的。
export async function sampleWorkflow(
  ctx: ExecutionState,
  args: WorkflowArgs,
): Promise<{ confirmed: (Finding & { dimension: string })[] }> {
  ctx.phase("Review");
  const changes = args.changes ?? "";
  if (typeof changes !== "string") {
    throw new WorkflowInputError("args.changes must be a string");
  }
  const reviewInput = changes.trim() || "No change context was supplied.";

  const audit: PipelineStage = async (_value, dimension: string) => {
    const out = await ctx.agent<{ findings: Finding[] }>(
      `Review this change context for ${dimension} issues. ` +
        "Report only issues supported by the supplied text.\n\n" +
        reviewInput,
      { schema: FINDINGS_SCHEMA, label: `audit:${dimension}`, phase: "Review" },
    );
    return { dimension, findings: out.findings };
  };

  const verify: PipelineStage = async (
    audited: { dimension: string; findings: Finding[] },
    dimension: string,
  ) => {
    ctx.phase("Verify");
    // 每条发现交给各自的对抗性子 agent，并发验证。
    const verdicts = await ctx.parallel(
      audited.findings.map(
        (finding) => () =>
          ctx.agent<Verdict>(
            `Adversarially verify this ${dimension} finding against the ` +
              "supplied change context.\n\n" +
              `Change context:\n${reviewInput}\n\n` +
              `Finding:\n${JSON.stringify(finding)}`,
            {
              schema: VERDICT_SCHEMA,
              label: `verify:${dimension}:${finding.title}`,
              phase: "Verify",
            },
          ),
      ),
    );
    return {
      dimension,
      confirmed: audited.findings.filter((_, i) => verdicts[i]?.isReal),
    };
  };

  const results: { dimension: string; confirmed: Finding[] }[] =
    await ctx.pipeline(DIMENSIONS, audit, verify);
  const confirmed = results
    .flatMap((r) => r.confirmed.map((f) => ({ dimension: r.dimension, ...f })))
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
    );
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { confirmed };
}

// 宿主持有的 workflow registry：模型只能按名字点它们。
export const WORKFLOWS: WorkflowRegistry = {
  [SAMPLE_META.name]: { meta: SAMPLE_META, script: sampleWorkflow },
};

// ═══════════════════════════════════════════════════════════
//  demo
// ═══════════════════════════════════════════════════════════

export async function runDemo(
  runtime: WorkflowRuntime,
  resumeFromRunId?: string,
): Promise<WorkflowToolResult> {
  if (resumeFromRunId) {
    print(
      `resuming ${resumeFromRunId}; unchanged agent() calls use the journal cache\n`,
      "yellow",
    );
  } else {
    print("launching workflow `review-changes`\n", "cyan");
  }

  const out = await runWorkflow(runtime, {
    name: SAMPLE_META.name,
    args: { changes: DEMO_CHANGES },
    resume_from_run_id: resumeFromRunId,
  });

  print("\nresult:");
  const confirmed = (
    out.result as { confirmed?: (Finding & { dimension: string })[] }
  ).confirmed;
  for (const f of confirmed ?? []) {
    print(`  [${f.severity.padEnd(6)}] ${f.dimension}: ${f.title}`);
  }
  const { status, usage, runId } = out.task;
  print(
    `\nstatus=${status}  agents=${usage.agents}  tokens=${usage.tokens}  ` +
      `journal=${RUNTIME_DIR}/${runId}.journal.jsonl`,
    "green",
  );
  return out;
}

// ── 入口 ──────────────────────────────────────────
// Prompt example: 读一下 s16 的 code.py，把内容作为 changes 跑 review-changes workflow。
if (import.meta.main) {
  const mode = process.argv[2];
  const logger = createLogger(import.meta.dirname);

  if (mode === "demo" || mode === "resume") {
    // demo / resume 用确定性 runner：不需要 API key，事件流和 journal 可重复观察。
    const runtime = createWorkflowRuntime(import.meta.dirname, { logger });
    let resumeId: string | undefined;
    if (mode === "resume") {
      resumeId = readLastRun(runtime.store) ?? undefined;
      if (!resumeId) {
        print("nothing to resume; run `demo` first.", "yellow");
        process.exit(0);
      }
    }
    await runDemo(runtime, resumeId);
  } else {
    const client = createClient();
    const mcp = createMcpState();
    const skills = loadSkills(SKILLS_DIR, logger);
    const team = createTeamState(import.meta.dirname);
    const cron = createCronState(import.meta.dirname);
    const background = new BackgroundManager();
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    // 交互模式下 workflow 的子 agent 与宿主用同一个真实 client。
    const runtime = createWorkflowRuntime(import.meta.dirname, {
      logger,
      createRunner: () => new AnthropicAgentRunner(client, MODEL_ID),
    });

    logger.config({ model: MODEL_ID, tools: [WORKFLOW_TOOL] });
    print("s16: Workflow Runtime — 一次 tool_use，跑完一整套编排", "cyan");
    print("🔮 输入问题，回车发送。输入 q 退出。\n", "green");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on("SIGINT", () => {
      rl.close();
      process.exit(0);
    });
    const hooks = loadMcpHooks(logger, makeConfirm(rl, logger), mcp);
    const prompt = createPrompt(rl, "s16 >> ");
    const history: Anthropic.MessageParam[] = [];

    while (true) {
      let query: string;
      try {
        query = await prompt.ask();
      } catch {
        break;
      }
      const q = query.trim().toLowerCase();
      if (q === "" || q === "q" || q === "exit") break;
      logger.userInput(query);
      await hooks.trigger("UserPromptSubmit", query);
      history.push({ role: "user", content: query });

      try {
        printFinal(
          await agentLoop(history, {
            client,
            logger,
            hooks,
            skills,
            team,
            cron,
            mcp,
            background,
            memoryDir: MEMORY_DIR,
            sessionDir: import.meta.dirname,
            activeRequest: query,
            // s16 唯一的接入点：Workflow 叠在 s15 的内置 + MCP 工具之后。
            extraPool: workflowToolPool(runtime),
          }),
        );
      } catch (e) {
        printError(e);
      }
      print();
    }

    prompt.detach();
    rl.close();
  }
}

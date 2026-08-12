/**
 * s13_agent_teams/main.ts - Agent 团队
 *
 * 一个 Lead 加若干持久队友：共享任务板、文件邮箱、可选 worktree、类型化协议。
 *
 *     +------+  spawn(task_id)  +----------+  result  +------+
 *     | Lead | ---------------> |   WORK   | -------> | IDLE |
 *     +--+---+                  +----+-----+          +--+---+
 *        ^                           |                   |
 *        | team events               | tools             | wait
 *        |                           v                   v
 *     +--+-----------+          +----------+        +----------+
 *     | MessageBus   |          | Task cwd | <----- | Mailbox  |
 *     +--------------+          +----------+  claim +----------+
 *
 *     .tasks/       共享任务记录与依赖
 *     .mailboxes/   消息、结果与协议回复
 *     .worktrees/   可选的、绑定到任务的工作目录
 *
 * 相比 s10 的变化：
 *   工具层、hook 层、任务存储继续直接复用，不再内联：基础 dispatch 表复用 s03，
 *   hook 系统（loadHooks / HookSystem）复用 s04，TaskStore / canStart /
 *   incompleteDependencies / runCreateTask / getTask 与 tools / TOOL_SCHEMAS 复用 s10。
 *   s11 的后台任务与 s12 的 cron 不带进本章：它们不参与队友通信、任务认领和计划审批。
 *   本文件只新增团队这一层：
 *   + MessageBus：文件邮箱（.mailboxes/*.jsonl），读取即消费；消息带 type + metadata；
 *     waitForMessages 让 IDLE 队友等消息或超时
 *   + TeamState：bus + tasks + 队友状态 + assignment + 计划闸门 + pendingRequests，
 *     由 session 持有、跨轮复用（对齐 s10 的 TaskStore 注入风格）
 *   + 任务绑定的工作目录：Task.worktree 可选，claimTask 解析出 cwd 写进 assignment，
 *     队友的 bash / 文件工具都从 assignment 读目录；绑定损坏就认领失败，不回退仓库目录
 *   + createWorktree（Lead 工具）与 removeWorktree（宿主函数，不给模型）
 *   + owner 维度的 claimTask / completeTask：一个 owner 同时只能有一项进行中的任务
 *   + TeammateRuntime：持久队友的 WORK / IDLE 循环 + 空闲时扫描共享任务板认领
 *   + 类型化协议：shutdown 与 plan_approval 用 request_id 关联请求与回复；
 *     计划闸门在工具分发层拦住 bash / write_file / edit_file
 *   + 7 个 Lead 工具：spawn_teammate / list_teammates / send_message /
 *     request_shutdown / request_plan / review_plan / create_worktree
 *   + 入口改用事件队列：readline 行事件 + 250ms 轮询 Lead 收件箱共用一个队列
 *
 * TS 特有说明：
 *   - code.py 用守护线程跑队友，靠 task_lock / team_lock / fcntl 文件锁串行化；
 *     这里是单线程事件循环，claimTask 这类状态迁移在一个同步函数里跑完，天然互斥，
 *     所以不需要锁。跨进程共用同一份 .tasks/ 时仍需文件锁，教学版不做。
 *   - 守护线程 -> 游离的 async 循环；等待用 setTimeout(...).unref()，
 *     队友挂在 IDLE 时不会阻止进程退出（对应 daemon=True）。
 *   - Condition.wait -> MessageBus 内部的 waiter 集合：send 唤醒等待者，超时则自行退出。
 *   - 模块级全局（teammate_assignments / plan_gates / pending_requests 等）收进
 *     TeamState，入口用 createTeamState(import.meta.dirname) 落到自己的 session 目录，
 *     测试传临时目录做隔离（对齐 s10 的 tasksDir）。
 *   - Python 的 input() + select 轮询 -> readline 的 line 事件 + 250ms 轮询，
 *     共用一个事件队列，单消费者：agentLoop 跑着时新输入只排队，不会并发跑两轮。
 *
 * 基于 s10（任务系统）构建。Usage:
 *
 *     pnpm dev s13_agent_teams/main.ts
 */

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { createPrompt, print, printFinal } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
// 来自 s02：errMsg + Handlers 类型。
import { errMsg, type Handlers } from "../s02_tool_use/main";
// 来自 s03：拒绝名单与规则匹配（队友那侧不问用户，命中规则直接回权限错误）+ makeConfirm。
import { checkDenyList, checkRules, makeConfirm } from "../s03_permission/main";
// 来自 s04：hook 系统（装配 + 触发）与 Deps（client + logger + hooks）。
import { loadHooks, type Deps as S04Deps } from "../s04_hooks/main";
// 来自 s10：任务存储与依赖判定、两个纯展示型 handler、工具集与 schema 表。
import {
  canStart,
  getTask,
  incompleteDependencies,
  runCreateTask,
  TOOL_SCHEMAS as S10_TOOL_SCHEMAS,
  tools as s10Tools,
  type Task,
  TaskStore,
  tasksDirFor,
} from "../s10_task_system/main";

const WORKDIR = process.cwd();

// deps 与 s04 一致，另加跨轮的团队状态（任务存储挂在 TeamState 上）。
export type Deps = S04Deps & { team: TeamState };

// ═══════════════════════════════════════════════════════════
//  s13 新增：MessageBus —— 基于文件的邮箱
// ═══════════════════════════════════════════════════════════

// 邮箱目录名（对齐 s10 的 .tasks/）；具体目录由 mailboxDirFor 决定。
export const MAILBOX_DIR_NAME = ".mailboxes";

// <session>/.mailboxes/：入口传自己的 import.meta.dirname。
export function mailboxDirFor(sessionDir: string): string {
  return path.join(sessionDir, MAILBOX_DIR_NAME);
}

// agent 名字会被拼进邮箱文件名，先校验再拼路径。
const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// lead / agent 是运行时身份：lead 是协调者收件箱，agent 是 Lead 自己的任务 owner。
const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_PATTERN.test(name);
}

// 总线上的一条消息：ts 是秒级时间戳（对齐 Python 的 time.time()）。
// type 区分普通消息、result、idle_notification 与协议事件；
// metadata 携带 request_id / approve，让协议回复能关联回原始请求。
export type BusMessage = {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
};

// 基于文件的消息总线：每个 agent 一个 .jsonl 收件箱，读取是破坏性的
//（readFile + unlink，即读即消费），所以每个收件箱只能有一个消费者。
// 教学版不加文件锁；真实 CC 用 proper-lockfile 保证并发写安全。
export class MessageBus {
  // 挂在 waitForMessages 上的等待者，send 时全部唤醒。
  private waiters = new Set<() => void>();

  constructor(public mailboxDir: string) {
    fs.mkdirSync(mailboxDir, { recursive: true });
  }

  private inboxPath(agent: string): string {
    if (!isValidAgentName(agent)) {
      throw new Error(`Invalid mailbox recipient: ${agent}`);
    }
    return path.join(this.mailboxDir, `${agent}.jsonl`);
  }

  // 追加一条消息到收件人的 .jsonl，并唤醒所有等待者。
  send(
    from: string,
    to: string,
    content: string,
    type = "message",
    metadata: Record<string, unknown> = {},
  ): void {
    const msg: BusMessage = {
      from,
      to,
      content,
      type,
      ts: Date.now() / 1000,
      metadata,
    };
    fs.appendFileSync(this.inboxPath(to), `${JSON.stringify(msg)}\n`);
    for (const wake of [...this.waiters]) wake();
    print(
      `  [bus] ${from} -> ${to}: (${type}) ${content.slice(0, 50)}`,
      "gray",
    );
  }

  // 读取并清空收件箱（read + unlink，即读即消费）。
  readInbox(agent: string): BusMessage[] {
    const inbox = this.inboxPath(agent);
    if (!fs.existsSync(inbox)) return [];
    const msgs = fs
      .readFileSync(inbox, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BusMessage);
    fs.unlinkSync(inbox); // consume: read + delete
    return msgs;
  }

  // 非破坏性探测：收件箱是否有未读消息（轮询器用它判断是否唤醒，不消费邮箱）。
  peek(agent: string): boolean {
    const inbox = this.inboxPath(agent);
    return fs.existsSync(inbox) && fs.statSync(inbox).size > 0;
  }

  // 等到有消息或超时；超时返回空数组。定时器 unref，挂在这里不阻止进程退出。
  async waitForMessages(
    agent: string,
    timeoutMs: number,
  ): Promise<BusMessage[]> {
    if (!this.peek(agent)) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        timer = setTimeout(wake, timeoutMs);
        timer.unref();
        this.waiters.add(wake);
      });
    }
    return this.readInbox(agent);
  }
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：团队状态 —— code.py 的一堆模块级全局收进一个对象
// ═══════════════════════════════════════════════════════════

// 队友生命周期状态。
export type TeammateStatus =
  | "working"
  | "waiting_approval"
  | "idle"
  | "stopping";

// 计划闸门：required / pending / rejected 都会拦住修改型工具。
export type PlanGate =
  | "not_required"
  | "required"
  | "pending"
  | "approved"
  | "rejected";

// 一次协议往返的状态（关机、计划审批）。
export type ProtocolState = {
  requestId: string;
  type: "shutdown" | "plan_approval";
  sender: string;
  target: string;
  status: "pending" | "approved" | "rejected";
  payload: string;
  // 提交计划时队友的任务身份；审批回来时两者仍一致才生效。
  workVersion?: number;
  taskId?: string | null;
  createdAt: number;
};

// 一个 owner 当前的工作绑定：任务 ID + 解析出来的工作目录。
export type Assignment = { taskId: string; cwd: string };

// IDLE 队友两次扫描任务板之间的等待时长。
export const IDLE_SCAN_INTERVAL_MS = 2000;

// 团队运行时状态：由 session 持有、跨轮复用，测试各建各的做隔离。
export class TeamState {
  // 队友名 -> 生命周期状态。
  activeTeammates = new Map<string, TeammateStatus>();
  // owner -> assignment。一个 owner 同时只有一项工作，文件工具都从这里取 cwd。
  assignments = new Map<string, Assignment>();
  // owner -> 工作版本号：认领或释放任务都会 +1，让旧的计划审批失效。
  assignmentVersions = new Map<string, number>();
  planGates = new Map<string, PlanGate>();
  planRequestIds = new Map<string, string>();
  pendingRequests = new Map<string, ProtocolState>();

  constructor(
    public bus: MessageBus,
    public tasks: TaskStore,
    public worktreesDir: string,
    public idleScanMs = IDLE_SCAN_INTERVAL_MS,
  ) {}

  gateOf(owner: string): PlanGate {
    return this.planGates.get(owner) ?? "not_required";
  }
}

// 存放任务绑定 worktree 的目录名。
export const WORKTREES_DIR_NAME = ".worktrees";

export function worktreesDirFor(sessionDir: string): string {
  return path.join(sessionDir, WORKTREES_DIR_NAME);
}

// <session>/ 下的 .mailboxes/、.tasks/、.worktrees/ 组成一份团队状态。
export function createTeamState(sessionDir: string): TeamState {
  return new TeamState(
    new MessageBus(mailboxDirFor(sessionDir)),
    new TaskStore(tasksDirFor(sessionDir)),
    worktreesDirFor(sessionDir),
  );
}

// 任务多一个可选字段：绑定的 worktree 名（未绑定的任务用仓库目录）。
export type TeamTask = Task & { worktree?: string | null };

export function loadTeamTask(team: TeamState, taskId: string): TeamTask {
  return team.tasks.load(taskId) as TeamTask;
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：任务绑定的 worktree
// ═══════════════════════════════════════════════════════════

const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// worktree 名会被拼进路径和分支名，先校验再拼。
export function validateWorktreeName(name: string): string | null {
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    return (
      "worktree name must be 1-64 letters, digits, dots, underscores, " +
      "or dashes, and start with a letter or digit"
    );
  }
  if (name.includes("..")) return "worktree name cannot contain '..'";
  return null;
}

export function worktreeBranch(name: string): string {
  return `wt/${name}`;
}

function worktreePath(team: TeamState, name: string): string {
  const root = path.resolve(team.worktreesDir);
  const target = path.resolve(root, name);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`Worktree path escapes directory: ${name}`);
  }
  return target;
}

// 不走 shell，参数按数组传，输出（stdout + stderr）原样回给调用方。
export function runGit(
  args: string[],
  cwd = WORKDIR,
): { ok: boolean; output: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (r.error) return { ok: false, output: errMsg(r.error) };
  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return {
    ok: r.status === 0,
    output: (output || "(no output)").slice(0, 5000),
  };
}

// `git worktree list --porcelain` 的解析结果：绝对路径 -> 该条目的键值对。
function registeredWorktrees(): {
  entries: Map<string, Record<string, string>>;
  error: string | null;
} {
  const { ok, output } = runGit(["worktree", "list", "--porcelain"]);
  if (!ok) {
    return {
      entries: new Map(),
      error: `cannot read Git worktree registry: ${output}`,
    };
  }
  const entries = new Map<string, Record<string, string>>();
  let current: Record<string, string> = {};
  for (const line of [...output.split("\n"), ""]) {
    if (!line) {
      if (current.worktree)
        entries.set(path.resolve(current.worktree), current);
      current = {};
      continue;
    }
    const index = line.indexOf(" ");
    const key = index === -1 ? line : line.slice(0, index);
    current[key] = index === -1 ? "" : line.slice(index + 1);
  }
  return { entries, error: null };
}

// worktree 必须真实存在、已在 Git 注册、且挂在约定分支上，否则一律报错。
export function registeredWorktree(
  team: TeamState,
  name: string,
): { path: string | null; error: string | null } {
  let target: string;
  try {
    target = worktreePath(team, name);
  } catch (e) {
    return { path: null, error: errMsg(e) };
  }
  const { entries, error } = registeredWorktrees();
  if (error) return { path: null, error };
  const entry = entries.get(target);
  if (!entry)
    return {
      path: null,
      error: `worktree '${name}' is not registered with Git`,
    };
  if (!fs.existsSync(target)) {
    return { path: null, error: `worktree '${name}' is missing at ${target}` };
  }
  if (entry.branch !== `refs/heads/${worktreeBranch(name)}`) {
    return {
      path: null,
      error:
        `worktree '${name}' is not registered on expected branch ` +
        `'${worktreeBranch(name)}'`,
    };
  }
  return { path: target, error: null };
}

// 解析一个任务的工作目录：没绑定 worktree 就是仓库目录；绑定坏了就报错，
// 由调用方 fail closed，而不是悄悄回退到仓库目录。
export function taskWorktreeCwd(
  team: TeamState,
  task: TeamTask,
): { cwd: string; error: string | null } {
  if (!task.worktree) return { cwd: WORKDIR, error: null };
  const { path: resolved, error } = registeredWorktree(team, task.worktree);
  return { cwd: resolved ?? WORKDIR, error };
}

// 创建并绑定一个任务专属 worktree（Lead 工具）：先校验名字、任务、分支和注册表，
// 再建 checkout，最后才写任务绑定。
export function createWorktree(
  team: TeamState,
  name: string,
  taskId: string,
  logger: SessionLogger,
): string {
  const invalid = validateWorktreeName(name);
  if (invalid) return `Error: ${invalid}`;

  let target: string;
  let task: TeamTask;
  try {
    target = worktreePath(team, name);
    task = loadTeamTask(team, taskId);
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
  const branch = worktreeBranch(name);

  if (task.status !== "pending" || task.owner !== null) {
    return `Error: Task ${taskId} must be pending and unowned`;
  }
  if (task.worktree) {
    return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
  }
  const bound = (team.tasks.list() as TeamTask[]).some(
    (t) => t.id !== taskId && t.worktree === name,
  );
  if (bound)
    return `Error: Worktree '${name}' is already bound to another task`;
  if (fs.existsSync(target))
    return `Error: Worktree path already exists: ${target}`;

  const root = runGit(["rev-parse", "--show-toplevel"]);
  if (!root.ok || path.resolve(root.output) !== WORKDIR) {
    return "Error: Working directory must be the root of a Git repository";
  }
  const refFormat = runGit(["check-ref-format", "--branch", branch]);
  if (!refFormat.ok) {
    return `Error: Invalid worktree branch '${branch}': ${refFormat.output}`;
  }
  if (runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
    return `Error: Branch '${branch}' already exists`;
  }
  const registry = registeredWorktrees();
  if (registry.error) return `Error: ${registry.error}`;
  if (registry.entries.has(target)) {
    return `Error: Worktree path is already registered: ${target}`;
  }

  fs.mkdirSync(team.worktreesDir, { recursive: true });
  const added = runGit(["worktree", "add", "-b", branch, target, "HEAD"]);
  if (!added.ok) {
    // Git 失败但留下了 checkout / 注册项 / 分支时，如实报告残留，不替用户清理。
    const after = registeredWorktrees();
    const branchExists = runGit([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).ok;
    const artifacts: string[] = [];
    if (fs.existsSync(target)) artifacts.push(`checkout path '${target}'`);
    if (!after.error && after.entries.has(target))
      artifacts.push("registered Git worktree");
    if (branchExists) artifacts.push(`branch '${branch}'`);
    if (artifacts.length) {
      return (
        "Partial operation: git worktree add reported an error after leaving " +
        `${artifacts.join(", ")}. Task ${taskId} remains unbound and no Git data ` +
        `was deleted. Run \`git worktree list\`, inspect '${target}' and '${branch}', ` +
        "then keep or remove those artifacts manually after preserving any work. " +
        `Git error: ${added.output}`
      );
    }
    return `Git error: ${added.output}`;
  }

  try {
    task.worktree = name;
    team.tasks.save(task);
  } catch (e) {
    return (
      `Partial success: Worktree '${name}' was created at ${target} on branch ` +
      `'${branch}', but task binding failed: ${errMsg(e)}. Git data was retained ` +
      "for manual recovery."
    );
  }

  logger.console(`  [worktree] created: ${name} at ${target}`, "yellow");
  return `Worktree '${name}' created at ${target} for task ${taskId}`;
}

// 移除 checkout（宿主函数，不在模型工具里）：拒绝未完成的绑定、仍在使用的 lease
// 和未保存的改动；两条路径都保留 wt/<name> 分支。
export function removeWorktree(
  team: TeamState,
  name: string,
  discardChanges = false,
  logger: SessionLogger = noopConsole,
): string {
  const invalid = validateWorktreeName(name);
  if (invalid) return `Error: ${invalid}`;

  const { path: target, error } = registeredWorktree(team, name);
  if (error || !target) return `Error: ${error}`;

  const bound = (team.tasks.list() as TeamTask[]).filter(
    (t) => t.worktree === name,
  );
  if (!bound.length) return `Error: Worktree '${name}' is not bound to a task`;
  const active = bound.find((t) => t.status !== "completed");
  if (active) {
    return (
      `Error: Worktree '${name}' is bound to active task ${active.id}; ` +
      "complete it before removal"
    );
  }
  const leased = [...team.assignments.entries()]
    .filter(
      ([, assignment]) => path.resolve(assignment.cwd) === path.resolve(target),
    )
    .map(([owner]) => owner)
    .sort();
  if (leased.length) {
    return (
      `Error: Worktree '${name}' is still in use by ${leased.join(", ")}; ` +
      "wait for the turn to end"
    );
  }

  const status = runGit(["status", "--porcelain", "--ignored"], target);
  if (!status.ok)
    return `Error: Cannot verify worktree '${name}' status: ${status.output}`;
  if (status.output !== "(no output)" && !discardChanges) {
    const changed = status.output
      .split("\n")
      .filter((line) => line.trim()).length;
    return (
      `Error: Worktree '${name}' has ${changed} uncommitted change(s); ` +
      "preserve or discard them manually"
    );
  }

  const args = ["worktree", "remove"];
  if (discardChanges) args.push("--force");
  args.push(target);
  const removed = runGit(args);
  if (!removed.ok) return `Git error: ${removed.output}`;

  try {
    for (const task of bound) {
      task.worktree = null;
      team.tasks.save(task);
    }
  } catch (e) {
    return (
      `Partial success: Worktree '${name}' was removed and branch ` +
      `'${worktreeBranch(name)}' retained, but task unbinding failed: ${errMsg(e)}. ` +
      "Manual recovery is required."
    );
  }

  logger.console(`  [worktree] removed: ${name}; branch retained`, "yellow");
  return `Worktree '${name}' removed; branch '${worktreeBranch(name)}' retained`;
}

// removeWorktree 的默认 logger：宿主直接调用时不需要传 logger。
const noopConsole = { console() {} } as unknown as SessionLogger;

// ═══════════════════════════════════════════════════════════
//  s13 新增：owner 维度的认领 / 完成，以及 assignment 的工作目录
// ═══════════════════════════════════════════════════════════

// 认领或释放任务都会推进工作版本号，让上一次任务的计划审批失效；
// 明确要求过计划的队友会退回 required，而不是被清成 not_required。
export function advanceAssignmentVersion(team: TeamState, owner: string): void {
  team.assignmentVersions.set(
    owner,
    (team.assignmentVersions.get(owner) ?? 0) + 1,
  );
  const gate = team.planGates.get(owner);
  if (gate !== undefined && gate !== "not_required") {
    team.planGates.set(owner, "required");
  }
  team.planRequestIds.delete(owner);
}

function ownerInProgress(team: TeamState, owner: string): TeamTask | undefined {
  return (team.tasks.list() as TeamTask[]).find(
    (task) => task.status === "in_progress" && task.owner === owner,
  );
}

// 认领一项任务：状态、归属、依赖、worktree 绑定全部通过后，
// 才写 owner + in_progress，并把解析出的 cwd 记进 assignment。
export function claimTask(
  team: TeamState,
  taskId: string,
  owner: string,
  logger: SessionLogger,
): string {
  const task = loadTeamTask(team, taskId);
  if (task.status !== "pending")
    return `Task ${taskId} is ${task.status}, cannot claim`;
  if (task.owner) return `Task ${taskId} is already owned by ${task.owner}`;

  const assignment = team.assignments.get(owner);
  if (assignment) {
    return (
      `Owner ${owner} must finish the current work turn for ${assignment.taskId} ` +
      "before claiming another task"
    );
  }
  const current = ownerInProgress(team, owner);
  if (current) {
    return `Owner ${owner} must complete ${current.id} before claiming another task`;
  }
  const blocked = incompleteDependencies(team.tasks, task);
  if (blocked.length) return `Blocked by: [${blocked.join(", ")}]`;

  const { cwd, error } = taskWorktreeCwd(team, task);
  if (error) return `Cannot claim ${taskId}: ${error}`;

  task.owner = owner;
  task.status = "in_progress";
  team.tasks.save(task);
  team.assignments.set(owner, { taskId: task.id, cwd });
  advanceAssignmentVersion(team, owner);

  logger.console(
    `  [claim] ${task.subject} -> in_progress (owner: ${owner})`,
    "cyan",
  );
  return `Claimed ${task.id} (${task.subject})`;
}

// 完成一项任务：只有持有它的 owner 能完成，且计划闸门必须已经放行。
// 完成不立刻释放 assignment —— 本轮后续工具调用仍用同一个工作目录。
export function completeTask(
  team: TeamState,
  taskId: string,
  owner: string,
  logger: SessionLogger,
): string {
  const task = loadTeamTask(team, taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  if (task.owner !== owner) {
    return `Task ${taskId} is owned by ${task.owner}, not ${owner}; cannot complete`;
  }
  const gate = team.gateOf(owner);
  if (gate === "required" || gate === "pending" || gate === "rejected") {
    return `Task ${taskId} cannot complete while plan status is ${gate}`;
  }
  if (team.assignments.get(owner)?.taskId !== task.id) {
    const { cwd, error } = taskWorktreeCwd(team, task);
    if (error) return `Task ${taskId} cannot complete: ${error}`;
    team.assignments.set(owner, { taskId: task.id, cwd });
  }

  task.status = "completed";
  team.tasks.save(task);
  const unblocked = team.tasks
    .list()
    .filter(
      (t) =>
        t.status === "pending" &&
        t.blockedBy.length &&
        canStart(team.tasks, t.id),
    )
    .map((t) => t.subject);

  logger.console(`  [complete] ${task.subject}`, "green");
  let message = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) {
    message += `\nUnblocked: ${unblocked.join(", ")}`;
    logger.console(`  [unblocked] ${unblocked.join(", ")}`, "yellow");
  }
  return message;
}

// 当前 assignment 的工作目录。没有 assignment 的 owner 回退到仓库目录
//（Lead 就走这条路）；绑定失效则抛错，交给调用方转成工具错误。
export function assignmentCwd(team: TeamState, owner: string): string {
  let assignment = team.assignments.get(owner);
  const running = ownerInProgress(team, owner);
  if (running && assignment?.taskId !== running.id) {
    // 进程重启或换了任务：按持久化的 owner + worktree 绑定重建 lease。
    const { cwd, error } = taskWorktreeCwd(team, running);
    if (error) throw new Error(error);
    assignment = { taskId: running.id, cwd };
    team.assignments.set(owner, assignment);
  } else if (!assignment) {
    return WORKDIR;
  }

  const task = loadTeamTask(team, assignment.taskId);
  if (
    (task.status !== "in_progress" && task.status !== "completed") ||
    task.owner !== owner
  ) {
    throw new Error(`Assignment for ${owner} is no longer active`);
  }
  const { cwd, error } = taskWorktreeCwd(team, task);
  if (error) throw new Error(error);
  if (path.resolve(cwd) !== path.resolve(assignment.cwd)) {
    throw new Error(`Assignment cwd changed for task ${task.id}`);
  }
  return cwd;
}

// 模型轮次结束时才归还已完成任务的目录 lease。
export function releaseCompletedAssignment(
  team: TeamState,
  owner: string,
): boolean {
  const assignment = team.assignments.get(owner);
  if (!assignment) return false;
  const task = loadTeamTask(team, assignment.taskId);
  if (task.status !== "completed" || task.owner !== owner) return false;
  team.assignments.delete(owner);
  advanceAssignmentVersion(team, owner);
  if (team.planGates.has(owner)) team.planGates.set(owner, "not_required");
  return true;
}

// 队友退出时，把它没做完的任务放回任务板。
export function releaseTeammateAssignment(
  team: TeamState,
  owner: string,
): void {
  const task = ownerInProgress(team, owner);
  if (task) {
    task.status = "pending";
    task.owner = null;
    team.tasks.save(task);
  }
  team.assignments.delete(owner);
  advanceAssignmentVersion(team, owner);
  if (team.planGates.has(owner)) team.planGates.set(owner, "not_required");
}

// ── 空闲任务发现 ───────────────────────────────────────────

// 扫描出 ready 的候选任务：pending、无人认领、依赖已完成、worktree 绑定可用。
export function scanUnclaimedTasks(team: TeamState): TeamTask[] {
  return (team.tasks.list() as TeamTask[]).filter((task) => {
    if (task.status !== "pending" || task.owner !== null) return false;
    if (!canStart(team.tasks, task.id)) return false;
    return !taskWorktreeCwd(team, task).error;
  });
}

// 扫描只是某一刻的快照，所有权变更必须走 claimTask：候选可能已被别人抢走。
export function claimNextTask(
  team: TeamState,
  owner: string,
  logger: SessionLogger,
): TeamTask | null {
  if (team.assignments.get(owner) || ownerInProgress(team, owner)) return null;
  for (const task of scanUnclaimedTasks(team)) {
    if (claimTask(team, task.id, owner, logger).startsWith("Claimed ")) {
      return loadTeamTask(team, task.id);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：工作区工具 —— 目录由 assignment 决定
// ═══════════════════════════════════════════════════════════

// s02/s03 的文件工具都钉在 WORKDIR 上；worktree 要求换目录，
// 所以这里按 base 解析路径，并同样拦住越界。
function resolveIn(base: string, p: string): string {
  const resolved = path.resolve(base, p);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// cwd 解析器：Lead 用「有 assignment 就用它，否则仓库目录」，
// 队友用「必须先认领任务」。解析失败一律回错误文案，不静默换目录。
export type CwdResolver = () => { cwd?: string; error?: string };

export function makeWorkspaceHandlers(resolveCwd: CwdResolver): Handlers {
  const withCwd = (fn: (cwd: string) => string) => {
    const { cwd, error } = resolveCwd();
    if (error || !cwd) return error ?? "Error: no working directory";
    try {
      return fn(cwd);
    } catch (e) {
      return `Error: ${errMsg(e)}`;
    }
  };

  return {
    bash: ({ command }) =>
      withCwd((cwd) => {
        const r = spawnSync(command, {
          shell: true,
          cwd,
          encoding: "utf8",
          timeout: 120_000,
        });
        if (r.error) {
          const code = (r.error as NodeJS.ErrnoException).code;
          return code === "ETIMEDOUT"
            ? "Error: Timeout (120s)"
            : `Error: ${r.error.message}`;
        }
        const out = ((r.stdout ?? "") + (r.stderr ?? ""))
          .trim()
          .slice(0, 50_000);
        if (r.status)
          return `Error: command exited with status ${r.status}\n${out}`;
        return out || "(no output)";
      }),
    read_file: ({ path: p, limit }) =>
      withCwd((cwd) => {
        let lines = fs.readFileSync(resolveIn(cwd, p), "utf8").split("\n");
        if (limit && limit < lines.length) {
          lines = [
            ...lines.slice(0, limit),
            `... (${lines.length - limit} more lines)`,
          ];
        }
        return lines.join("\n");
      }),
    write_file: ({ path: p, content }) =>
      withCwd((cwd) => {
        const filePath = resolveIn(cwd, p);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
      }),
    edit_file: ({ path: p, old_text, new_text }) =>
      withCwd((cwd) => {
        const filePath = resolveIn(cwd, p);
        const text = fs.readFileSync(filePath, "utf8");
        const i = text.indexOf(old_text);
        if (i === -1) return `Error: text not found in ${p}`;
        if (text.indexOf(old_text, i + old_text.length) !== -1) {
          return `Error: Expected 1 occurrence, found more in ${p}`;
        }
        fs.writeFileSync(
          filePath,
          text.slice(0, i) + new_text + text.slice(i + old_text.length),
        );
        return `Edited ${p}`;
      }),
    glob: ({ pattern }) =>
      withCwd((cwd) => {
        const matches = fs
          .globSync(pattern, { cwd })
          .filter((m) => path.resolve(cwd, m).startsWith(cwd + path.sep))
          .slice(0, 200);
        return matches.length ? matches.join("\n") : "No files found";
      }),
  };
}

// Lead 侧：有 assignment 用 assignment 的目录，否则仓库目录。
// s15 的 Lead 也用这一份，导出复用而不是各写一遍。
export function leadCwdResolver(team: TeamState): CwdResolver {
  return () => {
    try {
      return { cwd: assignmentCwd(team, "agent") };
    } catch (e) {
      return { error: `Error: Invalid task assignment: ${errMsg(e)}` };
    }
  };
}

// 队友侧：没认领任务就不给工作区工具，避免它悄悄改仓库目录。
function teammateCwdResolver(team: TeamState, name: string): CwdResolver {
  return () => {
    if (!team.assignments.has(name)) {
      return { error: "Error: Claim a Task before using workspace tools." };
    }
    try {
      return { cwd: assignmentCwd(team, name) };
    } catch (e) {
      return { error: `Error: Invalid task assignment: ${errMsg(e)}` };
    }
  };
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：类型化协议（关机 / 计划审批）
// ═══════════════════════════════════════════════════════════

export function newRequestId(team: TeamState): string {
  while (true) {
    const requestId = `req_${randomInt(0, 1_000_000).toString().padStart(6, "0")}`;
    if (!team.pendingRequests.has(requestId)) return requestId;
  }
}

// 把一条协议回复对上一个 pending 请求：ID 关联、类型防错配、状态防重复生效。
export function matchResponse(
  team: TeamState,
  responseType: string,
  requestId: string,
  approve: boolean,
  fromAgent: string,
  toAgent: string,
  logger: SessionLogger,
): boolean {
  const state = team.pendingRequests.get(requestId);
  if (!state) {
    logger.console(`  [protocol] unknown request_id: ${requestId}`, "red");
    return false;
  }
  const expected =
    state.type === "shutdown" ? "shutdown_response" : "plan_approval_response";
  if (responseType !== expected) {
    logger.console(
      `  [protocol] expected ${expected}, got ${responseType}`,
      "red",
    );
    return false;
  }
  if (fromAgent !== state.target || toAgent !== state.sender) {
    logger.console(`  [protocol] ${requestId} responder mismatch`, "red");
    return false;
  }
  if (state.status !== "pending") {
    logger.console(`  [protocol] ${requestId} already ${state.status}`, "red");
    return false;
  }
  state.status = approve ? "approved" : "rejected";
  logger.console(`  [protocol] ${requestId} -> ${state.status}`, "magenta");
  return true;
}

// Lead 收件箱只有这一个消费者：先更新协议状态，再把事件交给模型。
export function consumeLeadInbox(
  team: TeamState,
  logger: SessionLogger,
): BusMessage[] {
  const msgs = team.bus.readInbox("lead");
  for (const msg of msgs) {
    const requestId = String(msg.metadata?.request_id ?? "");
    if (requestId && msg.type.endsWith("_response")) {
      matchResponse(
        team,
        msg.type,
        requestId,
        Boolean(msg.metadata?.approve),
        msg.from,
        msg.to,
        logger,
      );
    }
  }
  return msgs;
}

export function formatTeamEvents(msgs: BusMessage[]): string {
  const lines = msgs.map((msg) => {
    const requestId = msg.metadata?.request_id;
    const suffix = requestId ? ` request_id=${requestId}` : "";
    return `[${msg.type}${suffix}] ${msg.from}: ${msg.content}`;
  });
  return `[Team events]\n${lines.join("\n")}`;
}

// 队友当前的任务身份：工作版本号 + 任务 ID，用来判定审批是否还对得上。
function currentWorkIdentity(
  team: TeamState,
  owner: string,
): { workVersion: number; taskId: string | null } {
  return {
    workVersion: team.assignmentVersions.get(owner) ?? 0,
    taskId: team.assignments.get(owner)?.taskId ?? null,
  };
}

// 队友提交计划：记录提交时的任务身份，闸门转 pending，然后等 Lead 决定。
export function submitPlan(
  team: TeamState,
  fromName: string,
  plan: string,
): string {
  if (team.gateOf(fromName) === "pending")
    return "A plan is already waiting for review.";
  const { workVersion, taskId } = currentWorkIdentity(team, fromName);
  const requestId = newRequestId(team);
  team.pendingRequests.set(requestId, {
    requestId,
    type: "plan_approval",
    sender: fromName,
    target: "lead",
    status: "pending",
    payload: plan,
    workVersion,
    taskId,
    createdAt: Date.now() / 1000,
  });
  team.planGates.set(fromName, "pending");
  team.planRequestIds.set(fromName, requestId);
  team.activeTeammates.set(fromName, "waiting_approval");
  team.bus.send(fromName, "lead", plan, "plan_approval_request", {
    request_id: requestId,
  });
  return `Plan submitted (${requestId}). Wait for Lead's decision.`;
}

// 只接受「Lead 针对本队友当前计划」的这一条回复；任务或版本变了就忽略。
export function applyPlanResponse(
  team: TeamState,
  name: string,
  msg: BusMessage,
): { applied: boolean; notice: string } {
  const requestId = String(msg.metadata?.request_id ?? "");
  const { workVersion, taskId } = currentWorkIdentity(team, name);
  const state = team.pendingRequests.get(requestId);
  const valid =
    msg.from === "lead" &&
    msg.to === name &&
    requestId === team.planRequestIds.get(name) &&
    state !== undefined &&
    state.type === "plan_approval" &&
    state.sender === name &&
    state.target === "lead" &&
    state.workVersion === workVersion &&
    (state.taskId ?? null) === taskId &&
    (state.status === "approved" || state.status === "rejected") &&
    Boolean(msg.metadata?.approve) === (state.status === "approved");
  if (!valid || !state) {
    return {
      applied: false,
      notice: "[Ignored plan response: request mismatch]",
    };
  }
  team.planGates.set(name, state.status);
  team.activeTeammates.set(name, "working");
  team.planRequestIds.delete(name);
  return { applied: true, notice: `[Plan ${state.status}] ${msg.content}` };
}

// 只接受「Lead 发给本队友、且仍 pending」的关机请求。
export function applyShutdownRequest(
  team: TeamState,
  name: string,
  msg: BusMessage,
): { accepted: boolean; notice: string } {
  const requestId = String(msg.metadata?.request_id ?? "");
  const state = team.pendingRequests.get(requestId);
  const valid =
    msg.from === "lead" &&
    msg.to === name &&
    state !== undefined &&
    state.type === "shutdown" &&
    state.sender === "lead" &&
    state.target === name &&
    state.status === "pending" &&
    team.activeTeammates.get(name) !== "stopping";
  if (!valid) {
    return {
      accepted: false,
      notice: "[Ignored shutdown request: request mismatch]",
    };
  }
  team.activeTeammates.set(name, "stopping");
  return { accepted: true, notice: requestId };
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：队友运行时（WORK / IDLE）
// ═══════════════════════════════════════════════════════════

// 计划闸门拦住的修改型工具。
const GATED_TOOLS = new Set(["bash", "write_file", "edit_file"]);

// 队友的工具分发：先过计划闸门，再过权限检查（队友不读终端，命中规则就回错误
// 让 Lead 和用户处理），最后才查表执行。
export function runTeammateTool(
  team: TeamState,
  name: string,
  block: Anthropic.ToolUseBlock,
  handlers: Handlers,
  logger: SessionLogger,
): string {
  const gate = team.gateOf(name);
  if (GATED_TOOLS.has(block.name)) {
    if (gate !== "approved" && gate !== "not_required") {
      return (
        `Blocked: plan status is ${gate}. Submit or revise the plan and wait ` +
        "for approval before changing the workspace."
      );
    }
    const input = block.input as any;
    if (block.name === "bash") {
      const denied = checkDenyList(input.command ?? "");
      if (denied) return `Permission denied by deny list: ${denied}`;
    }
    if (checkRules(block.name, input)) {
      return "Permission required: ask Lead to run this command.";
    }
  }

  const handler = handlers[block.name];
  const schema = TOOL_SCHEMAS[block.name];
  if (!handler || !schema) return `Unknown tool: ${block.name}`;
  let output: string;
  try {
    output = handler(schema.parse(block.input));
  } catch (e) {
    output = `Error: ${errMsg(e)}`;
  }
  logger.toolResult(block.name, output);
  return output;
}

// 响应里的第一段正文（没有正文就是空串）；textOf 会为空回复补占位文案，
// 这里要区分「真有小结」和「什么都没说」，所以自己取。
function assistantText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

// 一个持久队友：自己的系统提示词、messages、工具和当前任务，
// 在 WORK 和 IDLE 之间切换，直到收到关机请求或出错。
export class TeammateRuntime {
  readonly system: string;
  readonly messages: Anthropic.MessageParam[];
  readonly handlers: Handlers;
  private logger: SessionLogger;

  constructor(
    private team: TeamState,
    private client: ModelClient,
    logger: SessionLogger,
    readonly name: string,
    role: string,
    prompt: string,
    taskId: string | null,
    requirePlan: boolean,
  ) {
    this.logger = logger.child(name);
    this.system =
      `You are '${name}', a ${role}. Use tools to complete the assigned Task, ` +
      "then call complete_task and report a concise result. " +
      "If the first user message contains [Assigned task], that Task is already " +
      "claimed; do not call claim_task for it again. " +
      "When asked for a plan, call submit_plan and wait for approval before bash " +
      "or file changes. File and shell tools use the Task's working directory; " +
      "that directory is not a sandbox. The runtime delivers your final text to " +
      "Lead. Use send_message only for intermediate coordination, and address the " +
      "coordinator as 'lead'.";

    let first = prompt;
    if (taskId) {
      const task = loadTeamTask(team, taskId);
      first +=
        `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\n` +
        `Work directory: ${assignmentCwd(team, name)}`;
    }
    if (requirePlan) {
      first +=
        "\n\n[Plan required] Submit a plan and wait for Lead approval before " +
        "changing files or using bash.";
    }
    this.messages = [{ role: "user", content: first }];

    this.handlers = {
      ...makeWorkspaceHandlers(teammateCwdResolver(team, name)),
      send_message: ({ to, content }) => {
        if (to !== "lead" && !team.activeTeammates.has(to))
          return `Agent '${to}' is not active`;
        team.bus.send(name, to, content);
        return `Sent to ${to}`;
      },
      submit_plan: ({ plan }) => submitPlan(team, name, plan),
      list_tasks: () => runListTasks(team),
      claim_task: ({ task_id }) => claimTask(team, task_id, name, this.logger),
      complete_task: ({ task_id }) =>
        completeTask(team, task_id, name, this.logger),
    };
  }

  // 消费收件箱：关机请求返回 true，其余内容拼成一条 user 消息。
  handleInbox(inbox: BusMessage[]): boolean {
    const workMessages: string[] = [];
    for (const msg of inbox) {
      if (msg.type === "shutdown_request") {
        const { accepted, notice } = applyShutdownRequest(
          this.team,
          this.name,
          msg,
        );
        if (!accepted) {
          workMessages.push(notice);
          continue;
        }
        this.team.bus.send(
          this.name,
          "lead",
          "Shutdown acknowledged.",
          "shutdown_response",
          {
            request_id: notice,
            approve: true,
          },
        );
        return true;
      }
      if (msg.type === "plan_approval_response") {
        workMessages.push(applyPlanResponse(this.team, this.name, msg).notice);
        continue;
      }
      if (msg.type === "plan_request") {
        workMessages.push(`[Plan required] ${msg.content}`);
        continue;
      }
      workMessages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (workMessages.length) {
      this.messages.push({ role: "user", content: workMessages.join("\n") });
    }
    return false;
  }

  // 跑一轮模型调用：continue（还有工具要跑）/ idle（本轮说完了）/ stop。
  async work(): Promise<"continue" | "idle" | "stop"> {
    if (this.handleInbox(this.team.bus.readInbox(this.name))) return "stop";
    this.team.activeTeammates.set(this.name, "working");

    this.logger.request(this.messages, true);
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: MODEL_ID,
        system: this.system,
        messages: this.messages,
        tools: TEAMMATE_TOOLS,
        max_tokens: 8000,
      });
    } catch (e) {
      this.logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      this.team.bus.send(this.name, "lead", `${name}: ${errMsg(e)}`, "error");
      return "stop";
    }
    this.logger.response(response);
    this.messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: runTeammateTool(
            this.team,
            this.name,
            block,
            this.handlers,
            this.logger,
          ),
        });
      }
      this.messages.push({ role: "user", content: results });
      return "continue";
    }

    // 结果和 IDLE 是两个事件：一个回答「产出了什么」，一个回答「还能不能接活」。
    const summary = assistantText(response);
    const gate = this.team.gateOf(this.name);
    if (gate !== "pending" && summary) {
      this.team.bus.send(this.name, "lead", summary, "result");
    }
    if (gate === "pending") {
      this.team.activeTeammates.set(this.name, "waiting_approval");
    } else {
      releaseCompletedAssignment(this.team, this.name);
      this.team.activeTeammates.set(this.name, "idle");
      this.team.bus.send(
        this.name,
        "lead",
        "Waiting for more work.",
        "idle_notification",
      );
    }
    return "idle";
  }

  // IDLE：先等消息，没消息再扫任务板。关机和 Lead 的直接指令优先于自己找活。
  async waitForWork(): Promise<boolean> {
    while (true) {
      const inbox = await this.team.bus.waitForMessages(
        this.name,
        this.team.idleScanMs,
      );
      if (inbox.length) {
        const before = this.messages.length;
        if (this.handleInbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }

      const task = claimNextTask(this.team, this.name, this.logger);
      if (!task) continue;
      this.messages.push({
        role: "user",
        content:
          `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\n` +
          `Work directory: ${assignmentCwd(this.team, this.name)}`,
      });
      this.logger.console(
        `  [idle] ${this.name} claimed ${task.id}: ${task.subject}`,
        "magenta",
      );
      return true;
    }
  }

  async run(): Promise<void> {
    try {
      let state: "continue" | "idle" | "stop" = "continue";
      while (state !== "stop") {
        if (state === "idle" && !(await this.waitForWork())) break;
        state = await this.work();
      }
    } catch (e) {
      this.team.bus.send(this.name, "lead", `${errMsg(e)}`, "error");
    } finally {
      // 没做完的任务放回任务板，注册项一律清干净。
      try {
        releaseTeammateAssignment(this.team, this.name);
      } catch (e) {
        this.team.bus.send(
          this.name,
          "lead",
          `Assignment cleanup failed: ${errMsg(e)}`,
          "error",
        );
      }
      this.team.activeTeammates.delete(this.name);
      this.team.planGates.delete(this.name);
      this.team.planRequestIds.delete(this.name);
      this.logger.console(`  [teammate] ${this.name} finished`, "magenta");
    }
  }
}

// 先认领初始任务，再把队友起成一个游离的 async 循环（守护线程的 TS 版）。
// 认领失败就不启动队友，避免出现一个没有工作目录的空转队友。
export function spawnTeammateThread(
  team: TeamState,
  client: ModelClient,
  logger: SessionLogger,
  name: string,
  role: string,
  prompt: string,
  taskId: string | null = null,
  requirePlan = false,
): string {
  if (!isValidAgentName(name)) {
    return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
  }
  if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
    return `Invalid teammate name: '${name}' is reserved by the runtime`;
  }
  for (const existing of team.activeTeammates.keys()) {
    if (existing.toLowerCase() === name.toLowerCase()) {
      return `Teammate '${name}' already exists`;
    }
  }

  team.activeTeammates.set(name, "working");
  team.planGates.set(name, requirePlan ? "required" : "not_required");
  team.assignmentVersions.set(name, 0);

  if (taskId) {
    let claimed: string;
    try {
      claimed = claimTask(team, taskId, name, logger);
    } catch (e) {
      claimed = `Error: ${errMsg(e)}`;
    }
    if (!claimed.startsWith("Claimed ")) {
      team.activeTeammates.delete(name);
      team.planGates.delete(name);
      team.assignmentVersions.delete(name);
      return `Cannot spawn teammate '${name}': ${claimed}`;
    }
  }

  const runtime = new TeammateRuntime(
    team,
    client,
    logger,
    name,
    role,
    prompt,
    taskId,
    requirePlan,
  );
  void runtime.run(); // 游离执行 —— 与 Lead 的循环并发
  logger.console(`  [teammate] ${name} spawned as ${role}`, "magenta");
  const assigned = taskId ? ` for ${taskId}` : " without an initial Task";
  return (
    `Teammate '${name}' spawned as ${role}${assigned}. ` +
    "End this turn; the runtime will deliver its events."
  );
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：Lead 侧的任务与团队 handler
// ═══════════════════════════════════════════════════════════

// s10 的列表渲染加一列 worktree：任务用哪个目录，看列表就知道。
export function runListTasks(team: TeamState): string {
  const all = team.tasks.list() as TeamTask[];
  if (!all.length) return "No tasks. Use create_task to add some.";
  const markers: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };
  return all
    .map((t) => {
      const deps = t.blockedBy.length
        ? ` (blockedBy: ${t.blockedBy.join(", ")})`
        : "";
      const owner = t.owner ? ` [${t.owner}]` : "";
      const worktree = t.worktree ? ` (worktree: ${t.worktree})` : "";
      return `  ${markers[t.status] ?? "[?]"} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}${worktree}`;
    })
    .join("\n");
}

// Lead 的任务 handler：owner 固定是运行时身份 agent。
export function makeLeadTaskHandlers(
  team: TeamState,
  logger: SessionLogger,
): Handlers {
  return {
    create_task: ({ subject, description, blockedBy }) =>
      runCreateTask(team.tasks, subject, description ?? "", blockedBy, logger),
    list_tasks: () => runListTasks(team),
    get_task: ({ task_id }) => getTask(team.tasks, task_id),
    claim_task: ({ task_id }) => claimTask(team, task_id, "agent", logger),
    complete_task: ({ task_id }) =>
      completeTask(team, task_id, "agent", logger),
  };
}

// 团队 handler 需要 team 状态 + client（派生队友）+ logger，用工厂闭包捕获。
export function makeTeamHandlers(
  team: TeamState,
  client: ModelClient,
  logger: SessionLogger,
): Handlers {
  return {
    spawn_teammate: ({ name, role, prompt, task_id, require_plan }) =>
      spawnTeammateThread(
        team,
        client,
        logger,
        name,
        role,
        prompt,
        task_id ?? null,
        require_plan ?? false,
      ),
    list_teammates: () => {
      if (!team.activeTeammates.size) return "No active teammates.";
      return [...team.activeTeammates.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, status]) => `${name}: ${status}`)
        .join("\n");
    },
    send_message: ({ to, content }) => {
      if (!team.activeTeammates.has(to))
        return `Teammate '${to}' is not active`;
      team.bus.send("lead", to, content);
      return `Sent to ${to}`;
    },
    request_shutdown: ({ teammate }) => {
      if (!team.activeTeammates.has(teammate))
        return `Teammate '${teammate}' is not active`;
      const requestId = newRequestId(team);
      team.pendingRequests.set(requestId, {
        requestId,
        type: "shutdown",
        sender: "lead",
        target: teammate,
        status: "pending",
        payload: "",
        createdAt: Date.now() / 1000,
      });
      team.bus.send(
        "lead",
        teammate,
        "Finish the current step and shut down.",
        "shutdown_request",
        { request_id: requestId },
      );
      return `Shutdown requested from ${teammate} (${requestId})`;
    },
    request_plan: ({ teammate, task }) => {
      if (!team.activeTeammates.has(teammate))
        return `Teammate '${teammate}' is not active`;
      team.planGates.set(teammate, "required");
      team.bus.send("lead", teammate, task, "plan_request");
      return `Plan requested from ${teammate}`;
    },
    review_plan: ({ request_id, approve, feedback }) => {
      const state = team.pendingRequests.get(request_id);
      if (!state) return `Request ${request_id} not found`;
      if (state.type !== "plan_approval")
        return `Request ${request_id} is not a plan`;
      if (state.status !== "pending")
        return `Request ${request_id} already ${state.status}`;
      const { workVersion, taskId } = currentWorkIdentity(team, state.sender);
      if (
        state.workVersion !== workVersion ||
        (state.taskId ?? null) !== taskId
      ) {
        return `Request ${request_id} belongs to an earlier assignment`;
      }
      if (team.planRequestIds.get(state.sender) !== request_id) {
        return `Request ${request_id} is not the current plan`;
      }
      state.status = approve ? "approved" : "rejected";
      const content =
        feedback ||
        (approve ? "Plan approved." : "Revise the plan and submit it again.");
      team.bus.send("lead", state.sender, content, "plan_approval_response", {
        request_id,
        approve,
      });
      return `Plan ${state.status} (${request_id})`;
    },
    create_worktree: ({ name, task_id }) =>
      createWorktree(team, name, task_id, logger),
  };
}

// ═══════════════════════════════════════════════════════════
//  s13 新增：团队工具定义，叠加到 s10 的工具集之上
// ═══════════════════════════════════════════════════════════

const spawnTeammateSchema = z.object({
  name: z.string().regex(AGENT_NAME_PATTERN),
  role: z.string(),
  prompt: z.string(),
  task_id: z.string().optional(),
  require_plan: z.boolean().optional(),
});
const listTeammatesSchema = z.object({});
const sendMessageSchema = z.object({ to: z.string(), content: z.string() });
const requestShutdownSchema = z.object({ teammate: z.string() });
const requestPlanSchema = z.object({ teammate: z.string(), task: z.string() });
const reviewPlanSchema = z.object({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});
const createWorktreeSchema = z.object({
  name: z.string().regex(WORKTREE_NAME_PATTERN),
  task_id: z.string(),
});
const submitPlanSchema = z.object({ plan: z.string() });

const teamTools: Anthropic.Tool[] = [
  zodTool(
    "spawn_teammate",
    "Spawn a persistent teammate.",
    spawnTeammateSchema,
  ),
  zodTool("list_teammates", "List active teammates.", listTeammatesSchema),
  zodTool("send_message", "Message a teammate.", sendMessageSchema),
  zodTool(
    "request_shutdown",
    "Ask a teammate to shut down.",
    requestShutdownSchema,
  ),
  zodTool(
    "request_plan",
    "Require a teammate plan before workspace changes.",
    requestPlanSchema,
  ),
  zodTool("review_plan", "Approve or reject a plan.", reviewPlanSchema),
  zodTool(
    "create_worktree",
    "Create and bind a task worktree.",
    createWorktreeSchema,
  ),
];

// Lead 工具集：s10 的（基础 + 任务）再加团队工具。
// check_inbox 不是模型工具 —— 消息的到达与消费属于运行时，模型只处理已投递的事件。
export const tools: Anthropic.Tool[] = [...s10Tools, ...teamTools];

// 队友工具集：基础工具 + 三个任务工具 + send_message + submit_plan。
// 队友不能创建任务、不能派生队友、也不能创建或移除 worktree。
const TEAMMATE_TOOL_NAMES = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "list_tasks",
  "claim_task",
  "complete_task",
]);

export const TEAMMATE_TOOLS: Anthropic.Tool[] = [
  ...s10Tools.filter((tool) => TEAMMATE_TOOL_NAMES.has(tool.name)),
  zodTool(
    "send_message",
    "Send an intermediate message to 'lead' or an active teammate.",
    sendMessageSchema,
  ),
  zodTool(
    "submit_plan",
    "Submit a work plan for Lead approval.",
    submitPlanSchema,
  ),
];

// schema 表覆盖 Lead 与队友两侧的全部工具名。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S10_TOOL_SCHEMAS,
  spawn_teammate: spawnTeammateSchema,
  list_teammates: listTeammatesSchema,
  send_message: sendMessageSchema,
  request_shutdown: requestShutdownSchema,
  request_plan: requestPlanSchema,
  review_plan: reviewPlanSchema,
  create_worktree: createWorktreeSchema,
  submit_plan: submitPlanSchema,
};

// ═══════════════════════════════════════════════════════════
//  系统提示词 —— 团队边界写进 prompt
// ═══════════════════════════════════════════════════════════

export const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools:
    "Available tools: bash, read_file, write_file, edit_file, glob, get_task, " +
    "create_task, list_tasks, claim_task, complete_task, spawn_teammate, " +
    "list_teammates, send_message, request_shutdown, request_plan, review_plan, " +
    "create_worktree.",
  teams:
    "When parallel work would help, first propose a small team with clear " +
    "responsibilities and wait for the user's confirmation. Do not call " +
    "spawn_teammate before the user confirms. After confirmation, delegate " +
    "independent work by creating a Task for each parallel change. Pass task_id " +
    "to spawn_teammate when assigning ready work, then create a task-bound " +
    "worktree only when a separate working directory would prevent conflicting " +
    "edits. A teammate must complete its current Task before claiming another. " +
    "A worktree changes tool default cwd only; it is not a sandbox. Worktree " +
    "removal stays with the host or user. After spawning a teammate, end the " +
    "current turn instead of polling its status; the runtime will deliver team " +
    "events and wake the Lead. React to those events, and shut teammates down " +
    "when coordination is complete.",
  workspace: `Working directory: ${WORKDIR}`,
};

export const SYSTEM = Object.values(PROMPT_SECTIONS).join("\n\n");

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 结构同 s10，dispatch 表换成「按 assignment 取 cwd」的版本
// ═══════════════════════════════════════════════════════════

// 查表 + schema 校验，异常收敛成错误文本回给模型。
export function callTool(
  block: Anthropic.ToolUseBlock,
  handlers: Handlers,
): string {
  const handler = handlers[block.name];
  const schema = TOOL_SCHEMAS[block.name];
  if (!handler || !schema) return `Unknown: ${block.name}`;
  try {
    return handler(schema.parse(block.input));
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks, team } = deps;
  const handlers: Handlers = {
    ...makeWorkspaceHandlers(leadCwdResolver(team)),
    ...makeLeadTaskHandlers(team, logger),
    ...makeTeamHandlers(team, client, logger),
  };

  while (true) {
    logger.section(
      "TEAM STATE",
      `activeTeammates: ${JSON.stringify([...team.activeTeammates])}` +
        `\nplanGates: ${JSON.stringify([...team.planGates])}` +
        `\nassignments: ${JSON.stringify([...team.assignments])}`,
    );

    logger.request(messages, true);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        system: SYSTEM,
        messages,
        tools,
        max_tokens: 8000,
      });
    } catch (e) {
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      releaseCompletedAssignment(team, "agent");
      await hooks.trigger("Stop", messages);
      return errText;
    }
    logger.response(response);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // 轮次结束才归还已完成任务的目录 lease。
      releaseCompletedAssignment(team, "agent");
      await hooks.trigger("Stop", messages);
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;
      const blocked = await hooks.trigger("PreToolUse", block);
      const output = blocked ?? callTool(block, handlers);
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
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, system: SYSTEM, tools });

  print("s13: Agent Teams — 持久队友 + 共享任务板 + 协作协议", "cyan");
  print("🔮 输入问题，回车发送。输入 q 退出。\n", "green");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const hooks = loadHooks(logger, makeConfirm(rl, logger));
  const history: Anthropic.MessageParam[] = [];
  // 团队状态（邮箱 + 任务板 + 队友注册表）跨轮复用，落在 s13 自己的 session 目录。
  const team = createTeamState(import.meta.dirname);

  // 两种唤醒来源：用户输入一行 / Lead 收件箱来了团队事件（stdin 关闭则退出）。
  type AgentEvent = ["quit" | "user" | "wake", string | null];
  // 事件队列：多个生产者（line 事件、close、250ms 轮询）写入，主循环单点消费。
  const events: AgentEvent[] = [];
  let eventWaiter: (() => void) | null = null;

  function pushEvent(kind: AgentEvent[0], payload: string | null): void {
    events.push([kind, payload]);
    // 主循环正跑 agentLoop（没在等）时 eventWaiter 为 null，事件只留在队列里排队。
    if (eventWaiter) {
      eventWaiter();
      eventWaiter = null;
    }
  }

  async function nextEvent(): Promise<AgentEvent> {
    while (!events.length) {
      await new Promise<void>((resolve) => {
        eventWaiter = resolve;
      });
    }
    const event = events.shift();
    if (!event) throw new Error("unreachable: events non-empty after wait");
    return event;
  }

  // 提示符常驻屏幕底部：队友 / wake / 工具的输出都从它上方流过。
  const prompt = createPrompt(rl, "s13 >> ");
  rl.on("line", (line) => {
    pushEvent("user", line);
    prompt.show();
  });
  rl.on("close", () => pushEvent("quit", null)); // stdin 关闭（Ctrl+D）
  prompt.show();

  const poller = setInterval(() => {
    if (team.bus.peek("lead")) pushEvent("wake", null);
  }, 250);
  poller.unref();

  let hadTeammates = false;
  while (true) {
    const [kind, payload] = await nextEvent();
    if (kind === "quit") break;
    if (kind === "user") {
      const q = (payload ?? "").trim().toLowerCase();
      if (q === "" || q === "q" || q === "exit") break;
      logger.userInput(payload ?? "");
      await hooks.trigger("UserPromptSubmit", payload ?? "");
      history.push({ role: "user", content: payload ?? "" });
    } else {
      // "wake"：先消费收件箱并更新协议状态，再把团队事件注入本轮。
      const inbox = consumeLeadInbox(team, logger);
      if (!inbox.length) continue; // 已被更早的 wake 排空 —— 本次空转
      history.push({ role: "user", content: formatTeamEvents(inbox) });
      logger.console(
        `\n[wake: ${inbox.length} team event(s) -> new turn]`,
        "yellow",
      );
    }

    printFinal(await agentLoop(history, { client, logger, hooks, team }));

    if (team.activeTeammates.size) {
      hadTeammates = true;
    } else if (hadTeammates && !team.bus.peek("lead")) {
      print("[all teammates shut down]", "magenta");
      hadTeammates = false;
    }
    print();
  }
  prompt.hide();
  prompt.detach();
  rl.close();
}

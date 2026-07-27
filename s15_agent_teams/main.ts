/**
 * s15_agent_teams/main.ts - Agent 团队
 *
 * MessageBus（基于文件的邮箱）+ 游离的队友异步循环 + 收件箱注入。
 *
 * 相比 s14 的变化：
 *   工具层、任务系统、后台任务、cron 调度、prompt 组装继续直接复用，不再内联：
 *     基础工具 handler 复用 s03，任务系统（makeTaskHandlers）复用 s12，
 *     后台任务（BackgroundState / shouldRunBackground / startBackgroundTask /
 *     collectBackgroundResults）复用 s13，cron 调度层（CronState /
 *     startCronScheduler / consumeCronQueue / makeCronHandlers / tools /
 *     TOOL_SCHEMAS）复用 s14，getSystemPrompt / Context 复用 s12 / s10，
 *     MEMORY_INDEX 复用 s09。s11 的错误恢复在此照旧省略。
 *   本文件只新增 agent 团队这一层：
 *   + MessageBus：基于文件的邮箱（.mailboxes/*.jsonl），读取即消费（read + unlink）
 *   + TeamState：bus + activeTeammates，由 session 持有、跨轮复用（对齐 s14 的 CronState）
 *   + spawnTeammateThread：把队友创建为一个游离的异步循环（守护线程的 TS 版）
 *     队友跑自己的简化 agent 循环（bash / read / write / send_message，最多 10 轮）
 *   + makeTeamHandlers + 3 个新工具：spawn_teammate / send_message / check_inbox
 *   + updateContext override：enabled_tools 再补上 3 个团队工具
 *   + 入口改用事件队列：readline 循环 + 1s 轮询（收件箱 / 后台 / cron）共用一个队列
 *
 * ASCII 流程：
 *   Lead: cronQueue → messages → prompt → LLM → TOOLS ────→ loop
 *                 ↑                     ↓                        |
 *                 └── inbox ← MessageBus ← teammate.send_message ←┘
 *   Teammate: inbox → LLM → bash/read/write/send → loop（最多 10 轮）
 *
 * TS 特有说明：
 *   - Python 用 input() 线程 + 收件箱轮询线程共同喂给一个事件队列；这里用一个
 *     异步 readline 循环 + 1s 轮询推送共用同一个队列（单线程事件循环，无需锁）。
 *   - 游离的 Promise 代替守护线程；队友的日志走 logger.child(name) 子 scope，
 *     与 Lead 的日志区分开。
 *   - MessageBus 教学版不加文件锁（真实 CC 用 proper-lockfile 保证并发写安全）。
 *   - MessageBus 的 mailboxDir、TeamState 的 bus 可注入，测试传临时目录做隔离
 *     （对齐 s14 的 durablePath / s12 的 tasksDir）。
 *
 * Usage:
 *     pnpm dev s15_agent_teams/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
import { errMsg, type Handlers } from "../s02_tool_use/main";
// 来自 s03：基础 dispatch 表（队友的 bash/read/write 直接借这里的 handler）。
import { TOOL_HANDLERS as BASE_TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：记忆索引路径。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：只借 Context 类型。
import type { Context } from "../s10_system_prompt/main";
// 来自 s12：prompt 组装、任务工具工厂、memory/workspace 的 context 推导。
import {
  getSystemPrompt,
  makeTaskHandlers,
  tasksDirFor,
  updateContext as taskUpdateContext,
} from "../s12_task_system/main";
// 来自 s13：后台任务层。
import {
  BackgroundState,
  collectBackgroundResults,
  shouldRunBackground,
  startBackgroundTask,
} from "../s13_background_tasks/main";
// 来自 s14：cron 调度层（tools / TOOL_SCHEMAS 已是「基础 + 任务 + 后台 bash + cron」
// 的合并）。s15 在其上再叠加团队工具；Deps（client + logger + memoryIndex +
// background + cron + tasksDir）同样以 s14 为底。
import {
  consumeCronQueue,
  createCronState,
  cronStateSummary,
  loadDurableJobs,
  makeCronHandlers,
  TOOL_SCHEMAS as S14_TOOL_SCHEMAS,
  type Deps as S14Deps,
  tools as s14Tools,
  startCronScheduler,
} from "../s14_cron_scheduler/main";

// deps 与 s14 一致，另加跨轮的团队状态。
export type Deps = S14Deps & {
  team: TeamState;
};

// ═══════════════════════════════════════════════════════════
//  s15 新增：MessageBus —— 基于文件的邮箱
// ═══════════════════════════════════════════════════════════

// 默认邮箱目录，落在 s15 自己的目录下（对齐 s14 的 .scheduled_tasks.json）。
export const MAILBOX_DIR = path.join(import.meta.dirname, ".mailboxes");

export type BusMessage = {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
};

// 基于文件的消息总线：每个 agent 一个 .jsonl 收件箱。
// 读取是破坏性的（readFile + unlink，即读即消费）。
// 教学版不加文件锁；真实 CC 用 proper-lockfile 保证并发写安全。
// mailboxDir 可注入，测试传临时目录做隔离。
export class MessageBus {
  constructor(public mailboxDir: string = MAILBOX_DIR) {
    fs.mkdirSync(mailboxDir, { recursive: true });
  }

  private inboxPath(agent: string): string {
    return path.join(this.mailboxDir, `${agent}.jsonl`);
  }

  // 追加一条消息到收件人的 .jsonl。
  send(from: string, to: string, content: string, type = "message"): void {
    const msg: BusMessage = { from, to, content, type, ts: Date.now() / 1000 };
    fs.appendFileSync(this.inboxPath(to), `${JSON.stringify(msg)}\n`);
    print(`  [bus] ${from} → ${to}: ${content.slice(0, 50)}`, "yellow");
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
}

// 团队生命周期状态：由 session 持有、跨轮复用（对齐 s14 的 CronState）。
// bus 可注入，测试传带临时 mailbox 目录的 bus 做隔离。
export class TeamState {
  // 仍在运行的队友名字集合。
  activeTeammates = new Set<string>();
  constructor(public bus: MessageBus = new MessageBus()) {}
}

// 非破坏性探测：是否有已完成、等待收集的后台任务（轮询器的唤醒条件之一）。
// s13 的 BackgroundState.tasks 是公开字段，这里只读它的状态、不做消费。
export function hasPendingBackground(background: BackgroundState): boolean {
  return Object.values(background.tasks).some((t) => t.status === "completed");
}

// ═══════════════════════════════════════════════════════════
//  s15 新增：队友（游离的异步循环）
// ═══════════════════════════════════════════════════════════

// 教学版每个队友最多跑的轮数；真实 CC 用空闲循环（等收件箱 -> 干活 -> 重复）直到关闭。
const MAX_TEAMMATE_ROUNDS = 10;

// 把队友创建为一个游离的异步循环（守护线程的 TS 版）。
// 队友跑自己的简化 agent 循环：bash / read / write / send_message，最多 10 轮。
// 日志走 logger.child(name) 子 scope，与 Lead 的日志区分开。
export function spawnTeammateThread(
  team: TeamState,
  client: ModelClient,
  logger: SessionLogger,
  name: string,
  role: string,
  prompt: string,
): string {
  if (team.activeTeammates.has(name)) {
    return `Teammate '${name}' already exists`;
  }
  const bus = team.bus;
  const subLogger = logger.child(name);

  const system =
    `You are '${name}', a ${role}. Use tools to complete tasks. ` +
    `Send results via send_message to 'lead'.`;

  const bashSchema = z.object({ command: z.string() });
  const readSchema = z.object({ path: z.string() });
  const writeSchema = z.object({ path: z.string(), content: z.string() });
  const sendSchema = z.object({ to: z.string(), content: z.string() });

  const subTools: Anthropic.Tool[] = [
    zodTool("bash", "Run a shell command.", bashSchema),
    zodTool("read_file", "Read file contents.", readSchema),
    zodTool("write_file", "Write content to a file.", writeSchema),
    zodTool("send_message", "Send a message to another agent.", sendSchema),
  ];
  const subSchemas: Partial<Record<string, z.ZodObject>> = {
    bash: bashSchema,
    read_file: readSchema,
    write_file: writeSchema,
    send_message: sendSchema,
  };
  // 基础 bash/read/write 直接借 s03 的 handler，只自加 send_message。
  const subHandlers: Handlers = {
    bash: BASE_TOOL_HANDLERS.bash,
    read_file: BASE_TOOL_HANDLERS.read_file,
    write_file: BASE_TOOL_HANDLERS.write_file,
    send_message: ({ to, content }) => {
      bus.send(name, to, content);
      return "Sent";
    },
  };

  const run = async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    let lastText = "";

    for (let round = 0; round < MAX_TEAMMATE_ROUNDS; round++) {
      // 每轮开头先收自己的收件箱。
      const inbox = bus.readInbox(name);
      if (inbox.length) {
        messages.push({
          role: "user",
          content: `<inbox>${JSON.stringify(inbox)}</inbox>`,
        });
      }
      subLogger.request(messages, true);
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: MODEL_ID,
          system,
          // 尾窗对齐 Python 的 messages[-20:]（教学捷径；超长会话可能切断
          // 某个 tool_use / tool_result 配对）。
          messages: messages.slice(-20),
          tools: subTools,
          max_tokens: 8000,
        });
      } catch (e) {
        subLogger.responseError(e);
        break;
      }
      subLogger.response(response);
      messages.push({ role: "assistant", content: response.content });
      const text = textOf(response);
      if (text) lastText = text;
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const schema = subSchemas[block.name];
        const handler = subHandlers[block.name];
        const output =
          handler && schema ? handler(schema.parse(block.input)) : "Unknown";
        subLogger.toolResult(block.name, output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
      messages.push({ role: "user", content: results });
    }

    // 把最终小结发回 Lead。
    bus.send(name, "lead", lastText || "Done.", "result");
    team.activeTeammates.delete(name);
    subLogger.console(`  [teammate] ${name} finished`, "magenta");
  };

  team.activeTeammates.add(name);
  void run(); // 游离执行 —— 与 Lead 的循环并发
  logger.console(`  [teammate] ${name} spawned as ${role}`, "magenta");
  return `Teammate '${name}' spawned as ${role}`;
}

// 团队 handler 需要 team 状态 + client（派生队友）+ logger，用工厂闭包捕获，
// 再与基础/任务/cron handler 合并。
export function makeTeamHandlers(
  team: TeamState,
  client: ModelClient,
  logger: SessionLogger,
): Handlers {
  return {
    spawn_teammate: ({ name, role, prompt }) =>
      spawnTeammateThread(team, client, logger, name, role, prompt),
    send_message: ({ to, content }) => {
      team.bus.send("lead", to, content);
      return `Sent to ${to}`;
    },
    check_inbox: () => {
      const msgs = team.bus.readInbox("lead");
      if (!msgs.length) return "(inbox empty)";
      return msgs
        .map((m) => `  [${m.from}] ${m.content.slice(0, 200)}`)
        .join("\n");
    },
  };
}

// ═══════════════════════════════════════════════════════════
//  s15 新增：团队工具定义，叠加到 s14 的工具集之上
// ═══════════════════════════════════════════════════════════

const spawnTeammateSchema = z.object({
  name: z.string(),
  role: z.string(),
  prompt: z.string(),
});
const sendMessageSchema = z.object({ to: z.string(), content: z.string() });
const checkInboxSchema = z.object({});

const teamTools: Anthropic.Tool[] = [
  zodTool(
    "spawn_teammate",
    "Spawn a teammate agent in the background.",
    spawnTeammateSchema,
  ),
  zodTool(
    "send_message",
    "Send a message to a teammate via MessageBus.",
    sendMessageSchema,
  ),
  zodTool(
    "check_inbox",
    "Check Lead's inbox for teammate messages.",
    checkInboxSchema,
  ),
];

// tools 以 s14（基础 + 任务 + 后台 bash + cron）为底，追加 3 个团队工具。
export const tools: Anthropic.Tool[] = [...s14Tools, ...teamTools];

// schema 表同理：以 s14 为底，追加团队 schema。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S14_TOOL_SCHEMAS,
  spawn_teammate: spawnTeammateSchema,
  send_message: sendMessageSchema,
  check_inbox: checkInboxSchema,
};

// 合并后的工具名（基础 + 任务 + 后台 bash + cron + 团队），用于填 enabled_tools。
export const TOOL_NAMES: string[] = tools.map((t) => t.name);

// 复用 s12 的 memory/workspace 推导，只把 enabled_tools 换成含团队工具的完整列表，
// 这样 getSystemPrompt 组装出的「Available tools」也会带上团队工具。
export function updateContext(memoryIndex: string): Context {
  return { ...taskUpdateContext(memoryIndex), enabled_tools: TOOL_NAMES };
}

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦团队协作（省略 s11 的错误恢复）
// ═══════════════════════════════════════════════════════════
// 与 s14 的循环体一致，只多接三样：团队 handler、系统日志里的 activeTeammates。
// 收件箱 / 后台结果的排空在入口的事件循环里做（详见 wake 分支），本函数只在
// 循环开头消费 cron 队列。
export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: Deps,
): Promise<string> {
  const { client, logger, memoryIndex, tasksDir, background, cron, team } =
    deps;
  let system = getSystemPrompt(context);
  // 基础工具（前台 bash / 文件工具）+ 任务工具 + cron 工具 + 团队工具。
  const handlers: Handlers = {
    ...BASE_TOOL_HANDLERS,
    ...makeTaskHandlers(logger, tasksDir),
    ...makeCronHandlers(cron, logger),
    ...makeTeamHandlers(team, client, logger),
  };

  while (true) {
    logger.section(
      "SYSTEM PROMPT",
      `enabled_tools: ${JSON.stringify(Object.keys(handlers))}` +
        `\nworkspace: ${context.workspace}` +
        `\n\nBackgroundState:\n${JSON.stringify(background)}` +
        `\n\nCronState:\n${cronStateSummary(cron)}` +
        `\n\nactiveTeammates: ${JSON.stringify([...team.activeTeammates])}`,
    );

    // Layer 4：消费已触发的 cron 任务，作为 user 消息注入。
    const fired = consumeCronQueue(cron);
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      logger.console(`  [inject cron] ${job.prompt.slice(0, 50)}`, "magenta");
    }

    logger.request(messages, true);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        system,
        messages,
        tools,
        max_tokens: 8000,
      });
    } catch (e) {
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      return errText;
    }
    logger.response(response);

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") {
        continue;
      }
      const schema = TOOL_SCHEMAS[block.name];
      const input = schema ? schema.parse(block.input) : (block.input as any);

      // 后台执行：模型显式请求 run_in_background 或启发式判断为慢操作。
      if (shouldRunBackground(block.name, input)) {
        const backgroundId = startBackgroundTask(
          background,
          handlers,
          block.name,
          block.id,
          input,
          logger,
        );
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            `[Background task ${backgroundId} started] ` +
            `Command: ${input.command ?? ""}. ` +
            `Result will be available when complete.`,
        });
      } else {
        // 前台执行：同步调用 handler，返回结果。
        const handler = handlers[block.name];
        const output =
          handler && schema ? handler(input) : `Unknown: ${block.name}`;
        logger.toolResult(block.name, output);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // tool_result 块和后台通知一起放进同一条 user 消息。
    const backgroundNotifications = collectBackgroundResults(
      background,
      logger,
    );
    const content: Anthropic.ContentBlockParam[] = [
      ...results,
      ...backgroundNotifications.map((n) => ({
        type: "text" as const,
        text: n,
      })),
    ];
    messages.push({ role: "user", content });
    if (backgroundNotifications.length) {
      logger.section(
        "INJECTED BACKGROUND NOTIFICATIONS",
        backgroundNotifications.join("\n\n"),
      );
    }

    context = updateContext(memoryIndex);
    system = getSystemPrompt(context);
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  logger.config({ model: MODEL_ID, tools });

  print("s15: Agent Teams — MessageBus + 游离队友循环 + 收件箱注入", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const history: Anthropic.MessageParam[] = [];
  const background = new BackgroundState();
  const cron = createCronState(import.meta.dirname);
  const tasksDir = tasksDirFor(import.meta.dirname);
  //
  const team = new TeamState();
  let context = updateContext(MEMORY_INDEX);

  loadDurableJobs(cron, logger);
  startCronScheduler(cron, logger);

  //
  type AgentEvent = ["quit" | "user" | "wake", string | null];
  const events: AgentEvent[] = [];
  let eventWaiter: (() => void) | null = null;

  //
  function pushEvent(kind: AgentEvent[0], payload: string | null): void {
    events.push([kind, payload]);
    if (eventWaiter) {
      eventWaiter();
      eventWaiter = null;
    }
  }

  //
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

  void (async function inputReader() {
    while (true) {
      let line: string;
      try {
        line = await rl.question(colorize("s15 >> ", "cyan"));
      } catch {
        pushEvent("quit", null); // stdin 关闭（Ctrl+D）
        return;
      }
      pushEvent("user", line);
    }
  })();

  // 每 ~1s 唤醒 Lead：收件箱有消息、或后台任务完成时投一个 wake 事件。
  // 不按 activeTeammates 门控：队友发完结果才把自己移除，最后一条消息可能比注册项活得久。
  // cron 不在唤醒条件里（对齐 code.py）：cron 队列只在别的来源触发一轮时由 agentLoop 顺带消费。
  const poller = setInterval(() => {
    if (team.bus.peek("lead") || hasPendingBackground(background)) {
      pushEvent("wake", null);
    }
  }, 1000);
  poller.unref();

  let hadTeammates = false;
  while (true) {
    const [kind, payload] = await nextEvent();
    if (kind === "quit") break;
    if (kind === "user") {
      const q = (payload ?? "").trim().toLowerCase();
      if (q === "" || q === "q" || q === "exit") break;
      logger.userInput(payload ?? "");
      history.push({ role: "user", content: payload ?? "" });
    } else {
      // "wake"：收件箱或后台结果就绪，排空后注入历史。
      const parts: string[] = [];
      const inbox = team.bus.readInbox("lead");
      if (inbox.length) {
        parts.push(
          "[Inbox]\n" +
            inbox
              .map((m) => `From ${m.from}: ${m.content.slice(0, 200)}`)
              .join("\n"),
        );
      }
      const bg = collectBackgroundResults(background, logger);
      parts.push(...bg);
      // 已被更早的 wake 排空 —— 本次空转（幂等）。
      if (!parts.length) continue;
      history.push({ role: "user", content: parts.join("\n") });
      logger.console(
        `\n[wake: ${inbox.length} inbox + ${bg.length} background -> new turn]`,
        "yellow",
      );
    }

    // 为唤醒本轮的来源跑一轮 agent 循环。
    const finalText = await agentLoop(history, context, {
      client,
      logger,
      memoryIndex: MEMORY_INDEX,
      background,
      cron,
      team,
      tasksDir,
    });
    context = updateContext(MEMORY_INDEX);
    print(finalText, "green");

    // 所有队友都跑完、且输出都排空后，播报一次。
    if (team.activeTeammates.size) {
      hadTeammates = true;
    } else if (
      hadTeammates &&
      !team.bus.peek("lead") &&
      !hasPendingBackground(background)
    ) {
      print("[all teammates done]", "magenta");
      hadTeammates = false;
    }
    print();
  }
  rl.close();
}

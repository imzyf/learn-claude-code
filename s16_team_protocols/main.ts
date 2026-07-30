/**
 * s16_team_protocols/main.ts - 团队协议
 *
 * 请求-响应协议 + request_id + 分发 + 状态机。
 *
 * 相比 s15 的变化：
 *   工具层、任务系统、后台任务、cron 调度、团队层（MessageBus / TeamState /
 *   makeTeamHandlers）、prompt 组装继续直接复用，不再内联：
 *     基础工具 handler 复用 s03，任务系统（makeTaskHandlers）复用 s12，
 *     后台任务（BackgroundState / shouldRunBackground / startBackgroundTask /
 *     collectBackgroundResults）复用 s13，cron 调度层（CronState /
 *     startCronScheduler / consumeCronQueue / makeCronHandlers）复用 s14，
 *     团队层（MessageBus / TeamState / makeTeamHandlers / tools / TOOL_SCHEMAS /
 *     hasPendingBackground）复用 s15，getSystemPrompt / Context 复用 s12 / s10，
 *     MEMORY_INDEX 复用 s09。s11 的错误恢复在此照旧省略。
 *   本文件只新增协议这一层：
 *   + ProtocolBus：给 s15 的 MessageBus 补一条带 metadata 的发送路径（request_id 靠它传）
 *   + ProtocolRequest + ProtocolTeamState.pendingRequests：进行中请求的状态机
 *     （pending → approved / rejected），由 session 持有、跨轮复用
 *   + matchResponse：Lead 用 request_id 关联响应，并校验响应类型、忽略重复响应
 *   + consumeLeadInbox：读 Lead 收件箱的唯一入口 —— 先路由协议，再交给调用方
 *   + spawnTeammateThread：队友改成空闲循环（等收件箱），并按类型分发收到的消息
 *   + makeProtocolHandlers：覆盖 spawn_teammate / check_inbox，另加 3 个 Lead 工具
 *     （request_shutdown / request_plan / review_plan）+ 1 个队友工具（submit_plan）
 *
 * ASCII 流程：
 *   Lead:     request_shutdown → sendProtocol("shutdown_request", {request_id}) ──→ 队友收件箱
 *   Teammate: drainInbox → 按 type 分发 → sendProtocol("shutdown_response", {request_id}) ──→ Lead 收件箱
 *   Lead:     consumeLeadInbox → matchResponse(request_id) → pendingRequests[id].status = approved
 *
 * TS 特有说明：
 *   - 与上游 code.py 的差异：上游 s16 顺手删掉了 s15 的 cron 与事件队列；这里两者都留着 ——
 *     协议响应本来就是异步回来的，s15 的事件队列（1s 轮询收件箱就唤醒 Lead）正好是它需要的，
 *     否则 shutdown_response 要等用户下次敲回车才被看见。
 *   - s15 的 MessageBus.send 签名已固定为 4 个参数，子类覆盖时不能再加参数
 *     （TS 要求子类方法可赋值给父类方法），所以协议消息走 sendProtocol，
 *     普通消息仍用继承来的 send。
 *   - 队友的空闲等待是 `await sleep(1s)` 的游离循环，不阻塞事件循环；
 *     退出时入口置 team.shuttingDown，队友下一拍收尾，进程不会被吊住。
 *   - 队友不再有 s15 的 10 轮上限：只有 shutdown 协议（或 session 退出）能结束它。
 *
 * Usage:
 *     pnpm dev s16_team_protocols/main.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { createPrompt, print, printFinal } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
import { errMsg, type Handlers } from "../s02_tool_use/main";
// 来自 s03：基础 dispatch 表（队友的 bash/read/write 直接借这里的 handler）。
import { TOOL_HANDLERS as BASE_TOOL_HANDLERS } from "../s03_permission/main";
// 来自 s09：记忆索引路径。
import { MEMORY_INDEX } from "../s09_memory/main";
// 来自 s10：只借 Context 类型。
import type { Context } from "../s10_system_prompt/main";
// 来自 s11：只借 sleep（队友空闲等待用）。
import { sleep } from "../s11_error_recovery/main";
// 来自 s12：prompt 组装、任务工具工厂、memory/workspace 的 context 推导。
import {
  getSystemPrompt,
  makeTaskHandlers,
  makeUpdateContext,
  tasksDirFor,
} from "../s12_task_system/main";
// 来自 s13：后台任务层。
import {
  BackgroundState,
  collectBackgroundResults,
  shouldRunBackground,
  startBackgroundTask,
} from "../s13_background_tasks/main";
// 来自 s14：cron 调度层。
import {
  consumeCronQueue,
  createCronState,
  cronStateSummary,
  loadDurableJobs,
  makeCronHandlers,
  startCronScheduler,
} from "../s14_cron_scheduler/main";
// 来自 s15：团队层（tools / TOOL_SCHEMAS 已是「基础 + 任务 + 后台 bash + cron + 团队」
// 的合并）。s16 在其上再叠加协议工具；Deps 同样以 s15 为底，只把 team 换成带协议状态的版本。
import {
  type BusMessage,
  hasPendingBackground,
  MessageBus,
  mailboxDirFor,
  makeTeamHandlers,
  TOOL_SCHEMAS as S15_TOOL_SCHEMAS,
  type Deps as S15Deps,
  tools as s15Tools,
  TeamState,
} from "../s15_agent_teams/main";

// deps 与 s15 一致，只把 team 换成带协议状态的 ProtocolTeamState。
export type Deps = Omit<S15Deps, "team"> & {
  team: ProtocolTeamState;
};

// ═══════════════════════════════════════════════════════════
//  s16 新增：ProtocolBus —— 带 metadata 的消息总线
// ═══════════════════════════════════════════════════════════

// s15 的 BusMessage 没有 metadata；协议靠 metadata.request_id 关联请求与响应，
// 普通消息则没有这一栏，所以是可选的。
export type ProtocolMessage = BusMessage & {
  metadata?: Record<string, unknown>;
};

// 协议版消息总线：收发与 s15 相同，只多一条带 metadata 的发送路径。
// send（继承自 s15）发普通消息，sendProtocol 发协议消息。
export class ProtocolBus extends MessageBus {
  // 追加一条带 metadata 的消息到收件人的 .jsonl。
  sendProtocol(
    from: string,
    to: string,
    content: string,
    type: string,
    metadata: Record<string, unknown>,
  ): void {
    const msg: ProtocolMessage = {
      from,
      to,
      content,
      type,
      ts: Date.now() / 1000,
      metadata,
    };
    fs.appendFileSync(
      path.join(this.mailboxDir, `${to}.jsonl`),
      `${JSON.stringify(msg)}\n`,
    );
    print(
      `  [bus] ${from} → ${to}: (${type}) ${content.slice(0, 50)}`,
      "yellow",
    );
  }

  // 只收窄返回类型：读出来的消息可能带 metadata（协议消息才有），读写逻辑仍是 s15 的。
  readInbox(agent: string): ProtocolMessage[] {
    return super.readInbox(agent);
  }
}

// ═══════════════════════════════════════════════════════════
//  s16 新增：协议状态机
// ═══════════════════════════════════════════════════════════

export type ProtocolRequestType = "shutdown" | "plan_approval";
export type ProtocolStatus = "pending" | "approved" | "rejected";

// 一次协议请求的记录：发出时 pending，响应回来后置为 approved / rejected。
export type ProtocolRequest = {
  requestId: string;
  type: ProtocolRequestType;
  sender: string;
  target: string;
  status: ProtocolStatus;
  payload: string; // 计划正文，或 shutdown 理由
  createdAt: number;
};

// 每种请求期望的响应类型，matchResponse 用它校验。
const RESPONSE_TYPE: Record<ProtocolRequestType, string> = {
  shutdown: "shutdown_response",
  plan_approval: "plan_approval_response",
};

// 团队状态在 s15 的基础上多两样：进行中的协议请求，以及退出时的停机标志。
// bus 必填，测试传带临时 mailbox 目录的 bus 做隔离（同 s15）。
export class ProtocolTeamState extends TeamState {
  // request_id -> 请求状态，Lead 收到响应时按 id 关联。
  pendingRequests = new Map<string, ProtocolRequest>();
  // 入口退出时置 true，队友的空闲循环据此收尾。
  shuttingDown = false;
  // 收窄 s15 的 bus 类型，不重新声明字段（赋值仍由父类构造函数完成）。
  declare bus: ProtocolBus;
  // biome-ignore lint/complexity/noUselessConstructor: 收窄构造参数为 ProtocolBus，去掉它 s15 的 MessageBus 也能传进来，sendProtocol 要到运行时才炸
  constructor(bus: ProtocolBus) {
    super(bus);
  }
}

// <session>/.mailboxes/ 上的 ProtocolTeamState：入口用 createProtocolTeam(import.meta.dirname)。
export function createProtocolTeam(sessionDir: string): ProtocolTeamState {
  return new ProtocolTeamState(new ProtocolBus(mailboxDirFor(sessionDir)));
}

const newRequestId = (): string =>
  `req_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;

// 登记一条进行中的请求，返回 request_id。
function openRequest(
  team: ProtocolTeamState,
  type: ProtocolRequestType,
  sender: string,
  target: string,
  payload: string,
): string {
  const requestId = newRequestId();
  team.pendingRequests.set(requestId, {
    requestId,
    type,
    sender,
    target,
    status: "pending",
    payload,
    createdAt: Date.now() / 1000,
  });
  return requestId;
}

// Lead 侧：用 request_id 把响应关联回原请求。
// 三道校验 —— 请求存在、响应类型对得上、请求仍是 pending（重复响应直接忽略）。
export function matchResponse(
  team: ProtocolTeamState,
  logger: SessionLogger,
  responseType: string,
  requestId: string,
  approve: boolean,
): void {
  const state = team.pendingRequests.get(requestId);
  if (!state) {
    logger.console(`  [protocol] unknown request_id: ${requestId}`, "red");
    return;
  }
  const expected = RESPONSE_TYPE[state.type];
  if (responseType !== expected) {
    logger.console(
      `  [protocol] type mismatch: expected ${expected}, got ${responseType}`,
      "red",
    );
    return;
  }
  if (state.status !== "pending") {
    logger.console(
      `  [protocol] ${requestId} already ${state.status}, ignoring duplicate`,
      "yellow",
    );
    return;
  }
  state.status = approve ? "approved" : "rejected";
  logger.console(
    `  [protocol] ${state.type} ${approve ? "✓" : "✗"} (${requestId}: ${state.status})`,
    approve ? "green" : "red",
  );
}

// 进行中请求的一览，写进 transcript 的 SYSTEM PROMPT 一节（对齐 s14 的 cronStateSummary）。
export function pendingRequestsSummary(team: ProtocolTeamState): string {
  if (!team.pendingRequests.size) return "(none)";
  return [...team.pendingRequests.values()]
    .map(
      (r) =>
        `  ${r.requestId} ${r.type} ${r.sender} → ${r.target} [${r.status}]`,
    )
    .join("\n");
}

// 读 Lead 收件箱的唯一入口：check_inbox 工具和入口的 wake 分支都走这里，
// 保证消息不会被读走却漏掉协议路由（读取即消费，只有一次机会）。
export function consumeLeadInbox(
  team: ProtocolTeamState,
  logger: SessionLogger,
): ProtocolMessage[] {
  const msgs = team.bus.readInbox("lead");
  for (const msg of msgs) {
    const requestId = String(msg.metadata?.request_id ?? "");
    if (requestId && msg.type.endsWith("_response")) {
      matchResponse(
        team,
        logger,
        msg.type,
        requestId,
        Boolean(msg.metadata?.approve),
      );
    }
  }
  return msgs;
}

// ═══════════════════════════════════════════════════════════
//  s16 新增：队友（空闲循环 + 消息分发）
// ═══════════════════════════════════════════════════════════

// 队友空闲时轮询收件箱的间隔。
const IDLE_POLL_MS = 1000;

// 消费一次收件箱的结果：停机 / 有消息注入 / 空。
type InboxOutcome = "shutdown" | "injected" | "empty";

// 把队友创建为一个游离的异步循环（守护线程的 TS 版）。
// 相比 s15：跑完一轮不再退出，而是空闲等收件箱；停机由 shutdown 协议触发。
// 日志走 logger.child(name) 子 scope，与 Lead 的日志区分开。
export function spawnTeammateThread(
  team: ProtocolTeamState,
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
    `Check inbox for protocol messages (shutdown_request, etc).`;

  // 按类型分发收件箱消息：shutdown_request 回执后停机，
  // plan_approval_response 注入审批结论，其余原样塞进 <inbox>。
  const drainInbox = (
    msgs: ProtocolMessage[],
    messages: Anthropic.MessageParam[],
  ): InboxOutcome => {
    const plain: ProtocolMessage[] = [];
    let injected = false;

    for (const msg of msgs) {
      const requestId = String(msg.metadata?.request_id ?? "");

      if (msg.type === "shutdown_request") {
        bus.sendProtocol(
          name,
          "lead",
          "Shutting down gracefully.",
          "shutdown_response",
          { request_id: requestId, approve: true },
        );
        subLogger.console(
          `  [protocol] ${name} approved shutdown (${requestId})`,
          "magenta",
        );
        return "shutdown";
      }

      if (msg.type === "plan_approval_response") {
        const approve = Boolean(msg.metadata?.approve);
        messages.push({
          role: "user",
          content: approve
            ? "[Plan approved] Proceed with the task."
            : `[Plan rejected] Feedback: ${msg.content}`,
        });
        injected = true;
        continue;
      }

      plain.push(msg);
    }

    if (plain.length) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(plain)}</inbox>`,
      });
      injected = true;
    }
    return injected ? "injected" : "empty";
  };

  const bashSchema = z.object({ command: z.string() });
  const readSchema = z.object({ path: z.string() });
  const writeSchema = z.object({ path: z.string(), content: z.string() });
  const sendSchema = z.object({ to: z.string(), content: z.string() });
  const submitPlanSchema = z.object({ plan: z.string() });

  const subTools: Anthropic.Tool[] = [
    zodTool("bash", "Run a shell command.", bashSchema),
    zodTool("read_file", "Read file contents.", readSchema),
    zodTool("write_file", "Write content to a file.", writeSchema),
    zodTool("send_message", "Send a message to another agent.", sendSchema),
    zodTool(
      "submit_plan",
      "Submit a plan for Lead approval.",
      submitPlanSchema,
    ),
  ];
  const subSchemas: Partial<Record<string, z.ZodObject>> = {
    bash: bashSchema,
    read_file: readSchema,
    write_file: writeSchema,
    send_message: sendSchema,
    submit_plan: submitPlanSchema,
  };
  // 基础 bash/read/write 直接借 s03 的 handler，只自加 send_message / submit_plan。
  const subHandlers: Handlers = {
    bash: BASE_TOOL_HANDLERS.bash,
    read_file: BASE_TOOL_HANDLERS.read_file,
    write_file: BASE_TOOL_HANDLERS.write_file,
    send_message: ({ to, content }) => {
      bus.send(name, to, content);
      return "Sent";
    },
    submit_plan: ({ plan }) => submitPlan(team, name, plan),
  };

  const run = async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    let lastText = "";
    let stopped = false;

    while (!team.shuttingDown && !stopped) {
      // 每轮开头先收自己的收件箱。
      if (drainInbox(bus.readInbox(name), messages) === "shutdown") break;

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

      if (response.stop_reason !== "tool_use") {
        // 空闲：等收件箱来消息，而不是像 s15 那样直接结束。
        // 真实 CC 在这里给 Lead 发 idle_notification。
        subLogger.console(`  [teammate] ${name} idle`, "magenta");
        let outcome: InboxOutcome = "empty";
        while (!team.shuttingDown && outcome === "empty") {
          await sleep(IDLE_POLL_MS);
          outcome = drainInbox(bus.readInbox(name), messages);
        }
        stopped = outcome === "shutdown";
        continue; // 本轮没有工具调用，带着新消息回到 LLM 轮次
      }

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

    // 把最终小结发回 Lead；整个 session 正在退出时就别再往收件箱里塞了。
    if (!team.shuttingDown) {
      bus.send(name, "lead", lastText || "Done.", "result");
    }
    team.activeTeammates.delete(name);
    subLogger.console(`  [teammate] ${name} finished`, "magenta");
  };

  team.activeTeammates.add(name);
  void run(); // 游离执行 —— 与 Lead 的循环并发
  logger.console(`  [teammate] ${name} spawned as ${role}`, "magenta");
  return `Teammate '${name}' spawned as ${role}`;
}

// 队友把计划提交给 Lead 审批。
// 这是协议层的请求，不是代码层的闸门：提交后队友的循环照跑，仍能调用 bash/write。
// 真正的约束靠模型自觉等审批结果回来再动手（代码层闸门留到 s20）。
export function submitPlan(
  team: ProtocolTeamState,
  fromName: string,
  plan: string,
): string {
  const requestId = openRequest(team, "plan_approval", fromName, "lead", plan);
  team.bus.sendProtocol(fromName, "lead", plan, "plan_approval_request", {
    request_id: requestId,
  });
  return `Plan submitted (${requestId}). Waiting for approval...`;
}

// ═══════════════════════════════════════════════════════════
//  s16 新增：Lead 的协议工具
// ═══════════════════════════════════════════════════════════

// 请求队友优雅停机：登记请求 + 发 shutdown_request，响应回来时由 matchResponse 收口。
export function requestShutdown(
  team: ProtocolTeamState,
  logger: SessionLogger,
  teammate: string,
): string {
  const requestId = openRequest(team, "shutdown", "lead", teammate, "");
  team.bus.sendProtocol(
    "lead",
    teammate,
    "Please shut down gracefully.",
    "shutdown_request",
    { request_id: requestId },
  );
  logger.console(
    `  [protocol] shutdown_request → ${teammate} (${requestId})`,
    "magenta",
  );
  return `Shutdown request sent to ${teammate} (req: ${requestId})`;
}

// 让队友就某件事提交计划：普通消息即可，request_id 由队友 submit_plan 时才生成。
export function requestPlan(
  team: ProtocolTeamState,
  teammate: string,
  task: string,
): string {
  team.bus.send("lead", teammate, `Please submit a plan for: ${task}`);
  return `Asked ${teammate} to submit a plan`;
}

// 审批队友提交的计划：改状态 + 把结论按 request_id 发回提交者。
export function reviewPlan(
  team: ProtocolTeamState,
  logger: SessionLogger,
  requestId: string,
  approve: boolean,
  feedback = "",
): string {
  const state = team.pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  if (state.status !== "pending") {
    return `Request ${requestId} already ${state.status}`;
  }
  state.status = approve ? "approved" : "rejected";
  team.bus.sendProtocol(
    "lead",
    state.sender,
    feedback || (approve ? "Approved" : "Rejected"),
    "plan_approval_response",
    { request_id: requestId, approve },
  );
  logger.console(
    `  [protocol] plan ${approve ? "✓" : "✗"} (${requestId})`,
    approve ? "green" : "red",
  );
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

// 收件箱一行：协议消息带上 request_id，Lead 拿到就能直接 review_plan。
function formatInboxLine(msg: ProtocolMessage): string {
  const requestId = String(msg.metadata?.request_id ?? "");
  const tag = requestId ? `[${msg.type} req:${requestId}]` : `[${msg.type}]`;
  return `  [${msg.from}] ${tag} ${msg.content.slice(0, 200)}`;
}

// 协议 handler 需要 team 状态 + client（派生队友）+ logger，用工厂闭包捕获，
// 再叠到 s15 的团队 handler 之上：spawn_teammate / check_inbox 同名覆盖。
export function makeProtocolHandlers(
  team: ProtocolTeamState,
  client: ModelClient,
  logger: SessionLogger,
): Handlers {
  return {
    // 覆盖 s15：换成会空闲等待、能处理协议消息的队友循环。
    spawn_teammate: ({ name, role, prompt }) =>
      spawnTeammateThread(team, client, logger, name, role, prompt),
    // 覆盖 s15：读收件箱的同时路由协议响应。
    check_inbox: () => {
      const msgs = consumeLeadInbox(team, logger);
      if (!msgs.length) return "(inbox empty)";
      return msgs.map(formatInboxLine).join("\n");
    },
    request_shutdown: ({ teammate }) => requestShutdown(team, logger, teammate),
    request_plan: ({ teammate, task }) => requestPlan(team, teammate, task),
    review_plan: ({ request_id, approve, feedback }) =>
      reviewPlan(team, logger, request_id, approve, feedback ?? ""),
  };
}

// ═══════════════════════════════════════════════════════════
//  s16 新增：协议工具定义，叠加到 s15 的工具集之上
// ═══════════════════════════════════════════════════════════

const requestShutdownSchema = z.object({ teammate: z.string() });
const requestPlanSchema = z.object({ teammate: z.string(), task: z.string() });
const reviewPlanSchema = z.object({
  request_id: z.string(),
  approve: z.boolean(),
  feedback: z.string().optional(),
});

const protocolTools: Anthropic.Tool[] = [
  zodTool(
    "request_shutdown",
    "Request a teammate to shut down gracefully.",
    requestShutdownSchema,
  ),
  zodTool(
    "request_plan",
    "Ask a teammate to submit a plan for review.",
    requestPlanSchema,
  ),
  zodTool(
    "review_plan",
    "Approve or reject a submitted plan by request_id.",
    reviewPlanSchema,
  ),
];

// tools 以 s15（基础 + 任务 + 后台 bash + cron + 团队）为底，追加 3 个协议工具。
// submit_plan 只发给队友，不进 Lead 的工具集。
export const tools: Anthropic.Tool[] = [...s15Tools, ...protocolTools];

// schema 表同理：以 s15 为底，追加协议 schema。
export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...S15_TOOL_SCHEMAS,
  request_shutdown: requestShutdownSchema,
  request_plan: requestPlanSchema,
  review_plan: reviewPlanSchema,
};

// 用 s16 的完整工具集绑定 s12 的 context 工厂，
// 这样 getSystemPrompt 组装出的「Available tools」也会带上协议工具。
export const updateContext = makeUpdateContext(tools);

// ═══════════════════════════════════════════════════════════
//  agentLoop —— 精简版，聚焦团队协议（省略 s11 的错误恢复）
// ═══════════════════════════════════════════════════════════
// 与 s15 的循环体一致，只多接两样：协议 handler、系统日志里的 pendingRequests。
// Lead 收件箱的排空在入口的事件循环里做（详见 wake 分支），本函数只在
// 循环开头消费 cron 队列。
export async function agentLoop(
  messages: Anthropic.MessageParam[],
  context: Context,
  deps: Deps,
): Promise<string> {
  const { client, logger, memoryIndex, tasksDir, background, cron, team } =
    deps;
  let system = getSystemPrompt(context);
  // 基础工具 + 任务工具 + cron 工具 + 团队工具 + 协议工具（后者同名覆盖前者）。
  const handlers: Handlers = {
    ...BASE_TOOL_HANDLERS,
    ...makeTaskHandlers(logger, tasksDir),
    ...makeCronHandlers(cron, logger),
    ...makeTeamHandlers(team, client, logger),
    ...makeProtocolHandlers(team, client, logger),
  };

  while (true) {
    logger.section(
      "SYSTEM PROMPT",
      `enabled_tools: ${JSON.stringify(Object.keys(handlers))}` +
        `\n\nBackgroundState:\n${JSON.stringify(background)}` +
        `\n\nCronState:\n${cronStateSummary(cron)}` +
        `\n\nactiveTeammates: ${JSON.stringify([...team.activeTeammates])}` +
        `\n\npendingRequests:\n${pendingRequestsSummary(team)}`,
    );

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

  print("s16: Team Protocols — 请求-响应协议 + request_id + 状态机", "cyan");
  print("🔮 输入问题，回车发送。输入 q 退出。\n", "green");

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
  // 团队 + 协议状态跨轮复用，落在 s16 自己的 .mailboxes/。
  const team = createProtocolTeam(import.meta.dirname);
  let context = updateContext();

  loadDurableJobs(cron, logger);
  startCronScheduler(cron, logger);

  // 三种唤醒来源：stdin 关闭 / 用户输入一行 / 收件箱-后台结果就绪。
  type AgentEvent = ["quit" | "user" | "wake", string | null];
  // 事件队列：多个生产者（line 事件、close、1s 轮询）写入，主循环单点消费。
  const events: AgentEvent[] = [];
  // 队列空时主循环挂在这个 resolve 上，来事件就被叫醒（单消费者，一个槽位够用）。
  let eventWaiter: (() => void) | null = null;

  // 投一个事件：入队，并在主循环正等待时叫醒它。
  function pushEvent(kind: AgentEvent[0], payload: string | null): void {
    events.push([kind, payload]);
    // 主循环正跑 agentLoop（没在等）时 eventWaiter 为 null，事件只留在队列里排队。
    if (eventWaiter) {
      eventWaiter();
      eventWaiter = null;
    }
  }

  // 取队首事件；队列空则挂起，等 pushEvent 叫醒后重试。
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

  // 提示符常驻屏幕底部：输入按行入队，队友 / wake / 工具的输出都从它上方流过。
  const prompt = createPrompt(rl, "s16 >> ");
  rl.on("line", (line) => {
    pushEvent("user", line);
    // 回车后立刻把提示符重新挂到底部：上一轮还没跑完时也能继续输入，
    // 新的行只是排进队列，等本轮 agentLoop 返回才轮到它。
    prompt.show();
  });
  rl.on("close", () => pushEvent("quit", null)); // stdin 关闭（Ctrl+D）
  prompt.show();

  // 每 ~1s 唤醒 Lead：收件箱有消息、或后台任务完成时投一个 wake 事件。
  // 协议响应（shutdown_response / plan_approval_request）就是靠这里被及时看见的。
  const poller = setInterval(() => {
    if (team.bus.peek("lead") || hasPendingBackground(background)) {
      pushEvent("wake", null);
    }
  }, 1000);
  poller.unref();

  while (true) {
    const [kind, payload] = await nextEvent();
    if (kind === "quit") break;
    if (kind === "user") {
      const q = (payload ?? "").trim().toLowerCase();
      if (q === "" || q === "q" || q === "exit") break;
      logger.userInput(payload ?? "");
      history.push({ role: "user", content: payload ?? "" });
    } else {
      // "wake"：收件箱或后台结果就绪，排空后注入历史（协议响应在读取时已被路由）。
      const parts: string[] = [];
      const inbox = consumeLeadInbox(team, logger);
      if (inbox.length) {
        parts.push(`[Inbox]\n${inbox.map(formatInboxLine).join("\n")}`);
      }
      // 后台结果排空：collectBackgroundResults 会把 BackgroundState.results 清空。
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
    printFinal(finalText);
    context = updateContext();
    print();
  }
  // 队友的空闲循环只认 shutdown 协议或这个标志；置上后它们下一拍收尾，
  // 进程不会被 sleep 吊住。
  team.shuttingDown = true;
  if (team.activeTeammates.size) {
    print(`[stopping ${team.activeTeammates.size} teammate(s)]`, "magenta");
  }
  prompt.hide();
  prompt.detach();
  rl.close();
}

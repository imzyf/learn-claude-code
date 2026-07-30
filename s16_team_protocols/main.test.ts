/**
 * s16_team_protocols/main.test.ts
 *
 * s16 的新增点是协议层，测试只聚焦这一层：
 *   - ProtocolBus：sendProtocol 带 metadata 往返，继承来的 send 不带 metadata
 *   - matchResponse：正常关联、未知 request_id、类型不符、重复响应
 *   - consumeLeadInbox：读收件箱时顺手路由协议响应，非协议消息原样返回
 *   - Lead 协议工具：request_shutdown / request_plan / review_plan 的状态机与投递
 *   - submitPlan：队友提交计划 -> pendingRequests 登记 + plan_approval_request 到 Lead
 *   - makeProtocolHandlers：check_inbox 覆盖 s15 版本（带 req 标记 + 路由）
 *   - spawnTeammateThread：重名拒绝、收件箱已有 shutdown_request 时不打 LLM 直接停机、
 *     空闲等待中被 shutdown 协议唤醒、计划批准后从空闲回到 LLM 轮次
 *   - tools 叠加后带协议工具，s15/s14/s13/s12 的工具仍在
 *   - agentLoop：check_inbox 路由协议响应、request_shutdown 端到端投递
 * 团队层 / cron / 后台任务 / 任务系统已在 s15 / s14 / s13 / s12 覆盖，这里不再重复。
 *
 * 队友的 run() 是游离 Promise：用 waitFor 轮询 activeTeammates 或 fake client 的调用次数
 * 作为进度信号（对齐 s15）。空闲轮询是 1s 一拍，涉及空闲的用例放宽超时。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeClient,
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import type { Context } from "../s10_system_prompt/main";
import { BackgroundState } from "../s13_background_tasks/main";
import { CronState } from "../s14_cron_scheduler/main";
import {
  agentLoop,
  consumeLeadInbox,
  makeProtocolHandlers,
  matchResponse,
  ProtocolBus,
  ProtocolTeamState,
  pendingRequestsSummary,
  requestPlan,
  requestShutdown,
  reviewPlan,
  spawnTeammateThread,
  submitPlan,
  TOOL_SCHEMAS,
  tools,
} from "./main";

const ctx = (): Context => ({
  enabled_tools: ["bash"],
  workspace: "/repo",
  memories: "",
});

let dir = "";
// 本用例建过的团队，afterEach 统一停机后再删目录。
const teams: ProtocolTeamState[] = [];

beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(async () => {
  // 队友是游离循环：先置停机标志、等它们退出，再删临时目录，
  // 否则空闲循环醒来时会往已删掉的 mailbox 目录里写。
  for (const team of teams) team.shuttingDown = true;
  await waitFor(
    () => teams.every((t) => t.activeTeammates.size === 0),
    4000,
  ).catch(() => {});
  teams.length = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

const newTeam = (): ProtocolTeamState => {
  const team = new ProtocolTeamState(new ProtocolBus(dir));
  teams.push(team);
  return team;
};
const durable = () => path.join(dir, ".scheduled_tasks.json");
// 用例只会同时开一条协议请求，取第一条即可。
const firstRequestId = (team: ProtocolTeamState): string =>
  [...team.pendingRequests.keys()][0];

// 队友的 run() 游离执行，轮询一个条件作为进度信号。
const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ── ProtocolBus ───────────────────────────────────────────
describe("ProtocolBus", () => {
  it("carries metadata through a protocol message", () => {
    const bus = new ProtocolBus(dir);
    bus.sendProtocol("lead", "alice", "stop please", "shutdown_request", {
      request_id: "req_000001",
    });

    const [msg] = bus.readInbox("alice");
    expect(msg).toMatchObject({
      from: "lead",
      to: "alice",
      content: "stop please",
      type: "shutdown_request",
    });
    expect(msg.metadata).toEqual({ request_id: "req_000001" });
    // 读取即消费：再读为空。
    expect(bus.readInbox("alice")).toEqual([]);
  });

  it("plain send (inherited from s15) carries no metadata", () => {
    const bus = new ProtocolBus(dir);
    bus.send("lead", "alice", "hi");
    const [msg] = bus.readInbox("alice");
    expect(msg.type).toBe("message");
    expect(msg.metadata).toBeUndefined();
  });
});

// ── matchResponse ─────────────────────────────────────────
describe("matchResponse", () => {
  it("approves or rejects the matching pending request", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);

    matchResponse(team, noopLogger, "shutdown_response", reqId, true);
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");

    const other = newTeam();
    requestShutdown(other, noopLogger, "bob");
    const otherId = firstRequestId(other);
    matchResponse(other, noopLogger, "shutdown_response", otherId, false);
    expect(other.pendingRequests.get(otherId)?.status).toBe("rejected");
  });

  it("ignores an unknown request_id", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);

    matchResponse(team, noopLogger, "shutdown_response", "req_999999", true);
    expect(team.pendingRequests.size).toBe(1);
    expect(team.pendingRequests.get(reqId)?.status).toBe("pending");
  });

  it("ignores a response whose type does not match the request", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);

    matchResponse(team, noopLogger, "plan_approval_response", reqId, true);
    expect(team.pendingRequests.get(reqId)?.status).toBe("pending");
  });

  it("ignores a duplicate response once the request is decided", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);

    matchResponse(team, noopLogger, "shutdown_response", reqId, true);
    matchResponse(team, noopLogger, "shutdown_response", reqId, false);
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");
  });
});

// ── pendingRequestsSummary ────────────────────────────────
describe("pendingRequestsSummary", () => {
  it("reports (none) when nothing is in flight", () => {
    expect(pendingRequestsSummary(newTeam())).toBe("(none)");
  });

  it("lists id, type and status of in-flight requests", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const summary = pendingRequestsSummary(team);
    expect(summary).toContain(firstRequestId(team));
    expect(summary).toContain("shutdown");
    expect(summary).toContain("lead → alice");
    expect(summary).toContain("[pending]");
  });
});

// ── consumeLeadInbox ──────────────────────────────────────
describe("consumeLeadInbox", () => {
  it("routes a protocol response and still returns the message", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);
    team.bus.sendProtocol(
      "alice",
      "lead",
      "Shutting down gracefully.",
      "shutdown_response",
      { request_id: reqId, approve: true },
    );

    const msgs = consumeLeadInbox(team, noopLogger);
    expect(msgs.map((m) => m.type)).toEqual(["shutdown_response"]);
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");
    // 读取即消费：再读为空。
    expect(consumeLeadInbox(team, noopLogger)).toEqual([]);
  });

  it("passes non-response messages through untouched", () => {
    const team = newTeam();
    team.bus.send("alice", "lead", "just a note");
    submitPlan(team, "alice", "step 1");
    const reqId = firstRequestId(team);

    const msgs = consumeLeadInbox(team, noopLogger);
    expect(msgs.map((m) => m.type)).toEqual([
      "message",
      "plan_approval_request",
    ]);
    // 请求（不是 _response）不会被路由，状态仍是 pending。
    expect(team.pendingRequests.get(reqId)?.status).toBe("pending");
  });
});

// ── Lead 协议工具 ─────────────────────────────────────────
describe("lead protocol tools", () => {
  it("request_shutdown registers the request and delivers it", () => {
    const team = newTeam();
    const msg = requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);

    expect(msg).toContain(reqId);
    expect(team.pendingRequests.get(reqId)).toMatchObject({
      type: "shutdown",
      sender: "lead",
      target: "alice",
      status: "pending",
    });
    const [delivered] = team.bus.readInbox("alice");
    expect(delivered).toMatchObject({ type: "shutdown_request" });
    expect(delivered.metadata).toMatchObject({ request_id: reqId });
  });

  it("request_plan is a plain message, no request_id yet", () => {
    const team = newTeam();
    expect(requestPlan(team, "alice", "ship the docs")).toBe(
      "Asked alice to submit a plan",
    );
    const [delivered] = team.bus.readInbox("alice");
    expect(delivered.type).toBe("message");
    expect(delivered.content).toContain("ship the docs");
    expect(team.pendingRequests.size).toBe(0);
  });

  it("review_plan decides the request and answers the submitter", () => {
    const team = newTeam();
    submitPlan(team, "alice", "step 1");
    const reqId = firstRequestId(team);
    team.bus.readInbox("lead"); // 丢掉 Lead 侧的提交消息，本用例只看回执

    expect(reviewPlan(team, noopLogger, reqId, true, "looks good")).toContain(
      "approved",
    );
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");
    const [answer] = team.bus.readInbox("alice");
    expect(answer).toMatchObject({
      type: "plan_approval_response",
      content: "looks good",
    });
    expect(answer.metadata).toMatchObject({ request_id: reqId, approve: true });
  });

  it("review_plan rejects unknown or already decided requests", () => {
    const team = newTeam();
    expect(reviewPlan(team, noopLogger, "req_999999", true)).toContain(
      "not found",
    );

    submitPlan(team, "alice", "step 1");
    const reqId = firstRequestId(team);
    reviewPlan(team, noopLogger, reqId, false);
    expect(reviewPlan(team, noopLogger, reqId, true)).toContain(
      "already rejected",
    );
  });
});

// ── submitPlan ────────────────────────────────────────────
describe("submitPlan", () => {
  it("opens a plan_approval request and sends it to lead", () => {
    const team = newTeam();
    const msg = submitPlan(team, "alice", "step 1\nstep 2");
    const reqId = firstRequestId(team);

    expect(msg).toContain(reqId);
    expect(team.pendingRequests.get(reqId)).toMatchObject({
      type: "plan_approval",
      sender: "alice",
      target: "lead",
      status: "pending",
      payload: "step 1\nstep 2",
    });
    const [delivered] = team.bus.readInbox("lead");
    expect(delivered).toMatchObject({
      from: "alice",
      type: "plan_approval_request",
      content: "step 1\nstep 2",
    });
  });
});

// ── makeProtocolHandlers ──────────────────────────────────
describe("makeProtocolHandlers", () => {
  it("check_inbox tags protocol messages with their request_id", () => {
    const team = newTeam();
    submitPlan(team, "alice", "step 1");
    const reqId = firstRequestId(team);
    const handlers = makeProtocolHandlers(team, fakeClient(), noopLogger);

    const output = handlers.check_inbox?.({}) ?? "";
    expect(output).toContain("[alice]");
    expect(output).toContain(`[plan_approval_request req:${reqId}]`);
    // 已消费：再读为空。
    expect(handlers.check_inbox?.({})).toBe("(inbox empty)");
  });

  it("check_inbox routes a protocol response while reading", () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);
    team.bus.sendProtocol("alice", "lead", "ok", "shutdown_response", {
      request_id: reqId,
      approve: true,
    });

    const handlers = makeProtocolHandlers(team, fakeClient(), noopLogger);
    handlers.check_inbox?.({});
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");
  });

  it("request_shutdown and review_plan run through the handlers", () => {
    const team = newTeam();
    const handlers = makeProtocolHandlers(team, fakeClient(), noopLogger);

    expect(handlers.request_shutdown?.({ teammate: "alice" })).toContain(
      "Shutdown request sent to alice",
    );
    const shutdownId = firstRequestId(team);
    expect(team.pendingRequests.get(shutdownId)?.type).toBe("shutdown");

    submitPlan(team, "alice", "step 1");
    const planId = [...team.pendingRequests.keys()][1];
    expect(
      handlers.review_plan?.({
        request_id: planId,
        approve: false,
        feedback: "too vague",
      }),
    ).toContain("rejected");
    expect(team.pendingRequests.get(planId)?.status).toBe("rejected");
  });
});

// ── spawnTeammateThread ───────────────────────────────────
describe("spawnTeammateThread", () => {
  it("rejects a duplicate teammate name", () => {
    const team = newTeam();
    team.activeTeammates.add("alice");
    expect(
      spawnTeammateThread(team, fakeClient(), noopLogger, "alice", "dev", "x"),
    ).toContain("already exists");
    team.activeTeammates.delete("alice");
  });

  it("stops before the first LLM turn when a shutdown request is waiting", async () => {
    const team = newTeam();
    const client = fakeClient();
    // 请求先躺在收件箱里，队友起来第一件事就是收信。
    requestShutdown(team, noopLogger, "carol");
    spawnTeammateThread(team, client, noopLogger, "carol", "dev", "x");

    await waitFor(() => !team.activeTeammates.has("carol"));
    expect(vi.mocked(client.messages.create)).not.toHaveBeenCalled();

    const inbox = consumeLeadInbox(team, noopLogger);
    expect(inbox.map((m) => m.type)).toEqual(["shutdown_response", "result"]);
    expect(team.pendingRequests.get(firstRequestId(team))?.status).toBe(
      "approved",
    );
  });

  it("idles after a text turn and shuts down on the protocol request", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage([textBlock("nothing to do")], "end_turn"),
    );
    const create = vi.mocked(client.messages.create);

    spawnTeammateThread(team, client, noopLogger, "bob", "dev", "wait");
    await waitFor(() => create.mock.calls.length === 1);

    requestShutdown(team, noopLogger, "bob");
    await waitFor(() => !team.activeTeammates.has("bob"), 4000);
    // 空闲期间不再打 LLM，只轮询收件箱。
    expect(create).toHaveBeenCalledTimes(1);

    const inbox = consumeLeadInbox(team, noopLogger);
    const response = inbox.find((m) => m.type === "shutdown_response");
    expect(response?.metadata).toMatchObject({ approve: true });
    expect(inbox.find((m) => m.type === "result")?.content).toBe(
      "nothing to do",
    );
    expect(team.pendingRequests.get(firstRequestId(team))?.status).toBe(
      "approved",
    );
  }, 15_000);

  it("resumes an idle teammate once its plan is approved", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "submit_plan", { plan: "step 1" })],
        "tool_use",
      ),
      fakeMessage([textBlock("waiting for approval")], "end_turn"),
      fakeMessage([textBlock("done after approval")], "end_turn"),
    );
    const create = vi.mocked(client.messages.create);

    spawnTeammateThread(team, client, noopLogger, "alice", "dev", "plan it");
    // 第 1 轮提交计划，第 2 轮说完就进空闲。
    await waitFor(() => create.mock.calls.length === 2);
    const reqId = firstRequestId(team);
    expect(team.pendingRequests.get(reqId)).toMatchObject({
      type: "plan_approval",
      sender: "alice",
      status: "pending",
    });

    expect(reviewPlan(team, noopLogger, reqId, true)).toContain("approved");
    // 审批结论把空闲的队友叫醒，回到第 3 轮 LLM。
    await waitFor(() => create.mock.calls.length === 3, 4000);
    const third = create.mock.calls[2][0];
    expect(JSON.stringify(third.messages)).toContain("[Plan approved]");

    requestShutdown(team, noopLogger, "alice");
    await waitFor(() => !team.activeTeammates.has("alice"), 4000);
    const types = consumeLeadInbox(team, noopLogger).map((m) => m.type);
    expect(types).toEqual([
      "plan_approval_request",
      "shutdown_response",
      "result",
    ]);
  }, 20_000);
});

// ── 工具叠加：协议工具 + s15/s14/s13/s12 的工具仍在 ────────
describe("tools override", () => {
  it("adds protocol tools on top of the s15 tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("request_shutdown");
    expect(names).toContain("request_plan");
    expect(names).toContain("review_plan");
    expect(names).toContain("spawn_teammate"); // s15
    expect(names).toContain("schedule_cron"); // s14
    expect(names).toContain("bash"); // s13 / s02
    expect(names).toContain("create_task"); // s12
    // submit_plan 只发给队友，不进 Lead 的工具集。
    expect(names).not.toContain("submit_plan");
  });

  it("schema parses protocol tool inputs", () => {
    expect(TOOL_SCHEMAS.request_shutdown?.parse({ teammate: "alice" })).toEqual(
      {
        teammate: "alice",
      },
    );
    expect(
      TOOL_SCHEMAS.review_plan?.parse({ request_id: "req_1", approve: true }),
    ).toMatchObject({ request_id: "req_1", approve: true });
  });
});

// ── agentLoop：协议路由端到端 ─────────────────────────────
describe("agentLoop", () => {
  const deps = (
    team: ProtocolTeamState,
    client: ReturnType<typeof fakeClient>,
  ) => ({
    client,
    logger: noopLogger,
    memoryIndex: "nonexistent/MEMORY.md",
    tasksDir: dir,
    background: new BackgroundState(),
    cron: new CronState(durable()),
    team,
  });

  it("routes a protocol response through a check_inbox tool call", async () => {
    const team = newTeam();
    requestShutdown(team, noopLogger, "alice");
    const reqId = firstRequestId(team);
    team.bus.readInbox("alice"); // 丢掉发给队友的请求，本用例只看响应
    team.bus.sendProtocol(
      "alice",
      "lead",
      "Shutting down gracefully.",
      "shutdown_response",
      { request_id: reqId, approve: true },
    );

    const client = fakeClient(
      fakeMessage([toolUseBlock("tu_1", "check_inbox", {})], "tool_use"),
      fakeMessage([textBlock("noted")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "any news?" },
    ];

    const result = await agentLoop(messages, ctx(), deps(team, client));

    expect(result).toBe("noted");
    expect(team.pendingRequests.get(reqId)?.status).toBe("approved");
    const toolResults = messages[2].content as Anthropic.ContentBlockParam[];
    const first = toolResults[0] as Anthropic.ToolResultBlockParam;
    expect(first.content).toContain(`req:${reqId}`);
  });

  it("sends a shutdown request through the request_shutdown tool", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "request_shutdown", { teammate: "alice" })],
        "tool_use",
      ),
      fakeMessage([textBlock("asked alice to stop")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "stop alice" },
    ];

    const result = await agentLoop(messages, ctx(), deps(team, client));

    expect(result).toBe("asked alice to stop");
    const [delivered] = team.bus.readInbox("alice");
    expect(delivered.type).toBe("shutdown_request");
    const reqId = String(delivered.metadata?.request_id);
    expect(team.pendingRequests.get(reqId)?.status).toBe("pending");
  });
});

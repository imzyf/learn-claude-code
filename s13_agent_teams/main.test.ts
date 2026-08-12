/**
 * s13_agent_teams/main.test.ts
 *
 * s13 的新增点是团队运行时，测试只聚焦这一层：
 *   - MessageBus：send / readInbox 往返 + 即读即消费、顺序、peek 非破坏、
 *     metadata 透传、waitForMessages 的唤醒与超时
 *   - owner 维度的 claimTask / completeTask：占用中不能再认领、非 owner 不能完成、
 *     计划闸门未放行不能完成、完成后汇报解除阻塞
 *   - assignment 与工作目录：无 assignment 回退仓库目录、worktree 绑定坏了 fail closed
 *   - 任务发现：scanUnclaimedTasks 过滤 + claimNextTask 原子认领
 *   - 协议：shutdown 与 plan_approval 的 request_id 关联、错配与过期审批被忽略
 *   - runTeammateTool：闸门拦住 bash / write_file，read_file 仍可用
 *   - spawnTeammateThread：重名 / 保留名 / 认领失败拒绝；队友跑完发 result +
 *     idle_notification 并转 IDLE；IDLE 自动认领任务板上的 ready task；关机握手退出
 *   - 工具集：Lead 带团队工具，队友工具集不含 create_task / spawn_teammate
 *   - agentLoop：工具调用端到端 + 团队事件注入
 * 任务存储本身（TaskStore / canStart）已在 s10 覆盖，这里不再重复。
 *
 * 队友的 run() 是游离 Promise，用 waitFor 轮询状态作为完成信号。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
import { TaskStore } from "../s10_task_system/main";
import {
  agentLoop,
  applyPlanResponse,
  assignmentCwd,
  claimNextTask,
  claimTask,
  completeTask,
  consumeLeadInbox,
  createWorktree,
  formatTeamEvents,
  MessageBus,
  makeTeamHandlers,
  runTeammateTool,
  scanUnclaimedTasks,
  spawnTeammateThread,
  submitPlan,
  TEAMMATE_TOOLS,
  TeamState,
  type TeamTask,
  TOOL_SCHEMAS,
  taskWorktreeCwd,
  tools,
  validateWorktreeName,
} from "./main";

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// 邮箱、任务板、worktree 目录都落在临时目录里；IDLE 扫描间隔调小，测试不用等 2s。
const newTeam = () =>
  new TeamState(
    new MessageBus(path.join(dir, ".mailboxes")),
    new TaskStore(path.join(dir, ".tasks")),
    path.join(dir, ".worktrees"),
    20,
  );

const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ── MessageBus ────────────────────────────────────────────
describe("MessageBus", () => {
  it("消息可往返传递并在读取时被消费", () => {
    const bus = new MessageBus(dir);
    bus.send("lead", "alice", "hello");
    expect(bus.peek("alice")).toBe(true);

    const msgs = bus.readInbox("alice");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: "lead",
      to: "alice",
      content: "hello",
      type: "message",
    });
    // 读取即消费：再读为空。
    expect(bus.readInbox("alice")).toHaveLength(0);
    expect(bus.peek("alice")).toBe(false);
  });

  it("保持顺序并携带协议元数据", () => {
    const bus = new MessageBus(dir);
    bus.send("a", "lead", "one");
    bus.send("b", "lead", "two", "shutdown_response", {
      request_id: "req_000001",
      approve: true,
    });
    const msgs = bus.readInbox("lead");
    expect(msgs.map((m) => m.content)).toEqual(["one", "two"]);
    expect(msgs[1].metadata).toEqual({
      request_id: "req_000001",
      approve: true,
    });
  });

  it("peek 不会消费消息且收件箱不存在时读取结果为空", () => {
    const bus = new MessageBus(dir);
    expect(bus.peek("nobody")).toBe(false);
    expect(bus.readInbox("nobody")).toEqual([]);

    bus.send("x", "lead", "hi");
    expect(bus.peek("lead")).toBe(true);
    expect(bus.peek("lead")).toBe(true); // 还在
    expect(bus.readInbox("lead")).toHaveLength(1);
  });

  it("waitForMessages 在发送消息时唤醒并在超时后返回空结果", async () => {
    const bus = new MessageBus(dir);
    const waiting = bus.waitForMessages("alice", 2000);
    bus.send("lead", "alice", "wake up");
    expect((await waiting).map((m) => m.content)).toEqual(["wake up"]);

    expect(await bus.waitForMessages("alice", 20)).toEqual([]);
  });
});

// ── 认领与完成 ─────────────────────────────────────────────
describe("claimTask / completeTask", () => {
  it("每位负责人只绑定一个任务并拒绝再次认领", () => {
    const team = newTeam();
    const first = team.tasks.create("config");
    const second = team.tasks.create("auth");

    expect(claimTask(team, first.id, "alice", noopLogger)).toContain("Claimed");
    expect(team.assignments.get("alice")).toMatchObject({ taskId: first.id });
    expect(claimTask(team, second.id, "alice", noopLogger)).toContain(
      "must finish the current work turn",
    );
    // 别人还是可以认领第二项。
    expect(claimTask(team, second.id, "bob", noopLogger)).toContain("Claimed");
  });

  it("拒绝认领已有负责人或被阻塞的任务", () => {
    const team = newTeam();
    const base = team.tasks.create("schema");
    const dependent = team.tasks.create("api", "", [base.id]);

    claimTask(team, base.id, "alice", noopLogger);
    expect(claimTask(team, base.id, "bob", noopLogger)).toContain(
      "is in_progress, cannot claim",
    );
    expect(claimTask(team, dependent.id, "bob", noopLogger)).toContain(
      `Blocked by: [${base.id}]`,
    );
  });

  it("仅允许负责人完成任务并报告解除阻塞的工作", () => {
    const team = newTeam();
    const base = team.tasks.create("schema");
    team.tasks.create("api", "", [base.id]);
    claimTask(team, base.id, "alice", noopLogger);

    expect(completeTask(team, base.id, "bob", noopLogger)).toContain(
      "is owned by alice",
    );
    const done = completeTask(team, base.id, "alice", noopLogger);
    expect(done).toContain("Completed");
    expect(done).toContain("Unblocked: api");
    // 完成不立刻收回目录 lease：本轮后续工具仍用同一个目录。
    expect(team.assignments.get("alice")).toMatchObject({ taskId: base.id });
  });

  it("计划仍受门禁限制时拒绝完成任务", () => {
    const team = newTeam();
    const task = team.tasks.create("auth");
    claimTask(team, task.id, "alice", noopLogger);
    team.planGates.set("alice", "pending");

    expect(completeTask(team, task.id, "alice", noopLogger)).toContain(
      "cannot complete while plan status is pending",
    );
    team.planGates.set("alice", "approved");
    expect(completeTask(team, task.id, "alice", noopLogger)).toContain(
      "Completed",
    );
  });
});

// ── assignment 的工作目录 ──────────────────────────────────
describe("assignmentCwd / worktree binding", () => {
  it("没有分配任务时回退到仓库目录", () => {
    const team = newTeam();
    expect(assignmentCwd(team, "agent")).toBe(process.cwd());

    const task = team.tasks.create("config");
    claimTask(team, task.id, "agent", noopLogger);
    expect(assignmentCwd(team, "agent")).toBe(process.cwd());
  });

  it("worktree 绑定未在 Git 中注册时以拒绝方式失败", () => {
    const team = newTeam();
    const bound: TeamTask = {
      ...team.tasks.create("auth"),
      worktree: "auth-refactor",
    };
    team.tasks.save(bound);

    expect(taskWorktreeCwd(team, bound).error).toContain(
      "not registered with Git",
    );
    expect(claimTask(team, bound.id, "alice", noopLogger)).toContain(
      "Cannot claim",
    );
    expect(team.assignments.has("alice")).toBe(false);
    // 绑定坏了的任务也不会出现在任务板扫描结果里。
    expect(scanUnclaimedTasks(team)).toHaveLength(0);
  });

  it("校验 worktree 名称并拒绝绑定已认领的任务", () => {
    const team = newTeam();
    expect(validateWorktreeName("auth-refactor")).toBeNull();
    expect(validateWorktreeName("../escape")).toContain("must be 1-64");
    expect(validateWorktreeName(".hidden")).toContain("must be 1-64");

    const task = team.tasks.create("auth");
    claimTask(team, task.id, "alice", noopLogger);
    expect(
      createWorktree(team, "auth-refactor", task.id, noopLogger),
    ).toContain("must be pending and unowned");
  });
});

// ── 任务发现 ───────────────────────────────────────────────
describe("scanUnclaimedTasks / claimNextTask", () => {
  it("只提供已就绪且没有负责人的任务", () => {
    const team = newTeam();
    const base = team.tasks.create("schema");
    team.tasks.create("api", "", [base.id]);
    const free = team.tasks.create("docs");
    claimTask(team, base.id, "alice", noopLogger);

    expect(scanUnclaimedTasks(team).map((t) => t.id)).toEqual([free.id]);
  });

  it("只认领第一个可用任务", () => {
    const team = newTeam();
    team.tasks.create("docs");
    team.tasks.create("tests");
    const firstAvailable = scanUnclaimedTasks(team)[0];

    expect(claimNextTask(team, "bob", noopLogger)?.id).toBe(firstAvailable.id);
    // 已有 assignment 的队友不再认领第二项。
    expect(claimNextTask(team, "bob", noopLogger)).toBeNull();
  });
});

// ── 协议 ───────────────────────────────────────────────────
describe("team protocols", () => {
  it("将关闭响应匹配回对应请求", () => {
    const team = newTeam();
    team.activeTeammates.set("alice", "working");
    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);
    const requested = handlers.request_shutdown?.({ teammate: "alice" }) ?? "";
    const requestId = requested.match(/req_\d{6}/)?.[0] ?? "";
    expect(requestId).not.toBe("");

    team.bus.readInbox("alice");
    team.bus.send(
      "alice",
      "lead",
      "Shutdown acknowledged.",
      "shutdown_response",
      {
        request_id: requestId,
        approve: true,
      },
    );
    consumeLeadInbox(team, noopLogger);
    expect(team.pendingRequests.get(requestId)?.status).toBe("approved");
  });

  it("批准计划并为提交计划的队友解除门禁", () => {
    const team = newTeam();
    team.activeTeammates.set("alice", "working");
    const task = team.tasks.create("auth");
    claimTask(team, task.id, "alice", noopLogger);

    const submitted = submitPlan(team, "alice", "step 1, step 2");
    const requestId = submitted.match(/req_\d{6}/)?.[0] ?? "";
    expect(team.gateOf("alice")).toBe("pending");
    expect(team.bus.readInbox("lead")[0].type).toBe("plan_approval_request");

    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);
    expect(
      handlers.review_plan?.({ request_id: requestId, approve: true }),
    ).toContain("Plan approved");

    const response = team.bus.readInbox("alice")[0];
    expect(applyPlanResponse(team, "alice", response).applied).toBe(true);
    expect(team.gateOf("alice")).toBe("approved");
  });

  it("忽略属于先前任务分配的计划响应", () => {
    const team = newTeam();
    team.activeTeammates.set("alice", "working");
    const task = team.tasks.create("auth");
    claimTask(team, task.id, "alice", noopLogger);
    const requestId =
      submitPlan(team, "alice", "plan").match(/req_\d{6}/)?.[0] ?? "";
    team.bus.readInbox("lead");

    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);
    // 队友换了任务：审批仍指向上一份 assignment。
    team.planGates.set("alice", "approved");
    completeTask(team, task.id, "alice", noopLogger);
    team.planGates.set("alice", "pending");
    team.assignments.delete("alice");
    expect(
      handlers.review_plan?.({ request_id: requestId, approve: true }),
    ).toContain("earlier assignment");

    // 直接伪造一条回复也不生效。
    const stale = {
      from: "lead",
      to: "alice",
      content: "ok",
      type: "plan_approval_response",
      ts: 0,
      metadata: { request_id: requestId, approve: true },
    };
    expect(applyPlanResponse(team, "alice", stale).notice).toContain(
      "request mismatch",
    );
  });
});

// ── 队友工具分发 ───────────────────────────────────────────
describe("runTeammateTool", () => {
  const block = (name: string, input: unknown) =>
    toolUseBlock("tu_1", name, input);

  it("计划获批前拦截修改类工具", () => {
    const team = newTeam();
    team.planGates.set("alice", "required");
    const handlers = { bash: () => "ran", read_file: () => "contents" };

    expect(
      runTeammateTool(
        team,
        "alice",
        block("bash", { command: "ls" }),
        handlers,
        noopLogger,
      ),
    ).toContain("Blocked: plan status is required");
    // 只读工具不受闸门限制。
    expect(
      runTeammateTool(
        team,
        "alice",
        block("read_file", { path: "a.txt" }),
        handlers,
        noopLogger,
      ),
    ).toBe("contents");

    team.planGates.set("alice", "approved");
    expect(
      runTeammateTool(
        team,
        "alice",
        block("bash", { command: "ls" }),
        handlers,
        noopLogger,
      ),
    ).toBe("ran");
  });

  it("返回权限错误而不是读取终端", () => {
    const team = newTeam();
    const handlers = { bash: () => "ran" };
    expect(
      runTeammateTool(
        team,
        "alice",
        block("bash", { command: "sudo rm x" }),
        handlers,
        noopLogger,
      ),
    ).toContain("Permission denied by deny list");
    expect(
      runTeammateTool(
        team,
        "alice",
        block("bash", { command: "rm notes.txt" }),
        handlers,
        noopLogger,
      ),
    ).toBe("Permission required: ask Lead to run this command.");
  });
});

// ── 队友运行时 ─────────────────────────────────────────────
describe("spawnTeammateThread", () => {
  it("拒绝重复、保留名称及无法认领任务的 spawn 请求", () => {
    const team = newTeam();
    team.activeTeammates.set("alice", "working");
    const client = fakeClient();

    expect(
      spawnTeammateThread(team, client, noopLogger, "alice", "dev", "x"),
    ).toContain("already exists");
    expect(
      spawnTeammateThread(team, client, noopLogger, "lead", "dev", "x"),
    ).toContain("reserved by the runtime");

    const task = team.tasks.create("auth");
    claimTask(team, task.id, "alice", noopLogger);
    expect(
      spawnTeammateThread(team, client, noopLogger, "bob", "dev", "x", task.id),
    ).toContain("Cannot spawn teammate 'bob'");
    expect(team.activeTeammates.has("bob")).toBe(false);
  });

  it("投递结果和 idle_notification 后按请求关闭", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage([textBlock("auth refactored")], "end_turn"),
    );

    const spawned = spawnTeammateThread(
      team,
      client,
      noopLogger,
      "alice",
      "dev",
      "refactor auth",
    );
    expect(spawned).toContain("spawned");
    await waitFor(() => team.activeTeammates.get("alice") === "idle");

    expect(team.bus.readInbox("lead").map((m) => [m.type, m.content])).toEqual([
      ["result", "auth refactored"],
      ["idle_notification", "Waiting for more work."],
    ]);

    makeTeamHandlers(team, client, noopLogger).request_shutdown?.({
      teammate: "alice",
    });
    await waitFor(() => !team.activeTeammates.has("alice"));
    expect(team.bus.readInbox("lead").map((m) => m.type)).toContain(
      "shutdown_response",
    );
  });

  it("空闲时从共享任务板认领已就绪任务", async () => {
    const team = newTeam();
    const task = team.tasks.create("write docs", "cover the API");
    const client = fakeClient(
      fakeMessage([textBlock("standing by")], "end_turn"),
      fakeMessage([textBlock("docs written")], "end_turn"),
    );

    spawnTeammateThread(
      team,
      client,
      noopLogger,
      "bob",
      "writer",
      "wait for work",
    );
    await waitFor(() => team.tasks.load(task.id).status === "in_progress");
    expect(team.tasks.load(task.id).owner).toBe("bob");

    await waitFor(() => team.activeTeammates.get("bob") === "idle");
    makeTeamHandlers(team, client, noopLogger).request_shutdown?.({
      teammate: "bob",
    });
    await waitFor(() => !team.activeTeammates.has("bob"));
    // 退出时把没完成的任务放回任务板。
    expect(team.tasks.load(task.id).status).toBe("pending");
    expect(team.tasks.load(task.id).owner).toBeNull();
  });

  it("通过队友工具循环运行分配的任务", async () => {
    const team = newTeam();
    const task = team.tasks.create("tests", "add regression tests");
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "complete_task", { task_id: task.id })],
        "tool_use",
      ),
      fakeMessage([textBlock("tests added")], "end_turn"),
    );

    spawnTeammateThread(
      team,
      client,
      noopLogger,
      "carol",
      "dev",
      "do it",
      task.id,
    );
    await waitFor(() => team.activeTeammates.get("carol") === "idle");

    expect(team.tasks.load(task.id).status).toBe("completed");
    // 回到 IDLE 时才释放目录 lease。
    expect(team.assignments.has("carol")).toBe(false);
    expect(team.bus.readInbox("lead").map((m) => m.type)).toEqual([
      "result",
      "idle_notification",
    ]);

    makeTeamHandlers(team, client, noopLogger).request_shutdown?.({
      teammate: "carol",
    });
    await waitFor(() => !team.activeTeammates.has("carol"));
  });
});

// ── Lead 团队 handler ──────────────────────────────────────
describe("makeTeamHandlers", () => {
  it("列出队友并拒绝向非活跃队友发送消息", () => {
    const team = newTeam();
    team.activeTeammates.set("bob", "idle");
    team.activeTeammates.set("alice", "working");
    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);

    expect(handlers.list_teammates?.({})).toBe("alice: working\nbob: idle");
    expect(handlers.send_message?.({ to: "dave", content: "hi" })).toBe(
      "Teammate 'dave' is not active",
    );
    expect(handlers.send_message?.({ to: "alice", content: "go" })).toBe(
      "Sent to alice",
    );
    expect(team.bus.readInbox("alice")[0]).toMatchObject({
      from: "lead",
      content: "go",
    });
  });

  it("request_plan 在工作区发生任何更改前关闭门禁", () => {
    const team = newTeam();
    team.activeTeammates.set("alice", "working");
    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);

    expect(
      handlers.request_plan?.({ teammate: "alice", task: "refactor auth" }),
    ).toContain("Plan requested");
    expect(team.gateOf("alice")).toBe("required");
    expect(team.bus.readInbox("alice")[0].type).toBe("plan_request");
  });
});

// ── 工具集 ─────────────────────────────────────────────────
describe("tool sets", () => {
  it("在 s10 工具上添加团队工具", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "bash", // s02
        "create_task", // s10
        "spawn_teammate",
        "list_teammates",
        "send_message",
        "request_shutdown",
        "request_plan",
        "review_plan",
        "create_worktree",
      ]),
    );
    // 收件箱的消费属于运行时，不给模型工具。
    expect(names).not.toContain("check_inbox");
  });

  it("队友工具集保持为负责人工具集的子集", () => {
    const names = TEAMMATE_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "bash",
        "claim_task",
        "complete_task",
        "send_message",
        "submit_plan",
      ]),
    );
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("spawn_teammate");
    expect(names).not.toContain("create_worktree");
  });

  it("schema 解析团队工具输入", () => {
    expect(
      TOOL_SCHEMAS.spawn_teammate?.parse({
        name: "alice",
        role: "dev",
        prompt: "p",
        task_id: "task_1a2b3c4d",
        require_plan: true,
      }),
    ).toMatchObject({ name: "alice", require_plan: true });
    expect(
      TOOL_SCHEMAS.review_plan?.parse({
        request_id: "req_000001",
        approve: false,
      }),
    ).toEqual({
      request_id: "req_000001",
      approve: false,
    });
  });
});

// ── agentLoop ─────────────────────────────────────────────
describe("agentLoop", () => {
  it("端到端运行负责人工具调用", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "create_task", { subject: "config" })],
        "tool_use",
      ),
      fakeMessage([textBlock("task created")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "plan the work" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      team,
    });

    expect(result).toBe("task created");
    expect(team.tasks.list().map((t) => t.subject)).toEqual(["config"]);
  });

  it("为下一轮格式化已消费的团队事件", () => {
    const team = newTeam();
    team.bus.send("alice", "lead", "auth done", "result");
    team.bus.send(
      "alice",
      "lead",
      "Waiting for more work.",
      "idle_notification",
    );

    const events = formatTeamEvents(consumeLeadInbox(team, noopLogger));
    expect(events).toBe(
      "[Team events]\n[result] alice: auth done\n" +
        "[idle_notification] alice: Waiting for more work.",
    );
  });
});

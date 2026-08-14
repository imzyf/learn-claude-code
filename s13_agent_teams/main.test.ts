/**
 * s15_agent_teams/main.test.ts
 *
 * s15 的新增点是 agent 团队层，测试只聚焦这一层：
 *   - MessageBus：send / readInbox 往返 + 即读即消费、追加顺序、peek 非破坏、空收件箱
 *   - hasPendingBackground：仅在有已完成的后台任务时为真
 *   - makeTeamHandlers：send_message（lead → 目标）、check_inbox（读取并消费）
 *   - spawnTeammateThread：重名拒绝、纯文本队友把结果发回 lead 并注销、
 *     队友中途 send_message + 最终小结都投递到 lead
 *   - tools 叠加后带团队工具，且 s14/s13/s12 的工具仍在
 *   - agentLoop：消费 cron 队列注入 [Scheduled]；check_inbox 端到端读到队友消息
 * 任务系统 / 后台任务 / cron / prompt 组装已在 s12 / s13 / s14 / s10 覆盖，这里不再重复。
 *
 * 队友的 run() 是游离 Promise，用 waitFor 轮询它注销自己作为完成信号（对齐 s13 后台测试）。
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
import type { Context } from "../s10_system_prompt/main";
import { BackgroundState } from "../s11_background_tasks/main";
import { CronState } from "../s12_cron_scheduler/main";
import {
  agentLoop,
  hasPendingBackground,
  MessageBus,
  makeTeamHandlers,
  spawnTeammateThread,
  TeamState,
  TOOL_SCHEMAS,
  tools,
} from "./main";

const ctx = (): Context => ({
  enabled_tools: ["bash"],
  workspace: "/repo",
  memories: "",
});

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const newTeam = () => new TeamState(new MessageBus(dir));
const durable = () => path.join(dir, ".scheduled_tasks.json");

// 队友的 run() 游离执行，轮询一个条件作为完成信号。
const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ── MessageBus ────────────────────────────────────────────
describe("MessageBus", () => {
  it("round-trips a message and consumes it on read", () => {
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

  it("appends multiple messages in order", () => {
    const bus = new MessageBus(dir);
    bus.send("a", "lead", "one");
    bus.send("b", "lead", "two");
    expect(bus.readInbox("lead").map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("peek is non-destructive and an absent inbox reads empty", () => {
    const bus = new MessageBus(dir);
    expect(bus.peek("nobody")).toBe(false);
    expect(bus.readInbox("nobody")).toEqual([]);

    bus.send("x", "lead", "hi");
    expect(bus.peek("lead")).toBe(true);
    expect(bus.peek("lead")).toBe(true); // 还在
    expect(bus.readInbox("lead")).toHaveLength(1);
  });
});

// ── hasPendingBackground ──────────────────────────────────
describe("hasPendingBackground", () => {
  it("is true only when a background task has completed", () => {
    const bg = new BackgroundState();
    expect(hasPendingBackground(bg)).toBe(false);

    bg.tasks.bg_1 = { toolCallId: "t", command: "ls", status: "running" };
    expect(hasPendingBackground(bg)).toBe(false);

    bg.tasks.bg_1.status = "completed";
    expect(hasPendingBackground(bg)).toBe(true);
  });
});

// ── makeTeamHandlers ──────────────────────────────────────
describe("makeTeamHandlers", () => {
  it("send_message posts from lead to the target", () => {
    const team = newTeam();
    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);
    expect(handlers.send_message?.({ to: "alice", content: "go" })).toBe(
      "Sent to alice",
    );
    expect(team.bus.readInbox("alice")[0]).toMatchObject({
      from: "lead",
      to: "alice",
      content: "go",
    });
  });

  it("check_inbox reads and consumes the lead's messages", () => {
    const team = newTeam();
    team.bus.send("alice", "lead", "result here");
    const handlers = makeTeamHandlers(team, fakeClient(), noopLogger);
    expect(handlers.check_inbox?.({})).toContain("[alice] result here");
    // 已消费：再读为空。
    expect(handlers.check_inbox?.({})).toBe("(inbox empty)");
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
  });

  it("runs a text-only teammate and delivers its result to lead", async () => {
    const team = newTeam();
    const client = fakeClient(fakeMessage([textBlock("all done")], "end_turn"));

    const msg = spawnTeammateThread(
      team,
      client,
      noopLogger,
      "alice",
      "dev",
      "x",
    );
    expect(msg).toContain("spawned");
    expect(team.activeTeammates.has("alice")).toBe(true);

    await waitFor(() => !team.activeTeammates.has("alice"));
    const inbox = team.bus.readInbox("lead");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "alice",
      to: "lead",
      content: "all done",
      type: "result",
    });
  });

  it("delivers a mid-run send_message and the final summary", async () => {
    const team = newTeam();
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "send_message", {
            to: "lead",
            content: "progress",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("final summary")], "end_turn"),
    );

    spawnTeammateThread(team, client, noopLogger, "bob", "dev", "y");
    await waitFor(() => !team.activeTeammates.has("bob"));

    expect(team.bus.readInbox("lead").map((m) => m.content)).toEqual([
      "progress",
      "final summary",
    ]);
  });
});

// ── 工具叠加：团队工具 + s14/s13/s12 的工具仍在 ────────────
describe("tools override", () => {
  it("adds team tools on top of the s14/s13/s12 tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("spawn_teammate");
    expect(names).toContain("send_message");
    expect(names).toContain("check_inbox");
    expect(names).toContain("schedule_cron"); // s14
    expect(names).toContain("bash"); // s13 / s02
    expect(names).toContain("create_task"); // s12
  });

  it("schema parses team tool inputs", () => {
    expect(
      TOOL_SCHEMAS.spawn_teammate?.parse({
        name: "a",
        role: "dev",
        prompt: "p",
      }),
    ).toMatchObject({ name: "a", role: "dev", prompt: "p" });
    expect(TOOL_SCHEMAS.check_inbox?.parse({})).toEqual({});
  });
});

// ── agentLoop：cron 注入 + check_inbox 端到端 ──────────────
describe("agentLoop", () => {
  it("consumes the cron queue and injects a [Scheduled] message", async () => {
    const cron = new CronState(durable());
    cron.cronQueue.push({
      id: "c1",
      cron: "0 9 * * *",
      prompt: "do the thing",
      recurring: true,
      durable: false,
    });
    const client = fakeClient(fakeMessage([textBlock("handled")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex: "nonexistent/MEMORY.md",
      tasksDir: dir,
      background: new BackgroundState(),
      cron,
      team: newTeam(),
    });

    expect(result).toBe("handled");
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Scheduled] do the thing",
    });
  });

  it("reads a teammate message through a check_inbox tool call", async () => {
    const team = newTeam();
    team.bus.send("alice", "lead", "teammate says hi");
    const client = fakeClient(
      fakeMessage([toolUseBlock("tu_1", "check_inbox", {})], "tool_use"),
      fakeMessage([textBlock("got it")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "any news?" },
    ];

    const result = await agentLoop(messages, ctx(), {
      client,
      logger: noopLogger,
      memoryIndex: "nonexistent/MEMORY.md",
      tasksDir: dir,
      background: new BackgroundState(),
      cron: new CronState(durable()),
      team,
    });

    expect(result).toBe("got it");
    const toolResults = messages[2].content as Anthropic.ContentBlockParam[];
    const first = toolResults[0] as Anthropic.ToolResultBlockParam;
    expect(first.content).toContain("[alice] teammate says hi");
  });
});

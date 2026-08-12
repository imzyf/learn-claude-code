/**
 * s12_cron_scheduler/main.test.ts
 *
 * s12 的新增点是 cron 调度器层，测试只聚焦这一层：
 *   - runCronTick 匹配语义：字段匹配（*、步长、逗号、区间）与 DOM/DOW 的 OR
 *   - scheduleJob / cancelJob：注册/移除、非法表达式与空 prompt 拒绝、durable 落盘
 *   - saveDurableJobs / loadDurableJobs：往返，跳过非法任务，pendingDelivery 重新入队
 *   - runCronTick：命中入队、同分钟去重、未销账前不重复入队
 *   - acknowledgeCronJobs / restoreCronJobs：一次性任务销账后移除、失败后回队列
 *   - tools 叠加后仍带 cron 工具，s02 的基础工具仍在
 *   - agentLoop：消费 cron 队列注入 [Scheduled]、失败撤回、成功销账；
 *     schedule_cron 端到端注册一条任务
 * 工具层与 hook 层已在 s02 / s03 / s04 覆盖，这里不再重复。
 *
 * 日期锚点（确定性）：2026-01-01 是周四 -> 2026-03-01 周日、03-03 周二、03-04 周三。
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
import {
  acknowledgeCronJobs,
  agentLoop,
  type CronJob,
  CronState,
  cancelJob,
  consumeCronQueue,
  type Deps,
  hasCronQueue,
  loadDurableJobs,
  restoreCronJobs,
  runCronTick,
  scheduleJob,
  TOOL_SCHEMAS,
  tools,
} from "./main";

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const durable = () => path.join(dir, ".scheduled_tasks.json");

// agentLoop 的 deps：hook 注册表留空，测试只关心 cron 这一层。
const deps = (client: Deps["client"], cron: CronState): Deps => ({
  client,
  logger: noopLogger,
  hooks: createHooks(noopLogger),
  cron,
});

const makeJob = (over: Partial<CronJob> = {}): CronJob => ({
  id: "cron_test",
  cron: "0 9 * * *",
  prompt: "standup",
  recurring: true,
  durable: false,
  pendingDelivery: false,
  lastFired: null,
  ...over,
});

// ── cron 匹配（内联进 runCronTick）+ DOM/DOW OR 语义 ─────────
// cronMatches 已内联进 runCronTick：建一个任务、在给定时刻 tick 一次，
// 看它是否进 cronQueue，即等价于「该时刻是否命中」。
const fires = (cron: string, at: Date): boolean => {
  const state = new CronState(durable());
  state.scheduledJobs.set("j", makeJob({ id: "j", cron }));
  runCronTick(state, at, noopLogger);
  return state.cronQueue.length > 0;
};

describe("runCronTick 匹配语义", () => {
  it("匹配分钟和小时的通配符及精确值", () => {
    expect(fires("0 9 * * *", new Date(2026, 2, 1, 9, 0))).toBe(true);
    expect(fires("0 9 * * *", new Date(2026, 2, 1, 9, 1))).toBe(false);
    expect(fires("0 9 * * *", new Date(2026, 2, 1, 10, 0))).toBe(false);
  });

  it("匹配步长、列表和范围字段", () => {
    expect(fires("*/15 * * * *", new Date(2026, 2, 1, 9, 30))).toBe(true);
    expect(fires("*/15 * * * *", new Date(2026, 2, 1, 9, 31))).toBe(false);
    expect(fires("0,30 9 * * *", new Date(2026, 2, 1, 9, 30))).toBe(true);
    expect(fires("0 9-17 * * *", new Date(2026, 2, 1, 17, 0))).toBe(true);
    expect(fires("0 9-17 * * *", new Date(2026, 2, 1, 18, 0))).toBe(false);
  });

  it("拒绝格式错误的表达式", () => {
    expect(fires("0 9 * *", new Date(2026, 2, 1, 9, 0))).toBe(false);
  });

  it("DOM 和 DOW 都受限时使用 OR 逻辑", () => {
    // dom=1, dow=Tuesday(2). 03-01 是周日但 DOM=1 → 命中；03-03 是周二但 DOM≠1 → 命中。
    const cron = "0 9 1 * 2";
    expect(fires(cron, new Date(2026, 2, 1, 9, 0))).toBe(true); // DOM 命中
    expect(fires(cron, new Date(2026, 2, 3, 9, 0))).toBe(true); // DOW 命中
    expect(fires(cron, new Date(2026, 2, 4, 9, 0))).toBe(false); // 都不命中
  });

  it("仅有一项受限时单独匹配 DOM 或 DOW", () => {
    expect(fires("0 9 1 * *", new Date(2026, 2, 1, 9, 0))).toBe(true);
    expect(fires("0 9 1 * *", new Date(2026, 2, 3, 9, 0))).toBe(false);
    expect(fires("0 9 * * 0", new Date(2026, 2, 1, 9, 0))).toBe(true); // 周日
    expect(fires("0 9 * * 0", new Date(2026, 2, 3, 9, 0))).toBe(false);
  });
});

// ── scheduleJob / cancelJob ───────────────────────────────
describe("scheduleJob / cancelJob", () => {
  it("注册有效任务并持久化耐久任务", () => {
    const state = new CronState(durable());
    const job = scheduleJob(state, "0 9 * * *", "hi", true, true, noopLogger);
    expect(typeof job).not.toBe("string");
    expect(state.scheduledJobs.size).toBe(1);
    expect(fs.existsSync(durable())).toBe(true);
  });

  it("不持久化仅限会话的任务", () => {
    const state = new CronState(durable());
    scheduleJob(state, "0 9 * * *", "durable one", true, true, noopLogger);
    scheduleJob(state, "0 10 * * *", "session one", true, false, noopLogger);
    const saved = JSON.parse(fs.readFileSync(durable(), "utf8")) as CronJob[];
    expect(saved).toHaveLength(1);
    expect(saved[0].prompt).toBe("durable one");
  });

  it("拒绝无效的 cron 表达式", () => {
    const state = new CronState(durable());
    const err = scheduleJob(state, "bad", "x", true, false, noopLogger);
    expect(typeof err).toBe("string");
    expect(state.scheduledJobs.size).toBe(0);
  });

  it("拒绝空提示词", () => {
    const state = new CronState(durable());
    const err = scheduleJob(state, "0 9 * * *", "  ", true, false, noopLogger);
    expect(err).toBe("Prompt cannot be empty");
    expect(state.scheduledJobs.size).toBe(0);
  });

  it("取消任务并报告不存在的任务", () => {
    const state = new CronState(durable());
    const job = scheduleJob(
      state,
      "0 9 * * *",
      "hi",
      true,
      true,
      noopLogger,
    ) as CronJob;
    expect(cancelJob(state, job.id, noopLogger)).toContain("Cancelled");
    expect(state.scheduledJobs.has(job.id)).toBe(false);
    expect(cancelJob(state, "nope", noopLogger)).toContain("not found");
  });
});

// ── 持久化往返 ────────────────────────────────────────────
describe("loadDurableJobs", () => {
  it("耐久任务可往返读写并跳过无效任务", () => {
    const good = makeJob({ id: "cron_a", durable: true });
    const bad = makeJob({ id: "cron_b", cron: "99 9 * * *", durable: true });
    fs.writeFileSync(durable(), JSON.stringify([good, bad]));

    const state = new CronState(durable());
    loadDurableJobs(state, noopLogger);
    expect(state.scheduledJobs.has("cron_a")).toBe(true);
    expect(state.scheduledJobs.has("cron_b")).toBe(false);
  });

  it("重新入队仍待投递的任务", () => {
    const pending = makeJob({
      id: "cron_p",
      durable: true,
      pendingDelivery: true,
    });
    fs.writeFileSync(durable(), JSON.stringify([pending]));

    const state = new CronState(durable());
    loadDurableJobs(state, noopLogger);
    expect(state.cronQueue.map((j) => j.id)).toEqual(["cron_p"]);
  });

  it("跳过 ID 无效或提示词为空的任务", () => {
    const badId = makeJob({ id: "job_a", durable: true });
    const noPrompt = makeJob({ id: "cron_b", prompt: "  ", durable: true });
    fs.writeFileSync(durable(), JSON.stringify([badId, noPrompt]));

    const state = new CronState(durable());
    loadDurableJobs(state, noopLogger);
    expect(state.scheduledJobs.size).toBe(0);
  });

  it("耐久文件不存在时不执行任何操作", () => {
    const state = new CronState(durable());
    loadDurableJobs(state, noopLogger);
    expect(state.scheduledJobs.size).toBe(0);
  });
});

// ── runCronTick：入队 / 去重 / 一次性 / 周期 ─────────────────
describe("runCronTick", () => {
  const at9 = () => new Date(2026, 2, 1, 9, 0);

  it("将匹配的任务入队并在同一分钟内去重", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set("cron_1", makeJob({ id: "cron_1" }));

    runCronTick(state, at9(), noopLogger);
    expect(consumeCronQueue(state)).toHaveLength(1);

    // 同一分钟再 tick 不应重复触发。
    runCronTick(state, at9(), noopLogger);
    expect(hasCronQueue(state)).toBe(false);
  });

  it("不将不匹配的任务入队", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set("cron_1", makeJob({ id: "cron_1" }));
    runCronTick(state, new Date(2026, 2, 1, 10, 0), noopLogger);
    expect(hasCronQueue(state)).toBe(false);
  });

  it("一次性任务在确认前保持注册状态", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set(
      "cron_once",
      makeJob({ id: "cron_once", recurring: false }),
    );
    state.scheduledJobs.set(
      "cron_loop",
      makeJob({ id: "cron_loop", recurring: true }),
    );

    runCronTick(state, at9(), noopLogger);
    expect(state.scheduledJobs.has("cron_once")).toBe(true);
    expect(consumeCronQueue(state)).toHaveLength(2);
  });

  it("不重复入队仍待投递的任务", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set("cron_1", makeJob({ id: "cron_1" }));

    runCronTick(state, at9(), noopLogger);
    expect(consumeCronQueue(state)).toHaveLength(1);
    // 下一分钟又命中，但上一条还没销账 → 不重复入队。
    runCronTick(state, new Date(2026, 2, 2, 9, 0), noopLogger);
    expect(hasCronQueue(state)).toBe(false);
  });
});

// ── 至少一次交付：销账 / 回滚 ────────────────────────────────
describe("acknowledgeCronJobs / restoreCronJobs", () => {
  const at9 = () => new Date(2026, 2, 1, 9, 0);

  it("删除一次性任务并清除周期任务的 pendingDelivery", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set(
      "cron_once",
      makeJob({ id: "cron_once", recurring: false }),
    );
    state.scheduledJobs.set(
      "cron_loop",
      makeJob({ id: "cron_loop", recurring: true }),
    );
    runCronTick(state, at9(), noopLogger);
    const fired = consumeCronQueue(state);

    acknowledgeCronJobs(state, fired);
    expect(state.scheduledJobs.has("cron_once")).toBe(false);
    expect(state.scheduledJobs.get("cron_loop")?.pendingDelivery).toBe(false);
  });

  it("恢复时将已投递任务放回队列", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set("cron_1", makeJob({ id: "cron_1" }));
    runCronTick(state, at9(), noopLogger);
    const fired = consumeCronQueue(state);

    restoreCronJobs(state, fired);
    expect(state.cronQueue.map((j) => j.id)).toEqual(["cron_1"]);
    expect(state.scheduledJobs.get("cron_1")?.pendingDelivery).toBe(true);
  });

  it("忽略执行期间被取消的任务", () => {
    const state = new CronState(durable());
    state.scheduledJobs.set("cron_1", makeJob({ id: "cron_1" }));
    runCronTick(state, at9(), noopLogger);
    const fired = consumeCronQueue(state);
    cancelJob(state, "cron_1", noopLogger);

    acknowledgeCronJobs(state, fired);
    restoreCronJobs(state, fired);
    expect(state.scheduledJobs.size).toBe(0);
    expect(hasCronQueue(state)).toBe(false);
  });
});

// ── 工具叠加：cron 工具 + s02 的基础工具仍在 ─────────────────
describe("tools", () => {
  it("在 s02 基础工具上添加 cron 工具", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("schedule_cron");
    expect(names).toContain("list_crons");
    expect(names).toContain("cancel_cron");
    expect(names).toContain("bash"); // s02
    expect(names).toContain("read_file"); // s02
  });

  it("schedule_cron schema 解析必填字段", () => {
    expect(
      TOOL_SCHEMAS.schedule_cron?.parse({ cron: "0 9 * * *", prompt: "x" }),
    ).toMatchObject({ cron: "0 9 * * *", prompt: "x" });
  });
});

// ── agentLoop：cron 注入 + schedule_cron 端到端 ─────────────
describe("agentLoop", () => {
  it("消费 cron 队列并注入 [Scheduled] 消息", async () => {
    const cron = new CronState(durable());
    cron.cronQueue.push(makeJob({ id: "cron_x", prompt: "do the thing" }));
    const client = fakeClient(fakeMessage([textBlock("handled")], "end_turn"));
    const messages: Anthropic.MessageParam[] = [];

    const result = await agentLoop(messages, deps(client, cron));

    expect(result).toBe("handled");
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Scheduled] do the thing",
    });
    expect(hasCronQueue(cron)).toBe(false);
  });

  it("模型出错时回滚注入并重新入队", async () => {
    const cron = new CronState(durable());
    const job = makeJob({ id: "cron_x", pendingDelivery: true });
    cron.scheduledJobs.set(job.id, job);
    cron.cronQueue.push(job);
    // 没有预置响应的 fakeClient 会直接抛错。
    const client = fakeClient();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];

    const result = await agentLoop(messages, deps(client, cron));

    expect(result).toContain("[Error]");
    expect(messages).toHaveLength(1); // 注入的 [Scheduled] 已撤回
    expect(cron.cronQueue.map((j) => j.id)).toEqual(["cron_x"]);
  });

  it("模型响应后确认已投递的任务", async () => {
    const cron = new CronState(durable());
    const once = makeJob({ id: "cron_once", recurring: false });
    cron.scheduledJobs.set(once.id, once);
    cron.cronQueue.push(once);
    const client = fakeClient(fakeMessage([textBlock("done")], "end_turn"));

    await agentLoop([], deps(client, cron));

    expect(cron.scheduledJobs.has("cron_once")).toBe(false);
  });

  it("通过 schedule_cron 工具调用注册任务", async () => {
    const cron = new CronState(durable());
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "schedule_cron", {
            cron: "0 9 * * *",
            prompt: "daily standup",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("scheduled it")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "schedule standup" },
    ];

    const result = await agentLoop(messages, deps(client, cron));

    expect(result).toBe("scheduled it");
    expect(cron.scheduledJobs.size).toBe(1);
    const toolResults = messages[2].content as Anthropic.ContentBlockParam[];
    const first = toolResults[0] as Anthropic.ToolResultBlockParam;
    expect(first.content).toContain("Scheduled");
  });
});

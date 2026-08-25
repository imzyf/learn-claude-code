/**
 * s16_workflow_runtime/main.test.ts
 *
 * 覆盖 s16 新增的 workflow 这一层：
 *   - 启动前的校验：元数据、权限、模型可见的工具 schema
 *   - agent({schema}) 的最小 JSON Schema 校验与一次重试
 *   - 编排原语：并发上限、parallel 等齐、pipeline 不等齐、嵌套一层
 *   - journal：key 与并发顺序无关、resume 命中缓存、坏记录拒绝续跑
 *   - 运行生命周期：事件流、产物落盘、失败收尾、同一次运行不能并发
 *   - 接进 s15 主循环后 Workflow 作为普通工具被调用
 * 子 agent 一律走注入的 AgentRunner，不碰真实 API。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../lib/model";
import {
  fakeMessage,
  makeTempDir,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
import { BackgroundManager } from "../s11_background_tasks/main";
import { createCronState } from "../s12_cron_scheduler/main";
import { createTeamState } from "../s13_agent_teams/main";
import { createMcpState } from "../s14_mcp_plugin/main";
import { agentLoop, BUILTIN_TOOLS } from "../s15_integrated_harness/main";
import {
  type AgentRunner,
  AnthropicAgentRunner,
  Budget,
  CONCURRENCY,
  callWorkflow,
  checkPermission,
  createWorkflowRuntime,
  type ExecutionState,
  FINDINGS_SCHEMA,
  type JsonSchema,
  MockAgentRunner,
  parseRunnerJson,
  RUNTIME_DIR,
  readLastRun,
  runWorkflow,
  SAMPLE_META,
  validateJson,
  validateMeta,
  WORKFLOW_TOOL,
  type WorkflowArgs,
  WorkflowInputError,
  WorkflowJournal,
  type WorkflowMeta,
  type WorkflowRuntime,
  type WorkflowScript,
  workflowToolPool,
} from "./main";

let dir = "";
beforeEach(() => {
  dir = makeTempDir(import.meta.dirname);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// runner 固定回声，方便断言「跑了几次、跑的是什么」。
function echoRunner(onRun?: (prompt: string) => void): AgentRunner {
  return {
    async run(prompt) {
      onRun?.(prompt);
      return { value: `v:${prompt}`, tokens: 4 };
    },
  };
}

function makeRuntime(
  options: Partial<
    Pick<WorkflowRuntime, "workflows" | "createRunner" | "deny">
  > = {},
): WorkflowRuntime {
  return createWorkflowRuntime(dir, { logger: noopLogger, ...options });
}

const TEST_META: WorkflowMeta = { name: "test-flow", description: "for tests" };

async function runScript(
  script: WorkflowScript,
  options: {
    runtime?: WorkflowRuntime;
    args?: WorkflowArgs | null;
    resumeFromRunId?: string;
    meta?: WorkflowMeta;
  } = {},
) {
  return callWorkflow(
    options.runtime ?? makeRuntime(),
    options.meta ?? TEST_META,
    script,
    { args: options.args ?? {}, resumeFromRunId: options.resumeFromRunId },
  );
}

// ── 启动前的校验 ──────────────────────────────────────────
describe("元数据与权限", () => {
  it("name / description 必填，name 必须是安全 slug", () => {
    expect(validateMeta({ name: "review-changes", description: "d" })).toEqual({
      name: "review-changes",
      description: "d",
    });
    expect(() => validateMeta("nope")).toThrow("object literal");
    expect(() => validateMeta({ name: "a" })).toThrow(
      "requires `name` and `description`",
    );
    expect(() => validateMeta({ name: "../escape", description: "d" })).toThrow(
      "meta.name must be a 1-64 character slug",
    );
    expect(() =>
      validateMeta({ name: "a", description: "d", phases: ["ok", ""] }),
    ).toThrow("non-empty strings");
  });

  it("deny 名单在启动前拦下 workflow", () => {
    expect(checkPermission(TEST_META)).toBe("allow");
    expect(() => checkPermission(TEST_META, ["test-flow"])).toThrow(
      "denied by settings",
    );
  });

  it("模型可见的输入只有 name / args / resume_from_run_id", () => {
    const schema = WORKFLOW_TOOL.input_schema as unknown as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "args",
      "name",
      "resume_from_run_id",
    ]);
    expect(schema.required).toEqual(["name"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

// ── 结构化输出 ────────────────────────────────────────────
describe("validateJson", () => {
  it("检查 required、enum、类型和数组元素", () => {
    expect(validateJson({ findings: [] }, FINDINGS_SCHEMA)).toBeNull();
    expect(validateJson({}, FINDINGS_SCHEMA)).toBe(
      "missing required key 'findings'",
    );
    expect(validateJson({ findings: {} }, FINDINGS_SCHEMA)).toBe(
      "findings: expected array",
    );
    expect(
      validateJson(
        { findings: [{ title: "t", severity: "critical" }] },
        FINDINGS_SCHEMA,
      ),
    ).toBe('findings: [0]: severity: expected one of ["high","medium","low"]');
    const numeric: JsonSchema = { type: "number" };
    expect(validateJson(true, numeric)).toBe("expected number");
  });

  it("MockAgentRunner 的输出确定且满足 schema", async () => {
    const runner = new MockAgentRunner();
    const first = await runner.run("audit x", FINDINGS_SCHEMA, "audit:x");
    const second = await runner.run("audit x", FINDINGS_SCHEMA, "audit:x");
    expect(first.value).toEqual(second.value);
    expect(validateJson(first.value, FINDINGS_SCHEMA)).toBeNull();
    expect(first.tokens).toBeGreaterThan(0);
  });

  it("真实 runner 从围栏或散文里取出那一个 JSON 对象", async () => {
    expect(parseRunnerJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseRunnerJson('前言 {"a": {"b": "}"}} 后语')).toEqual({
      a: { b: "}" },
    });
    expect(parseRunnerJson("没有 JSON")).toBeNull();

    const create = vi.fn(
      async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        expect(params.max_tokens).toBe(2000);
        return fakeMessage(
          [textBlock('{"isReal": true, "reason": "ok"}')],
          "end_turn",
        );
      },
    );
    const client: ModelClient = { messages: { create } };
    const out = await new AnthropicAgentRunner(client, "m").run(
      "verify",
      { type: "object" },
      "verify",
    );
    expect(out.value).toEqual({ isReal: true, reason: "ok" });
    expect(create).toHaveBeenCalledOnce();
  });
});

// ── 预算 ──────────────────────────────────────────────────
describe("Budget", () => {
  it("超出总额时报错，不静默超支", () => {
    const budget = new Budget(10);
    budget.add(6);
    expect(budget.remaining()).toBe(4);
    expect(() => budget.add(5)).toThrow("token budget exceeded");
    expect(budget.spent()).toBe(6);
    expect(new Budget().remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("args.budget 用尽后 agent() 直接失败，workflow 记为 failed", async () => {
    const out = await runScript(
      async (ctx) => {
        await ctx.agent("first", { label: "a" });
        await ctx.agent("second", { label: "b" });
        return "unreachable";
      },
      {
        runtime: makeRuntime({ createRunner: () => echoRunner() }),
        args: { budget: 5 },
      },
    );
    expect(out.task.status).toBe("failed");
    expect(out.result).toEqual({
      error: expect.stringContaining("token budget exceeded"),
    });
  });
});

// ── 编排原语 ──────────────────────────────────────────────
describe("编排原语", () => {
  it("phase 是 upsert，log 与 agent 都进 progress 流", async () => {
    const out = await runScript(
      async (ctx) => {
        ctx.phase("Review");
        ctx.phase("Review");
        await ctx.agent("x", { label: "step" });
        ctx.log("done");
        return "ok";
      },
      { runtime: makeRuntime({ createRunner: () => echoRunner() }) },
    );
    expect(out.task.progress).toEqual([
      { type: "workflow_phase", title: "Review" },
      {
        type: "workflow_agent",
        label: "step",
        phase: "Review",
        status: "done",
      },
      { type: "workflow_log", message: "done" },
    ]);
  });

  it("schema 不合法时重试一次，第二次仍不合法就让 workflow 失败", async () => {
    const prompts: string[] = [];
    let attempt = 0;
    const runner: AgentRunner = {
      async run(prompt) {
        prompts.push(prompt);
        attempt += 1;
        return attempt === 1
          ? { value: "散文", tokens: 1 }
          : { value: { findings: [] }, tokens: 1 };
      },
    };
    const good = await runScript(
      async (ctx) => ctx.agent("audit", { schema: FINDINGS_SCHEMA }),
      { runtime: makeRuntime({ createRunner: () => runner }) },
    );
    expect(good.result).toEqual({ findings: [] });
    expect(prompts[1]).toContain("Return valid JSON.");

    const bad = await runScript(
      async (ctx) => ctx.agent("audit", { schema: FINDINGS_SCHEMA }),
      {
        runtime: makeRuntime({
          createRunner: () => ({
            async run() {
              return { value: "散文", tokens: 1 };
            },
          }),
        }),
      },
    );
    expect(bad.task.status).toBe("failed");
    expect(bad.result).toEqual({
      error: expect.stringContaining("agent({schema}) invalid output"),
    });
  });

  it("并发的 agent() 受 CONCURRENCY 限制", async () => {
    let inflight = 0;
    let peak = 0;
    const runner: AgentRunner = {
      async run(prompt) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(2);
        inflight -= 1;
        return { value: prompt, tokens: 1 };
      },
    };
    const out = await runScript(
      async (ctx) =>
        ctx.parallel(
          Array.from(
            { length: CONCURRENCY * 3 },
            (_, i) => () => ctx.agent(`p${i}`, { label: `a${i}` }),
          ),
        ),
      { runtime: makeRuntime({ createRunner: () => runner }) },
    );
    expect((out.result as string[]).length).toBe(CONCURRENCY * 3);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("parallel 等齐后按入参顺序返回结果", async () => {
    const out = await runScript(async (ctx) =>
      ctx.parallel([
        async () => {
          await sleep(10);
          return "slow";
        },
        async () => "fast",
      ]),
    );
    expect(out.result).toEqual(["slow", "fast"]);
  });

  it("pipeline 的 stage 之间没有屏障", async () => {
    const order: string[] = [];
    const out = await runScript(async (ctx) =>
      ctx.pipeline(
        ["slow", "fast"],
        async (value: string, item: string) => {
          if (item === "slow") await sleep(10);
          order.push(`s1:${item}`);
          return value;
        },
        async (value: string, item: string, index: number) => {
          order.push(`s2:${item}`);
          return `${value}@${index}`;
        },
      ),
    );
    // fast 已经走完第 2 阶段时，slow 还卡在第 1 阶段。
    expect(order).toEqual(["s1:fast", "s2:fast", "s1:slow", "s2:slow"]);
    expect(out.result).toEqual(["slow@0", "fast@1"]);
  });

  it("workflow() 只允许嵌套一层，共享同一份 journal 与用量", async () => {
    const child: WorkflowScript = async (ctx: ExecutionState, args) =>
      ctx.agent(`child:${args.tag}`, { label: "child" });
    const runtime = makeRuntime({
      createRunner: () => echoRunner(),
      workflows: {
        child: { meta: { name: "child", description: "c" }, script: child },
        deep: {
          meta: { name: "deep", description: "d" },
          script: async (ctx) => ctx.workflow("child"),
        },
      },
    });

    const ok = await runScript(
      async (ctx) => ctx.workflow("child", { tag: 1 }),
      {
        runtime,
      },
    );
    expect(ok.result).toBe("v:child:1");
    expect(ok.task.usage.agents).toBe(1);

    const tooDeep = await runScript(async (ctx) => ctx.workflow("deep"), {
      runtime,
    });
    expect(tooDeep.result).toEqual({
      error: expect.stringContaining("nesting is one level only"),
    });

    const unknown = await runScript(async (ctx) => ctx.workflow("nope"), {
      runtime,
    });
    expect(unknown.result).toEqual({
      error: expect.stringContaining("unknown workflow 'nope'"),
    });
  });
});

// ── journal 与 resume ─────────────────────────────────────
describe("journal 与 resume", () => {
  it("key 由调用内容决定，与并发完成顺序无关", () => {
    const journal = new WorkflowJournal(dir, "wf_x_0123456789abcdef", false);
    const key = journal.key("agent", "audit", "p", FINDINGS_SCHEMA);
    expect(journal.key("agent", "audit", "p", FINDINGS_SCHEMA)).toBe(key);
    expect(journal.key("agent", "verify", "p", FINDINGS_SCHEMA)).not.toBe(key);
    expect(journal.key("agent", "audit", "p")).not.toBe(key);
    expect(key).toMatch(/^agent-\d{10}$/);
    journal.record(key, { findings: [] });
    journal.close();

    const reopened = new WorkflowJournal(dir, "wf_x_0123456789abcdef", true);
    expect(reopened.has(key)).toBe(true);
    expect(reopened.get(key)).toEqual({ findings: [] });
    reopened.close();
  });

  it("journal 缺失或有坏记录时拒绝续跑", () => {
    expect(
      () => new WorkflowJournal(dir, "wf_x_00000000000000ff", true),
    ).toThrow("resume journal not found");
    fs.writeFileSync(
      path.join(dir, "wf_x_00000000000000ff.journal.jsonl"),
      '{"key":"a","value":1}\nnot json\n',
    );
    expect(
      () => new WorkflowJournal(dir, "wf_x_00000000000000ff", true),
    ).toThrow("invalid resume journal record at line 2");
  });

  it("resume 时未改动的 agent() 命中缓存，不再调用 runner", async () => {
    let calls = 0;
    const runtime = makeRuntime({
      createRunner: () => echoRunner(() => (calls += 1)),
    });
    const script: WorkflowScript = async (ctx) =>
      ctx.agent("hello", { label: "greet" });

    const first = await runScript(script, { runtime });
    expect([calls, first.result]).toEqual([1, "v:hello"]);

    const second = await runScript(script, {
      runtime,
      args: null,
      resumeFromRunId: first.task.runId,
    });
    expect(calls).toBe(1);
    expect(second.result).toBe("v:hello");
    // 全部命中缓存：这一次没有新的 agent 与 token 开销。
    expect(second.task.usage).toEqual({ agents: 0, tokens: 0 });
    expect(second.task.progress).toEqual([
      {
        type: "workflow_agent",
        label: "greet",
        phase: null,
        status: "cached",
      },
    ]);
  });

  it("resume 的 runId、workflow 名与参数都要对得上", async () => {
    const runtime = makeRuntime({ createRunner: () => echoRunner() });
    const script: WorkflowScript = async (ctx) => ctx.agent("hello");
    const first = await runScript(script, { runtime, args: { tag: 1 } });

    await expect(
      runScript(script, {
        runtime,
        args: { tag: 2 },
        resumeFromRunId: first.task.runId,
      }),
    ).rejects.toThrow("resume args do not match");
    await expect(
      runScript(script, {
        runtime,
        meta: { name: "other-flow", description: "d" },
        resumeFromRunId: first.task.runId,
      }),
    ).rejects.toThrow("does not match workflow meta");
    await expect(
      runScript(script, { runtime, resumeFromRunId: "not-a-run-id" }),
    ).rejects.toThrow(WorkflowInputError);
  });
});

// ── 运行生命周期 ──────────────────────────────────────────
describe("运行生命周期", () => {
  it("产出 runId / taskId、快照、输出与 journal", async () => {
    const runtime = makeRuntime({ createRunner: () => echoRunner() });
    const out = await runScript(async (ctx) => ctx.agent("x"), {
      runtime,
      args: { tag: 1 },
    });
    const runId = out.task.runId;

    expect(out.launched).toEqual({
      status: "async_launched",
      taskId: `local_workflow_${runId}`,
      taskType: "local_workflow",
      runId,
      workflowName: "test-flow",
    });
    expect(out.task.status).toBe("completed");
    expect(runId).toMatch(/^wf_test-flow_[0-9a-f]{16}$/);

    const store = path.join(dir, RUNTIME_DIR);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(store, `${runId}.json`), "utf8"),
    );
    expect(snapshot).toMatchObject({
      runId,
      workflowName: "test-flow",
      args: { tag: 1 },
      task: { status: "completed", usage: { agents: 1 } },
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(store, `${runId}.output.json`), "utf8"),
      ),
    ).toBe("v:x");
    expect(readLastRun(store)).toBe(runId);
    // lock 文件在收尾时释放，不会挡住后续的 resume。
    expect(fs.existsSync(path.join(store, `${runId}.lock`))).toBe(false);
  });

  it("同一次运行不能并发", async () => {
    const runtime = makeRuntime({ createRunner: () => echoRunner() });
    const first = await runScript(async (ctx) => ctx.agent("x"), { runtime });
    const runId = first.task.runId;

    let open: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = runScript(
      async () => {
        await gate;
        return "ok";
      },
      { runtime, args: null, resumeFromRunId: runId },
    );
    await expect(
      runScript(async () => "second", {
        runtime,
        args: null,
        resumeFromRunId: runId,
      }),
    ).rejects.toThrow(`workflow run ${runId} is already active`);
    open?.();
    expect((await running).result).toBe("ok");
  });

  it("上一次运行崩掉留下的锁文件不挡住 resume", async () => {
    const runtime = makeRuntime({ createRunner: () => echoRunner() });
    const first = await runScript(async (ctx) => ctx.agent("x"), { runtime });
    const runId = first.task.runId;
    const lockFile = path.join(dir, RUNTIME_DIR, `${runId}.lock`);

    // 持有者还活着（当前进程）：拒绝。
    fs.writeFileSync(lockFile, String(process.pid));
    await expect(
      runScript(async () => "second", {
        runtime,
        args: null,
        resumeFromRunId: runId,
      }),
    ).rejects.toThrow("is already active");

    // 持有者已经没了：当作残留清掉，续跑照常。
    fs.writeFileSync(lockFile, "2147483647");
    const resumed = await runScript(async () => "second", {
      runtime,
      args: null,
      resumeFromRunId: runId,
    });
    expect(resumed.result).toBe("second");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("示例 workflow 跑完 pipeline，确认过的发现按严重程度排序", async () => {
    const runtime = makeRuntime();
    const out = await runWorkflow(runtime, {
      name: SAMPLE_META.name,
      args: { changes: "def f(): pass" },
    });
    const confirmed = (
      out.result as { confirmed: { dimension: string; severity: string }[] }
    ).confirmed;

    expect(out.task.status).toBe("completed");
    expect(confirmed.length).toBeGreaterThan(0);
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    expect(confirmed.map((f) => rank[f.severity])).toEqual(
      [...confirmed.map((f) => rank[f.severity])].sort((a, b) => a - b),
    );
    // 两个阶段各播报一次，agent 事件数与 usage.agents 对得上。
    const phases = out.task.progress.filter((p) => p.type === "workflow_phase");
    expect(phases.map((p) => p.title)).toEqual(["Review", "Verify"]);
    const agents = out.task.progress.filter((p) => p.type === "workflow_agent");
    expect(agents).toHaveLength(out.task.usage.agents);
    expect(agents.length).toBeGreaterThanOrEqual(8); // 4 次审计 + 至少 4 次验证
  });

  it("名称未知或被 deny 的 workflow 起不来", async () => {
    await expect(runWorkflow(makeRuntime(), { name: "nope" })).rejects.toThrow(
      "unknown workflow 'nope'",
    );
    await expect(
      runWorkflow(makeRuntime({ deny: [SAMPLE_META.name] }), {
        name: SAMPLE_META.name,
      }),
    ).rejects.toThrow("denied by settings");
  });
});

// ── 接进 s15 主循环 ───────────────────────────────────────
describe("Workflow 工具", () => {
  it("handler 回可写入 JSON 的启动信息 + 结果 + 任务状态", async () => {
    const pool = workflowToolPool(makeRuntime());
    const handler = pool.handlers.Workflow;
    if (!handler) throw new Error("Workflow handler missing");

    const output = JSON.parse(
      await handler({ name: SAMPLE_META.name, args: { changes: "x" } }),
    );
    expect(output.launched.status).toBe("async_launched");
    expect(output.task.taskType).toBe("local_workflow");
    expect(Array.isArray(output.result.confirmed)).toBe(true);

    // 参数非法与名称未知都收敛成错误文本，宿主循环照常继续。
    expect(await handler({ name: 1 })).toMatch(/^Error: /);
    expect(await handler({ name: "nope" })).toBe(
      "Error: unknown workflow 'nope'",
    );
  });

  it("挂进 s15 的工具池后，模型像调用普通工具一样调用它", async () => {
    const responses: Anthropic.Message[] = [
      fakeMessage(
        [
          toolUseBlock("t1", "Workflow", {
            name: SAMPLE_META.name,
            args: { changes: "def f(): pass" },
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("审查完成")], "end_turn"),
    ];
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client: ModelClient = {
      messages: {
        create: vi.fn(async (params) => {
          if (!params.tools) return fakeMessage([textBlock("[]")], "end_turn");
          seen.push(params);
          const next = responses.shift();
          if (!next) throw new Error("fake client ran out of responses");
          return next;
        }),
      },
    };

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "跑一下 review-changes" },
    ];
    const final = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      skills: {},
      team: createTeamState(dir),
      cron: createCronState(dir),
      mcp: createMcpState(),
      background: new BackgroundManager(),
      memoryDir: path.join(dir, ".memory"),
      sessionDir: dir,
      activeRequest: "跑一下 review-changes",
      extraPool: workflowToolPool(makeRuntime()),
    });

    expect(final).toBe("审查完成");
    const names = (seen[0].tools ?? []).map((tool) => tool.name);
    expect(names).toHaveLength(BUILTIN_TOOLS.length + 1);
    expect(names.at(-1)).toBe("Workflow");

    const result = (messages[2].content as Anthropic.ToolResultBlockParam[])[0];
    const payload = JSON.parse(String(result.content));
    expect(payload.task.workflowName).toBe(SAMPLE_META.name);
    expect(payload.task.status).toBe("completed");
  });
});

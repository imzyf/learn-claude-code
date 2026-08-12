/**
 * s11_background_tasks/main.test.ts
 *
 * s11 的新增点是后台执行这一层，测试只聚焦它：
 *   - shouldRunBackground 只认显式的 run_in_background（纯函数）
 *   - runBashAsync / formatBashResult 的输出与退出码
 *   - BackgroundManager 派发 -> 完成 -> collect 通知的生命周期（含 failed）
 *   - injectBackgroundResults 并进末尾 user 消息 / 单开一条消息
 *   - bash 工具覆盖后仍带 run_in_background，其余四个工具不变
 *   - agentLoop 端到端派发一次后台 bash，回传占位符
 * 工具层与 hook 层已在 s02-s04 覆盖，这里不再重复。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
import {
  agentLoop,
  BackgroundManager,
  formatBashResult,
  injectBackgroundResults,
  runBashAsync,
  shouldRunBackground,
  TOOL_SCHEMAS,
  tools,
} from "./main";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 轮询等待后台 worker 完成（游离 Promise，无法直接 await）。
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

// ── shouldRunBackground：只认显式请求 ──────────────────────
describe("shouldRunBackground", () => {
  it("标志显式为 true 时在后台运行 bash", () => {
    expect(
      shouldRunBackground("bash", { command: "ls", run_in_background: true }),
    ).toBe(true);
  });

  it("没有标志时保持 bash 在前台运行", () => {
    expect(shouldRunBackground("bash", { command: "npm install" })).toBe(false);
    expect(
      shouldRunBackground("bash", { command: "ls", run_in_background: false }),
    ).toBe(false);
  });

  it("不在后台运行非 bash 工具", () => {
    expect(
      shouldRunBackground("read_file", { path: "a", run_in_background: true }),
    ).toBe(false);
  });
});

// ── runBashAsync / formatBashResult ───────────────────────
describe("runBashAsync", () => {
  it("退出码为 0 时返回去除首尾空白的标准输出", async () => {
    expect(await runBashAsync("echo hello")).toEqual({
      output: "hello",
      exitCode: 0,
    });
  });

  it("非零退出时保留捕获的输出", async () => {
    const { output, exitCode } = await runBashAsync("echo boom && exit 3");
    expect(output).toContain("boom");
    expect(exitCode).toBe(3);
  });

  it("输出为空时报告占位符", async () => {
    expect((await runBashAsync("true")).output).toBe("(no output)");
  });
});

describe("formatBashResult", () => {
  it("成功或超时时原样返回输出", () => {
    expect(formatBashResult("ok", 0)).toBe("ok");
    expect(formatBashResult("Error: Timeout (120s)", null)).toBe(
      "Error: Timeout (120s)",
    );
  });

  it("失败时在输出前添加退出状态", () => {
    expect(formatBashResult("boom", 3)).toBe(
      "Error: command exited with status 3\nboom",
    );
  });
});

// ── 后台生命周期：派发 -> 完成 -> 收集通知 ─────────────────
describe("BackgroundManager", () => {
  it("分发 bash 任务并在完成后收集结果", async () => {
    const background = new BackgroundManager();
    const taskId = background.start(
      toolUseBlock("tu_1", "bash", {
        command: "echo done-bg",
        run_in_background: true,
      }),
      noopLogger,
    );
    expect(taskId).toBe("bg_0001");
    expect(background.tasks[taskId].status).toBe("running");

    await waitFor(() => background.tasks[taskId]?.status === "completed");
    const notes = background.collect(noopLogger);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("<task_id>bg_0001</task_id>");
    expect(notes[0]).toContain("<status>completed</status>");
    expect(notes[0]).toContain("echo done-bg");
    expect(notes[0]).toContain("done-bg");
    // 收集后从登记簿中清除。
    expect(background.tasks[taskId]).toBeUndefined();
    expect(background.results[taskId]).toBeUndefined();
  });

  it("将非零退出标记为失败", async () => {
    const background = new BackgroundManager();
    const taskId = background.start(
      toolUseBlock("tu_1", "bash", { command: "exit 1" }),
      noopLogger,
    );
    await waitFor(() => background.tasks[taskId]?.status !== "running");
    expect(background.tasks[taskId].status).toBe("failed");
    expect(background.collect(noopLogger)[0]).toContain(
      "<status>failed</status>",
    );
  });

  it("拒绝非 bash 工具和空命令", () => {
    const background = new BackgroundManager();
    expect(() =>
      background.start(
        toolUseBlock("tu_1", "read_file", { path: "a" }),
        noopLogger,
      ),
    ).toThrow("Only Bash commands");
    expect(() =>
      background.start(
        toolUseBlock("tu_2", "bash", { command: "  " }),
        noopLogger,
      ),
    ).toThrow("cannot be empty");
  });

  it("不收集仍在运行的任务", () => {
    const background = new BackgroundManager();
    background.start(
      toolUseBlock("tu_1", "bash", { command: "sleep 9" }),
      noopLogger,
    );
    expect(background.collect(noopLogger)).toHaveLength(0);
    expect(background.tasks.bg_0001).toBeDefined();
  });
});

// ── 通知注入 ──────────────────────────────────────────────
describe("injectBackgroundResults", () => {
  it("将通知合并到末尾的用户消息中", async () => {
    const background = new BackgroundManager();
    background.start(
      toolUseBlock("tu_1", "bash", { command: "echo merged" }),
      noopLogger,
    );
    await waitFor(() => background.tasks.bg_0001?.status === "completed");

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(injectBackgroundResults(messages, background, noopLogger)).toBe(1);
    expect(messages).toHaveLength(1);
    const content = messages[0].content as Anthropic.ContentBlockParam[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "hi" });
    expect((content[1] as Anthropic.TextBlockParam).text).toContain(
      "<task_id>bg_0001</task_id>",
    );
  });

  it("在 assistant 轮次后追加新的用户消息", async () => {
    const background = new BackgroundManager();
    background.start(
      toolUseBlock("tu_1", "bash", { command: "echo appended" }),
      noopLogger,
    );
    await waitFor(() => background.tasks.bg_0001?.status === "completed");

    const messages: Anthropic.MessageParam[] = [
      { role: "assistant", content: "working on it" },
    ];
    expect(injectBackgroundResults(messages, background, noopLogger)).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("user");
  });

  it("没有任务完成时不执行任何操作", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
    ];
    expect(
      injectBackgroundResults(messages, new BackgroundManager(), noopLogger),
    ).toBe(0);
    expect(messages[0].content).toBe("hi");
  });
});

// ── 工具覆盖：bash 加了 run_in_background ──────────────────
describe("tools override", () => {
  it("bash schema 接受 run_in_background", () => {
    expect(
      TOOL_SCHEMAS.bash?.parse({ command: "ls", run_in_background: true }),
    ).toEqual({ command: "ls", run_in_background: true });
  });

  it("保留五个基础工具", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
    ]);
  });
});

// ── agentLoop：后台派发返回占位符 ──────────────────────────
describe("agentLoop", () => {
  it("分发后台 bash 调用并返回占位 tool_result", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_1", "bash", {
            command: "echo bg",
            run_in_background: true,
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("kicked off")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "run it in the background" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      background: new BackgroundManager(),
    });

    expect(result).toBe("kicked off");
    const toolResults = messages[2].content as Anthropic.ContentBlockParam[];
    const first = toolResults[0] as Anthropic.ToolResultBlockParam;
    expect(first.content).toContain("[Background task bg_0001 started]");
  });
});

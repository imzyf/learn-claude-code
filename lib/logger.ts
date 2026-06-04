// lib/logger.ts - session 日志：JSON（API 收发）+ transcript（可读对话）
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createCostMeter } from "./pricing";
import { type Color, print } from "./terminal";

// 双文件日志：
//   *.json — 只记 API request/response，多行 pretty 打印方便阅读，
//            jq 可直接解析这种连续 JSON 流
//   *.log  — 人类可读的 transcript，按节展示对话过程
// 每次运行生成一对新文件，避免覆盖上一次的记录。
// 日志落在对应 session 目录的 .log/ 下。

// 每个 session 的日志接口。
export interface SessionLogger {
  // 记录本次运行的配置，并按 model 加载定价。
  config(data: Record<string, unknown>): void;
  // 记录用户输入。
  userInput(query: string): void;

  // API 调用前：记录请求消息。incremental=true（默认）只记本轮新增，false 记全部。
  request(messages: Anthropic.MessageParam[], incremental?: boolean): void;
  // API 返回后：记录响应内容与 token / 成本。
  response(res: Anthropic.Message): void;

  // 记录权限关卡对某个工具调用的放行 / 拦截决定。
  permission(
    toolName: string,
    args: unknown,
    reason: string,
    decision: "allow" | "deny",
  ): void;
  // 记录一次工具执行的命令与输出。
  toolResult(command: string, output: string): void;
  // 记录 hook 执行结果：仅当该 hook 拦截了调用（blocked 非空）时落一条，
  // 并把触发时的 args 序列化进去（超长会截断），便于看清被拦的是什么输入。
  hookResult(
    event: string,
    name: string,
    args: unknown[],
    blocked: string | null,
  ): void;
  // 记录默认 hook 的一次性注册：按 event 列出各 hook 名字。
  hookRegister(hooks: Record<string, readonly { name: string }[]>): void;

  // 带颜色打到终端，同时把纯文本写进 transcript。
  console(message: string, color?: Color): void;
  // 往 transcript 追加一节：标题 + 正文。
  section(title: string, body: string): void;
  // 把带状态标记的清单按 `[status] content` 逐行写进 transcript（纯文本、无 ANSI）。
  plain(items: readonly { content: string; status: string }[]): void;
  // 记录一次技能加载：名称、是否命中、内容大小（完整内容另由 toolResult 落一份）。
  skill(name: string, found: boolean, size: number): void;

  // 派生一个带 scope 标签的子 logger：写同一对文件，但各自维护增量计数，
  // 记录标注来源（main / sub），用于区分父 agent 与子 agent 的日志。
  child(scope: string): SessionLogger;
}

export function createLogger(sessionDir: string): SessionLogger {
  const sessionName = path.basename(sessionDir);
  const logDir = path.join(sessionDir, ".log");
  fs.mkdirSync(logDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(logDir, `${sessionName}-${stamp}`);
  const json = fs.createWriteStream(`${base}.json`, { flags: "a" });
  const text = fs.createWriteStream(`${base}.log`, { flags: "a" });

  const costMeter = createCostMeter();

  // 每个 scope（"main" / "sub"）各自维护增量计数，但共享同一对文件流：
  // main 与 sub 的 request 增量互不干扰，同时每条记录都标出来源。
  function make(scope: string): SessionLogger {
    // request 只记增量消息，避免日志随对话轮数平方级膨胀。
    let loggedMessages = 0;

    function writeJson(tag: string, data: unknown): void {
      json.write(
        `${JSON.stringify(
          { ts: new Date().toISOString(), scope, tag, data },
          null,
          2,
        )}\n`,
      );
    }

    function writeTranscript(title: string, body: string): void {
      const time = new Date().toTimeString().slice(0, 8);
      const rule = "─".repeat(Math.max(3, 46 - title.length));
      // main 保持原样；子 scope 前缀 [sub] 便于扫读与 grep。
      const heading = scope === "main" ? title : `[${scope}] ${title}`;
      // ── region 标记让编辑器可折叠每一节。
      text.write(`── [${time}] ${heading} ${rule}\n${body}\n──\n\n`);
    }

    return {
      section: writeTranscript,

      plain(items) {
        const body = items
          .map((it) => `[${it.status}] ${it.content}`)
          .join("\n");
        writeTranscript("TASKS", body || "(empty)");
      },

      skill(name, found, size) {
        writeJson("skill", { name, found, size });
        writeTranscript(
          "SKILL",
          found ? `load ${name} (${size} chars)` : `not found: ${name}`,
        );
      },

      config(data: Record<string, unknown>) {
        writeJson("config", data);
        if (typeof data.model === "string") {
          void costMeter
            .load(data.model)
            .then((price) => writeJson("price", price));
        }
      },

      userInput(query: string) {
        writeTranscript("USER", query);
      },

      request(messages: Anthropic.MessageParam[], incremental = true) {
        writeJson("api_request", {
          new_messages: incremental ? messages.slice(loggedMessages) : messages,
        });
        loggedMessages = messages.length;
      },

      response(res: Anthropic.Message) {
        writeJson("api_response", res);
        const u = res.usage;
        writeTranscript(
          `ASSISTANT (${u.input_tokens} in / ${u.output_tokens} out / ` +
            `${u.cache_creation_input_tokens ?? 0} cache-w / ` +
            `${u.cache_read_input_tokens ?? 0} cache-r${costMeter.costSuffix(u)})`,
          formatBlocks(res.content),
        );
      },

      permission(toolName, args, reason, decision) {
        writeTranscript(
          "PERMISSION",
          `${reason}\nTool: ${toolName}(${JSON.stringify(args)})\nDecision: ${decision}`,
        );
      },

      toolResult(command: string, output: string) {
        writeTranscript(`TOOL RESULT (${command})`, output);
      },

      hookResult(event, name, args, blocked) {
        if (!blocked) return;
        const hookName = name || "(anonymous)";
        const serialized = JSON.stringify(args).slice(0, 500);
        writeTranscript(
          "HOOK RESULT",
          `${event} → ${hookName}(${serialized}) blocked: ${blocked}`,
        );
      },

      hookRegister(hooks) {
        const entries = Object.entries(hooks).filter(([, hs]) => hs.length > 0);
        // 按最长 event 名补空格，让各行的 hook 列表左对齐。
        const pad = Math.max(...entries.map(([event]) => event.length)) + 2;
        const summary = entries
          .map(
            ([event, hs]) =>
              `${event}:`.padEnd(pad) +
              hs.map((h) => h.name || "(anonymous)").join(", "),
          )
          .join("\n");
        writeTranscript("HOOK REGISTER", summary);
      },

      console(message: string, color?: Color) {
        print(message, color);
        writeTranscript("CONSOLE", message);
      },

      child(sub: string) {
        return make(scope === "main" ? sub : `${scope}/${sub}`);
      },
    };
  }

  return make("main");
}

function formatBlocks(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return `[thinking] ${b.thinking}`;
      if (b.type === "tool_use")
        return `[tool_use] ${b.name}: ${JSON.stringify(b.input)}`;
      return `[${b.type}]`;
    })
    .join("\n");
}

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

  // API 调用前：记录本轮新增的请求消息。
  request(messages: Anthropic.MessageParam[]): void;
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
  // 记录 hook 生命周期（注册 / 触发 / 结果）。
  hook(
    phase: "register" | "trigger" | "result",
    event: string,
    name: string,
    blocked?: string | null,
  ): void;

  // 带颜色打到终端，同时把纯文本写进 transcript。
  console(message: string, color?: Color): void;
  // 往 transcript 追加一节：标题 + 正文。
  section(title: string, body: string): void;
}

export function createLogger(sessionDir: string): SessionLogger {
  const sessionName = path.basename(sessionDir);
  const logDir = path.join(sessionDir, ".log");
  fs.mkdirSync(logDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(logDir, `${sessionName}-${stamp}`);
  const json = fs.createWriteStream(`${base}.json`, { flags: "a" });
  const text = fs.createWriteStream(`${base}.log`, { flags: "a" });

  // request 只记增量消息，避免日志随对话轮数平方级膨胀。
  let loggedMessages = 0;

  const costMeter = createCostMeter();

  function writeJson(tag: string, data: unknown): void {
    json.write(
      JSON.stringify({ ts: new Date().toISOString(), tag, data }, null, 2) +
        "\n",
    );
  }

  function writeTranscript(title: string, body: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    const rule = "─".repeat(Math.max(3, 46 - title.length));
    text.write(`── [${time}] ${title} ${rule}\n${body}\n\n`);
  }

  return {
    section: writeTranscript,

    config(data: Record<string, unknown>) {
      writeTranscript("CONFIG", JSON.stringify(data, null, 2));
      if (typeof data.model === "string") {
        void costMeter
          .load(data.model)
          .then((body) => writeTranscript("PRICE", body));
      }
    },

    userInput(query: string) {
      writeTranscript("USER", query);
    },

    request(messages: Anthropic.MessageParam[]) {
      writeJson("api_request", {
        new_messages: messages.slice(loggedMessages),
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

    hook(phase, event, name, blocked) {
      const hookName = name || "(anonymous)";
      if (phase === "register") {
        writeTranscript("HOOK REGISTER", `${event} ← ${hookName}`);
        return;
      } else if (phase === "trigger") {
        writeTranscript("HOOK TRIGGER", `${event} → ${hookName}`);
      } else if (phase === "result" && blocked) {
        writeTranscript(
          "HOOK RESULT",
          `${event} → ${hookName} blocked: ${blocked}`,
        );
      }
    },

    console(message: string, color?: Color) {
      print(message, color);
      writeTranscript("CONSOLE", message);
    },
  };
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

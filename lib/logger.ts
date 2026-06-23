// lib/logger.ts - session 日志：JSON（API 收发）+ transcript（可读对话）
import { randomBytes } from "node:crypto";
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

  // API 调用前：记录请求消息。full=false（默认）只记本轮新增，true 记全部。
  request(messages: Anthropic.MessageParam[], full?: boolean): void;
  // API 返回后：记录响应内容与 token / 成本。
  response(res: Anthropic.Message): void;

  // 记录一次工具执行的命令与输出。
  toolResult(command: string, output: string): void;

  // 带颜色打到终端，同时把纯文本写进 transcript。
  console(message: string, color?: Color): void;
  // 往 transcript 追加一节：标题 + 正文。各模块的领域日志复用这个通用原语。
  section(title: string, body: string): void;

  // 派生一个带 scope 标签的子 logger：写同一对文件，但各自维护增量计数，
  // 记录标注来源（main / sub），用于区分父 agent 与子 agent 的日志。
  child(scope: string): SessionLogger;
}

export function createLogger(sessionDir: string): SessionLogger {
  // 文件名前缀只取 session 名前三个字母（如 s07_skill_loading → s07）。
  const sessionName = path.basename(sessionDir).slice(0, 3);
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
    // traceId：request 生成并写入 .json，response 复用并写进 .log，用于两份文件对照。
    let traceId = "";

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

      config(data: Record<string, unknown>) {
        json.write(
          `${JSON.stringify(
            {scope, config: data },
            null,
            2,
          )}\n`,
        );
        if (typeof data.model === "string") {
          costMeter.load(data.model);
        }
      },

      userInput(query: string) {
        writeTranscript("USER", query);
      },

      request(messages: Anthropic.MessageParam[], full = false) {
        traceId = randomBytes(4).toString("hex");
        const newMessages = full ? messages : messages.slice(loggedMessages);
        const chars = JSON.stringify(messages).length;
        loggedMessages = messages.length;

        json.write(
          `${JSON.stringify(
            {
              ts: new Date().toISOString(),
              traceId,
              tag: "api_request",
              messages: newMessages,
            },
            null,
            2,
          )}\n`,
        );

        writeTranscript(
          `REQUEST ${traceId} ${scope}`,
          `${messages.length} messages (${newMessages.length} new), ${chars} chars`,
        );
      },

      response(res: Anthropic.Message) {
        json.write(
          `${JSON.stringify(
            {
              ts: new Date().toISOString(),
              traceId,
              tag: "api_response",
              message: res,
            },
            null,
            2,
          )}\n`,
        );

        const u = res.usage;
        writeTranscript(
          `ASSISTANT ${traceId} ${scope} (${u.input_tokens} in / ${u.output_tokens} out / ` +
            `${u.cache_creation_input_tokens ?? 0} cache-w / ` +
            `${u.cache_read_input_tokens ?? 0} cache-r${costMeter.costSuffix(u)})`,
          formatBlocks(res.content),
        );
      },

      toolResult(command: string, output: string) {
        writeTranscript(`TOOL RESULT (${command})`, output);
      },

      console(message: string, color?: Color) {
        print(message, color);
        writeTranscript("CONSOLE PRINT", message);
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

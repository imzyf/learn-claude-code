import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createCostMeter } from "./pricing";

// 双文件日志：
//   *.json — 只记 API request/response，多行 pretty 打印方便阅读，
//            jq 可直接解析这种连续 JSON 流
//   *.log  — 人类可读的 transcript，按节展示对话过程
// 每次运行生成一对新文件，避免覆盖上一次的记录。
// 日志落在对应 session 目录的 .log/ 下。

// agent 循环依赖的最小日志接口。
export interface AgentLogger {
  // API 调用前调用
  request(messages: Anthropic.MessageParam[]): void;
  // API 返回后调用
  response(res: Anthropic.Message): void;
  toolResult(command: string, output: string): void;
}

export interface SessionLogger extends AgentLogger {
  readonly file: string;
  readonly jsonFile: string;
  config(data: Record<string, unknown>): void;
  writeTranscript(title: string, body: string): void;
  userInput(query: string): void;
}

export function createLogger(sessionDir: string): SessionLogger {
  const sessionName = path.basename(sessionDir);
  const logDir = path.join(sessionDir, ".log");
  fs.mkdirSync(logDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(logDir, `${sessionName}-${stamp}`);
  const json = fs.createWriteStream(`${base}.json.log`, { flags: "a" });
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
    file: `${base}.log`,
    jsonFile: `${base}.json`,
    writeTranscript,

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

    toolResult(command: string, output: string) {
      writeTranscript(`TOOL RESULT (${command})`, output);
    },

    request(messages: Anthropic.MessageParam[]) {
      writeJson("api_request", { new_messages: messages.slice(loggedMessages) });
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

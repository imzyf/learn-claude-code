import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// 双文件日志：
//   *.json — 只记 API request/response，多行 pretty 打印方便阅读，
//            jq 可直接解析这种连续 JSON 流
//   *.log  — 人类可读的 transcript，按节展示对话过程
// 每次运行生成一对新文件，避免覆盖上一次的记录。
// 日志落在对应 session 目录的 .log/ 下。

// 费用按 RMB 显示，固定汇率 USD × 7
const USD_TO_RMB = 7;

// LiteLLM model catalog 的价格字段，单位是每 token 美元（不是每 1M tokens）
type LiteLLMPrice = {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
};

async function fetchPrice(modelId: string): Promise<LiteLLMPrice | null> {
  try {
    const res = await fetch(`https://api.litellm.ai/model_catalog/${modelId}`);
    return res.ok ? ((await res.json()) as LiteLLMPrice) : null;
  } catch {
    return null;
  }
}

// 四段计价：未缓存输入原价、缓存写入、缓存读取、输出
function costUSD(u: Anthropic.Usage, p: LiteLLMPrice): number {
  return (
    u.input_tokens * p.input_cost_per_token +
    (u.cache_creation_input_tokens ?? 0) *
      (p.cache_creation_input_token_cost ?? p.input_cost_per_token) +
    (u.cache_read_input_tokens ?? 0) * (p.cache_read_input_token_cost ?? 0) +
    u.output_tokens * p.output_cost_per_token
  );
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

// agent 循环依赖的最小日志接口。
export interface AgentLogger {
  // API 调用前调用，传完整 messages 数组
  request(messages: Anthropic.MessageParam[]): void;
  // API 返回后调用
  response(res: Anthropic.Message): void;
  toolResult(command: string, output: string): void;
}

export interface SessionLogger extends AgentLogger {
  readonly file: string;
  readonly jsonFile: string;
  // transcript 写入一节：── [HH:MM:SS] TITLE ─────
  section(title: string, body: string): void;
  // 启动时调用一次：记录 model / system / tools 等不变配置
  config(data: Record<string, unknown>): void;
  userInput(query: string): void;
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

  // 价格异步获取；拿到之前 response 里不显示费用
  let price: LiteLLMPrice | null = null;
  let totalCost = 0;

  function log(tag: string, data: unknown): void {
    json.write(
      JSON.stringify({ ts: new Date().toISOString(), tag, data }, null, 2) +
        "\n",
    );
  }

  function section(title: string, body: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    const rule = "─".repeat(Math.max(3, 46 - title.length));
    text.write(`── [${time}] ${title} ${rule}\n${body}\n\n`);
  }

  return {
    file: `${base}.log`,
    jsonFile: `${base}.json`,
    section,

    config(data: Record<string, unknown>) {
      section("CONFIG", JSON.stringify(data, null, 2));
      if (typeof data.model === "string") {
        void fetchPrice(data.model).then((p) => {
          price = p;
          section(
            "PRICE",
            p
              ? JSON.stringify(p, null, 2)
              : `fetch failed for ${data.model}, cost will not be shown`,
          );
        });
      }
    },

    // 只写 transcript：消息会随下一次 request 进入 *.json
    userInput(query: string) {
      section("USER", query);
    },

    request(messages: Anthropic.MessageParam[]) {
      log("api_request", { new_messages: messages.slice(loggedMessages) });
      loggedMessages = messages.length;
    },

    response(res: Anthropic.Message) {
      log("api_response", res);
      const u = res.usage;
      let cost = "";
      if (price) {
        const c = costUSD(u, price) * USD_TO_RMB;
        totalCost += c;
        cost = `, ¥${c.toFixed(6)} / Σ ¥${totalCost.toFixed(6)}`;
      }
      section(
        `ASSISTANT (${u.input_tokens} in / ${u.output_tokens} out / ` +
          `${u.cache_creation_input_tokens ?? 0} cache-w / ` +
          `${u.cache_read_input_tokens ?? 0} cache-r${cost})`,
        formatBlocks(res.content),
      );
    },

    // 只写 transcript：结果会随下一次 request 作为 tool_result 进入 *.json
    toolResult(command: string, output: string) {
      section(`TOOL RESULT (${command})`, output);
    },
  };
}

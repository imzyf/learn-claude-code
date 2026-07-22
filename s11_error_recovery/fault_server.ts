/**
 * s11_error_recovery/fault_server.ts - 故障注入代理（假的 Anthropic endpoint）
 *
 * 前 FAULT_TIMES 个 /v1/messages 请求返回 FAULT_STATUS（429 或 529），
 * 之后放行：转发到真实上游（.env 的 ANTHROPIC_BASE_URL）。
 * 用来在实际运行 s11 时触发 withRetry 的错误恢复路径，无需改 main.ts。
 *
 * 用法（开两个终端）：
 *   1) 起代理：
 *        FAULT_STATUS=529 FAULT_TIMES=2 pnpm dev s11_error_recovery/fault_server.ts
 *        FAULT_STATUS=429 FAULT_TIMES=2 pnpm dev s11_error_recovery/fault_server.ts
 *   2) 跑 s11 并指向它（base URL 不带 /v1，SDK 自己会补）：
 *        ANTHROPIC_BASE_URL=http://localhost:8787 make s11
 *
 * 环境变量：
 *   PORT          监听端口，默认 8787
 *   FAULT_STATUS  注入的状态码，429 或 529，默认 529
 *   FAULT_TIMES   开头连续失败的请求数，默认 3
 *   UPSTREAM      真实上游 base；不设则用 .env 的 ANTHROPIC_BASE_URL，
 *                 再不设才回退到 https://api.anthropic.com
 *
 * 注：故障计数按进程生命周期，一旦用满就一直放行；想重新触发就重启本进程。
 */
import * as http from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const FAULT_STATUS = Number(process.env.FAULT_STATUS ?? 529);
const FAULT_TIMES = Number(process.env.FAULT_TIMES ?? 3);
// 优先级：显式 UPSTREAM > .env 的 ANTHROPIC_BASE_URL > 官方 API。
// 用 || 而非 ??：空串（UPSTREAM=）也算「没设」，继续回退。
const UPSTREAM = (
  process.env.UPSTREAM ||
  process.env.ANTHROPIC_BASE_URL ||
  "https://api.anthropic.com"
).replace(/\/+$/, "");

// 防呆：UPSTREAM 指回本代理自身会造成无限转发循环。
if (
  UPSTREAM.includes(`localhost:${PORT}`) ||
  UPSTREAM.includes(`127.0.0.1:${PORT}`)
) {
  console.error(
    `[fatal] UPSTREAM (${UPSTREAM}) 指向本代理自身，会无限循环。` +
      ` 请把 ANTHROPIC_BASE_URL 设成真实上游，或用 MOCK=1。`,
  );
  process.exit(1);
}

// Anthropic 错误响应体：SDK 按 HTTP status 建 APIError，body.type 只是配色。
function errorBody(status: number): string {
  const type = status === 429 ? "rate_limit_error" : "overloaded_error";
  const message = status === 429 ? "Rate limit exceeded." : "Overloaded";
  return JSON.stringify({ type: "error", error: { type, message } });
}

let messageCalls = 0;

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const isMessages = req.method === "POST" && url.includes("/v1/messages");

  // 先把请求体读完整（转发时要用）。
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  // ── 故障注入：只对 messages 请求计数 ──
  if (isMessages && messageCalls < FAULT_TIMES) {
    messageCalls += 1;
    console.log(`[fault] #${messageCalls}/${FAULT_TIMES} -> ${FAULT_STATUS}`);
    res.writeHead(FAULT_STATUS, {
      "content-type": "application/json",
      // 429 带 Retry-After 更真实；withRetry 目前不读它，但无害。
      ...(FAULT_STATUS === 429 ? { "retry-after": "3" } : {}),
    });
    res.end(errorBody(FAULT_STATUS));
    return;
  }

  // ── 故障阶段结束：透传到真实上游 ──
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // 这几个由 fetch 按上游重算，转发原值会冲突。
    if (k === "host" || k === "connection" || k === "content-length") continue;
    if (typeof v === "string") headers[k] = v;
  }
  const upstreamUrl = UPSTREAM + url;
  console.log(
    `[pass ] #${messageCalls} -> forward ${req.method} ${upstreamUrl}`,
  );
  const upstreamRes = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
  });
  const text = await upstreamRes.text();
  res.writeHead(upstreamRes.status, {
    "content-type":
      upstreamRes.headers.get("content-type") ?? "application/json",
  });
  res.end(text);
});

server.listen(PORT, () => {
  console.log(
    `fault_server on http://localhost:${PORT}  ` +
      `status=${FAULT_STATUS} times=${FAULT_TIMES} -> ${UPSTREAM}`,
  );
  console.log(
    `Point the agent at it:  ANTHROPIC_BASE_URL=http://localhost:${PORT}`,
  );
});

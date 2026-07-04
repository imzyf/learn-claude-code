import { client, MODEL_ID } from "./model";
import { textOf } from "./tools";

// 最小化的端到端检查：一次提问，一次回复。
// 运行方式：pnpm smoke（需要 .env 中配置真实的 ANTHROPIC_API_KEY）
const response = await client.messages.create({
  model: MODEL_ID,
  max_tokens: 100,
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
});

console.log(`model: ${MODEL_ID}`);
console.log(`reply: ${textOf(response)}`);
console.log(`usage: ${JSON.stringify(response.usage)}`);

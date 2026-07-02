import { generateText } from "ai";
import { model, MODEL_ID } from "./model";

// 最小化的端到端检查：一次提问，一次回复。
// 运行方式：pnpm smoke（需要 .env 中配置真实的 ANTHROPIC_API_KEY）
const { text, usage } = await generateText({
  model,
  prompt: "Reply with exactly: ok",
});

console.log(`model: ${MODEL_ID}`);
console.log(`reply: ${text}`);
console.log(`usage: ${JSON.stringify(usage)}`);

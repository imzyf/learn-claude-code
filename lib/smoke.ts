import { generateText } from "ai";
import { model, MODEL_ID } from "./model";

// Minimal end-to-end check: one prompt, one reply.
// Run with: pnpm smoke  (needs .env with a real ANTHROPIC_API_KEY)
const { text, usage } = await generateText({
  model,
  prompt: "Reply with exactly: ok",
});

console.log(`model: ${MODEL_ID}`);
console.log(`reply: ${text}`);
console.log(`usage: ${JSON.stringify(usage)}`);

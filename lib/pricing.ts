// lib/pricing.ts - 取价并累计调用成本：供 logger 写入，不碰终端
import type Anthropic from "@anthropic-ai/sdk";

// 从 LiteLLM model catalog 取价并累计费用。
// logger 只负责把结果写进文件，计价逻辑全在这里。

// 费用按 RMB 显示，固定汇率 USD × 7
const USD_TO_RMB = 7;

// LiteLLM model catalog 的价格字段，单位是每 token 美元（不是每 1M tokens）
interface LiteLLMPrice {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

async function fetchPrice(modelId: string): Promise<LiteLLMPrice | null> {
  try {
    const res = await fetch(`https://api.litellm.ai/model_catalog/${modelId}`);
    return res.ok ? await res.json() : null;
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

export interface CostMeter {
  // 异步取价；resolve 出一段可写进 transcript 的说明文字。
  load(modelId: string): Promise<string>;
  // 单次 response 的费用后缀，如 ", ¥0.01 / Σ ¥0.05"；取价成功前返回 ""。
  costSuffix(usage: Anthropic.Usage): string;
}

export function createCostMeter(): CostMeter {
  // 价格异步获取；拿到之前不显示费用
  let price: LiteLLMPrice | null = null;
  let totalCost = 0;

  return {
    async load(modelId: string): Promise<string> {
      price = await fetchPrice(modelId);
      return price
        ? JSON.stringify(price, null, 2)
        : `fetch failed for ${modelId}, cost will not be shown`;
    },

    costSuffix(usage: Anthropic.Usage): string {
      if (!price) return "";
      const c = costUSD(usage, price) * USD_TO_RMB;
      totalCost += c;
      return `, ¥${c.toFixed(6)} / Σ ¥${totalCost.toFixed(6)}`;
    },
  };
}

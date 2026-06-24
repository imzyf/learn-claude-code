// lib/pricing.ts - 取价并累计调用成本：供 logger 写入，不碰终端
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

// 从 LiteLLM model catalog 取价并累计费用。
// logger 只负责把结果写进文件，计价逻辑全在这里。

// 费用按 RMB 显示，固定汇率 USD × 7
const USD_TO_RMB = 7;

// 价格变化很慢，每个 model 缓存 7 天，结果存在 lib/.cache 下的一个 JSON 文件里。
const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".cache",
  "prices.json",
);

// LiteLLM model catalog 的价格字段，单位是每 token 美元（不是每 1M tokens）
interface LiteLLMPrice {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

// 缓存文件是一张 { modelId: entry } 表，整存整取；文件损坏就当空表。
interface PriceEntry {
  price: LiteLLMPrice;
  expires: number; // epoch ms，超过即失效
}

function readCache(): Record<string, PriceEntry> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, PriceEntry>): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchPrice(modelId: string): Promise<LiteLLMPrice | null> {
  const cached = readCache()[modelId];
  if (cached && Date.now() < cached.expires) return cached.price;
  try {
    const res = await fetch(`https://api.litellm.ai/model_catalog/${modelId}`);
    if (!res.ok) return null;
    const price: LiteLLMPrice = await res.json();
    // 只缓存成功结果；失败不写，避免把一次网络故障缓存一整天。
    const cache = readCache();
    cache[modelId] = { price, expires: Date.now() + PRICE_TTL_MS };
    writeCache(cache);
    return price;
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
  // 异步取价；resolve 出价格对象，供 logger 原样写进 JSON；取价失败为 null。
  load(modelId: string): Promise<LiteLLMPrice | null>;
  // 单次 response 的费用后缀，如 ", ¥0.01 / Σ ¥0.05"；取价成功前返回 ""。
  costSuffix(usage: Anthropic.Usage): string;
}

export function createCostMeter(): CostMeter {
  // 价格异步获取；拿到之前不显示费用
  let price: LiteLLMPrice | null = null;
  let totalCost = 0;

  return {
    async load(modelId: string): Promise<LiteLLMPrice | null> {
      price = await fetchPrice(modelId);
      return price;
    },

    costSuffix(usage: Anthropic.Usage): string {
      if (!price) return "";
      const c = costUSD(usage, price) * USD_TO_RMB;
      totalCost += c;
      return `, ¥${c.toFixed(6)} / Σ ¥${totalCost.toFixed(6)}`;
    },
  };
}

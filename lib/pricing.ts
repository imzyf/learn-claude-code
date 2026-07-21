// lib/pricing.ts - 取价并累计调用成本：供 logger 写入，不碰终端
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { print } from "./terminal";

// 从 LiteLLM model catalog 取价并累计费用。
// logger 只负责把结果写进文件，计价逻辑全在这里。

// 费用按 RMB 显示，固定汇率 USD × 7
const USD_TO_RMB = 7;

// 价格变化很慢，每个 model 缓存 7 天，一个 model 一个 JSON 文件，存在 lib/.cache 下。
const PRICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".cache",
);

// modelId 转成安全文件名（非字母数字 . _ - 的字符替换为 _）
function cacheFile(modelId: string): string {
  return path.join(CACHE_DIR, `${modelId.replace(/[^\w.-]/g, "_")}.json`);
}

// LiteLLM model catalog 的价格字段，单位是每 token 美元（不是每 1M tokens）。
// 乘 1e6 换算成每百万 tokens 的美元价，例如 6e-7 → $0.60 / 1M。
interface LiteLLMPrice {
  input_cost_per_token: number; // 未缓存输入，如 6e-7 → $0.60 / 1M
  output_cost_per_token: number; // 输出，如 0.0000022 → $2.20 / 1M
  cache_read_input_token_cost?: number; // 缓存读取（cache hit），× 1e6 = $/1M
  cache_creation_input_token_cost?: number; // 缓存写入，× 1e6 = $/1M
}

// 每百万 tokens 的人民币价（= 每 token 美元价 × 1e6 × USD_TO_RMB）
interface RMBPerMillion {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

// 每个 model 一个缓存文件，内容就是一个 entry；文件损坏或不存在视为无缓存。
interface PriceEntry {
  price: LiteLLMPrice;
  rmbPerMillion: RMBPerMillion; // 每百万 tokens 人民币价，人读用；计价仍以 price 为准
  expires: number; // epoch ms，超过即失效
}

// 把每 token 美元价换算成每百万 tokens 人民币价，保留 4 位小数
function toRMBPerMillion(p: LiteLLMPrice): RMBPerMillion {
  const perM = (usdPerToken: number): number =>
    Math.round(usdPerToken * 1e6 * USD_TO_RMB * 1e4) / 1e4;
  const rmb: RMBPerMillion = {
    input: perM(p.input_cost_per_token),
    output: perM(p.output_cost_per_token),
  };
  if (p.cache_read_input_token_cost != null) {
    rmb.cacheRead = perM(p.cache_read_input_token_cost);
  }
  if (p.cache_creation_input_token_cost != null) {
    rmb.cacheCreation = perM(p.cache_creation_input_token_cost);
  }
  return rmb;
}

function readCache(modelId: string): PriceEntry | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(modelId), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(modelId: string, entry: PriceEntry): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(modelId), JSON.stringify(entry, null, 2));
}

async function fetchPrice(modelId: string): Promise<LiteLLMPrice | null> {
  const cached = readCache(modelId);
  if (cached && Date.now() < cached.expires) return cached.price;
  try {
    // use https://api.litellm.ai/model_catalog?model=deepseek to find modelId
    const res = await fetch(`https://api.litellm.ai/model_catalog/${modelId}`);
    if (!res.ok) {
      print(
        `Failed to fetch price for model ${modelId}: ${res.status} ${res.statusText}`,
        "red",
      );
      return null;
    }
    const price: LiteLLMPrice = await res.json();
    // 只缓存成功结果；失败不写，避免把一次网络故障缓存一整天。
    writeCache(modelId, {
      price,
      rmbPerMillion: toRMBPerMillion(price),
      expires: Date.now() + PRICE_TTL_MS,
    });
    return price;
  } catch (e) {
    print(
      "Failed to fetch price for model " +
        modelId +
        ": " +
        (e as Error).message,
      "red",
    );
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

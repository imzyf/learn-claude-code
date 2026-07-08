import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // lib/model.ts 在 import 时执行 new Anthropic()，缺少 API key 会抛错。
    // 测试全程用 fake client，不发真实请求，这里注入假 key 只为让模块能加载。
    env: { ANTHROPIC_API_KEY: "test-dummy-key" },
  },
});

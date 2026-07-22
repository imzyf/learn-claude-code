import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 防御性设置：测试全程用 fake client，不发真实请求。
    // 缺少 API key 时 new Anthropic() 会抛错。注入假 key 保证这类模块能被加载。
    env: { ANTHROPIC_API_KEY: "test-dummy-key" },
  },
});

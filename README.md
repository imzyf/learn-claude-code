<h4 align="right"><strong>中文</strong> | <a href="./README.en.md">English</a></h4>

# Learn Claude Code (TypeScript)

> 真正的 Agent Harness 工程。

[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 的 **TypeScript 移植版**：`s01`–`s17` 逐章加一个 harness 机制，重建 Claude Code 的内部实现。

## 快速开始

```sh
make setup      # 安装依赖，并从 .env.example.upstream 生成 .env
# 然后把 ANTHROPIC_API_KEY 填进 .env（MODEL_ID / ANTHROPIC_BASE_URL 可选）
make smoke      # 发一次 API 调用，检查环境是否配好
make s01        # 运行第 1 课（交互式）；make help 会列出 s01–s17
make s01 debug  # 在 9229 端口调试 s01–s17 中的任意一课，VS Code 用 `Attach session (make sXX debug)` 启动配置连接
```

## 亮点

### 架构

- 依赖由 **pnpm** 在仓库根目录统一管理。LLM 调用走官方的 **`@anthropic-ai/sdk`**。
- 同步脚本放在 `bin/`：`sync-upstream.sh` 通过 `make sync` 调用，从上游拉取最新的 Python 参考源码；仓库地址、同步目录范围、本地化排除项配在 `.sync-config.sh` 里。执行后跑 `git diff` 查看上游最新变化。
- 公共辅助代码放在 `lib/`：`model.ts` 管 client 和 model id，`tools.ts` 定义工具并解析回复，`logger.ts` 写日志，`pricing.ts` 算调用成本，`terminal.ts` 管终端输出，`testing.ts` 提供测试用的桩对象。

### 可观测性

- 每次运行都在对应章节的 `sXX/.log/` 下写一对文件，文件名以可排序的时间戳开头，多次运行互不覆盖。
- `*_api.json` 是格式化后的原始 API 请求/响应流；`*_transcript.log` 是给人看的对话记录，按 config / user / assistant / tool-result 分段，并记录每次调用的 token 用量。
- 模型价格表在启动时从 LiteLLM 异步加载一次，用于按 token 用量算成本。

### 可测试性

- **Vitest**（`make test`）跑得快、免费、不需要任何凭证，从不调用真实的 Claude API。
- 用 **Dependency injection**，而不是 mock 模块：`agentLoop(messages, { client, logger })` 在测试里接收假对象，在运行时接收真实实现，假对象要满足和真实 client 一样的类型签名，编译期就能查出不匹配。
- 入口文件上有 `import.meta.main` 守卫，所以测试中 import `main.ts` 不会启动 REPL，也不会写日志文件。
- Vitest 之外，每个 `sXX_*` 目录下的 `manual-check.md` 给出对着真实 API 跑的验证 prompt 和期望现象，补终端输出、日志内容这些跑起来才能看到的行为。

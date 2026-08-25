# s14: MCP Tools 手动验证清单

本章的机制：`connect_mcp` 把进程内模拟 server 的工具发现出来，下一轮才加入模型能看到的工具池（`mcp__{server}__{tool}` 前缀），外部工具的放行/确认走宿主侧 `MCP_HOST_POLICY`，与 server 自己的 `annotations` 无关。

```sh
pnpm dev s14_mcp_plugin/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s14_mcp_plugin/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 HOOK REGISTER

REPL 启动后还没输入任何问题，transcript 里就应该有一节 `HOOK REGISTER`：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, mcpPermissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

`mcpPermissionHook` 排在 s04 的 `permissionHook`之后、`logHook` 之前：内置工具的规则（deny list、越界路径）先判，MCP 工具再单独走一层策略表。

## 2. 未连接时看不到 MCP 工具

- `Search the docs for "hooks" using an MCP tool.`
  用 MCP 工具搜索文档里的 "hooks"。

模型此时只有内置工具，`mcp__docs__search` 还不存在，预期它先调用 `connect_mcp({"name":"docs"})`。终端应打印灰色一行：

```
[mcp] connected: docs -> search, get_version
```

工具结果文案是 `Connected to MCP server 'docs'. Discovered 2 tools: search, get_version`，但**这一轮模型还不能调用它们**，因为工具池已经在这轮请求前组装完。

## 3. 下一轮才能真正调用新工具

紧接上一节之后（同一次对话，不重启进程）：

- `Now actually search for "hooks".`
  现在真的搜索 "hooks"。

这一轮的 system prompt 会带上 `Connected MCP servers: docs`，模型能看到并调用 `mcp__docs__search`，返回 `[docs] Found 3 results for 'hooks'`。对照 transcript 里前后两次请求的 `tools` 字段，`mcp__docs__search` 只出现在第二次里。

## 4. 只读工具直接放行，无需确认

上一节的 `mcp__docs__search` 调用不应弹出 `Allow? [y/N]`：`MCP_HOST_POLICY` 里 `docs/search` 和 `docs/get_version` 都是 `allow`。

## 5. 未知工具默认 confirm，破坏性工具同样要人决定

- `Connect to the deploy server, then trigger a deployment for service "web".`
  连接 deploy server，然后为服务 "web" 触发一次部署。

`mcp__deploy__status` 是 `allow`，会直接放行；`mcp__deploy__trigger` 只在宿主策略表里标了 `confirm`（其 server 端 `annotations.destructiveHint` 只是元数据，不参与这个判断），预期弹出：

```
[permission] External tool mcp__deploy__trigger
   Tool: mcp__deploy__trigger({"service":"web"})
   Allow? [y/N]
```

选 `n` 时模型收到 `Permission denied by user`；选 `y` 时才看到 `[deploy] Triggered: web`。

## 6. 重复连接与未知 server

- `Connect to the docs server again.`
  再连一次 docs server。

不重新发现工具，直接返回 `MCP server 'docs' already connected`。

- `Connect to an MCP server named "billing".`
  连接一个叫 "billing" 的 MCP server。

`billing` 不在 `MOCK_SERVERS` 里，返回 `Unknown server 'billing'. Available: docs, deploy`，不产生 `[mcp] connected` 那行。

## 7. Stop hook 汇总不区分内置/外部工具

跑完上面几轮后问一句会立即结束的问题，比如：

- `Say done.`
  说 done。

`[HOOK] Stop(summaryHook): session used N tool calls` 里的 N 应该把 `connect_mcp` 和所有 `mcp__*` 调用都算进去，因为计数逻辑（`summaryHook`）只看 history 里的 `tool_result` 块，不区分工具来源。

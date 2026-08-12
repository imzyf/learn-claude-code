/**
 * s14_mcp_plugin/main.test.ts
 *
 * 聚焦本章新增的 MCP 层：注册与调用边界、动态连接和工具池、名称安全、
 * 宿主权限策略，以及连接后下一轮才出现 MCP 工具的端到端循环。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
} from "../lib/testing";
import type { Confirm } from "../s03_permission/main";
import { createHooks } from "../s04_hooks/main";
import {
  agentLoop,
  assembleSystemPrompt,
  assembleToolPool,
  callTool,
  connectMcp,
  createMcpState,
  MCPClient,
  McpState,
  makeMcpPermissionHook,
  normalizeMcpName,
} from "./main";

const grant: Confirm = async () => true;
const refuse: Confirm = async () => false;

describe("MCPClient", () => {
  it("注册并调用发现到的工具", () => {
    const client = new MCPClient("math");
    client.register([{ name: "double", inputSchema: { type: "object" } }], {
      double: ({ n }) => Number(n) * 2,
    });

    expect(client.callTool("double", { n: 4 })).toBe("8");
    expect(client.callTool("missing", {})).toBe(
      "MCP error: unknown tool 'missing'",
    );
  });

  it("拒绝重复工具名和缺失 handler", () => {
    const duplicate = new MCPClient("bad");
    expect(() =>
      duplicate.register([{ name: "x" }, { name: "x" }], { x: () => "ok" }),
    ).toThrow("Duplicate MCP tool name");

    const missing = new MCPClient("bad");
    expect(() => missing.register([{ name: "x" }], {})).toThrow(
      "Missing MCP handlers: x",
    );
  });

  it("把 handler 异常收敛成 MCP error", () => {
    const client = new MCPClient("bad");
    client.register([{ name: "fail" }], {
      fail: () => {
        throw new TypeError("bad input");
      },
    });
    expect(client.callTool("fail", {})).toBe("MCP error: TypeError: bad input");
  });
});

describe("connectMcp / assembleToolPool", () => {
  it("初始只含内置工具，连接后发现带前缀的 MCP 工具", () => {
    const state = createMcpState();
    expect(assembleToolPool(state).tools.map((tool) => tool.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "connect_mcp",
    ]);

    expect(connectMcp("docs", state)).toContain("Discovered 2 tools");
    const pool = assembleToolPool(state);
    expect(pool.tools.map((tool) => tool.name)).toContain("mcp__docs__search");
    expect(pool.tools.map((tool) => tool.name)).toContain(
      "mcp__docs__get_version",
    );
    expect(assembleSystemPrompt(state)).toContain(
      "Connected MCP servers: docs",
    );

    const call = toolUseBlock("tu", "mcp__docs__search", {
      query: "hooks",
    });
    expect(callTool(call, pool.handlers)).toBe(
      "[docs] Found 3 results for 'hooks'",
    );
  });

  it("重复连接幂等，未知 server 返回可用列表", () => {
    const state = createMcpState();
    connectMcp("docs", state);
    expect(connectMcp("docs", state)).toBe(
      "MCP server 'docs' already connected",
    );
    expect(connectMcp("other", state)).toContain(
      "Unknown server 'other'. Available: docs, deploy",
    );
  });

  it("规范化名称并拒绝规范化后的碰撞", () => {
    expect(normalizeMcpName("docs.one/get version")).toBe(
      "docs_one_get_version",
    );

    const first = new MCPClient("docs.one");
    first.register([{ name: "search" }], { search: () => "one" });
    const second = new MCPClient("docs_one");
    second.register([{ name: "search" }], { search: () => "two" });
    const state = new McpState({
      "docs.one": () => first,
      docs_one: () => second,
    });
    connectMcp("docs.one", state);
    connectMcp("docs_one", state);
    expect(() => assembleToolPool(state)).toThrow(
      "MCP tool name collision after normalization",
    );
  });

  it("拒绝非 object input schema", () => {
    const server = new MCPClient("bad");
    server.register(
      [
        {
          name: "broken",
          inputSchema: { type: "string" },
        },
      ],
      { broken: () => "no" },
    );
    const state = new McpState({ bad: () => server });
    connectMcp("bad", state);
    expect(() => assembleToolPool(state)).toThrow("Invalid input schema");
  });
});

describe("MCP permission", () => {
  it("宿主 allow 策略直接放行只读工具", async () => {
    const state = createMcpState();
    connectMcp("docs", state);
    assembleToolPool(state);
    const confirm = vi.fn(refuse);
    const hook = makeMcpPermissionHook(state, confirm);

    expect(
      await hook(
        noopLogger,
        toolUseBlock("tu", "mcp__docs__search", { query: "hooks" }),
      ),
    ).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirm 策略按用户决定放行或拒绝", async () => {
    const state = createMcpState();
    connectMcp("deploy", state);
    assembleToolPool(state);
    const call = toolUseBlock("tu", "mcp__deploy__trigger", {
      service: "web",
    });

    expect(await makeMcpPermissionHook(state, refuse)(noopLogger, call)).toBe(
      "Permission denied by user",
    );
    expect(
      await makeMcpPermissionHook(state, grant)(noopLogger, call),
    ).toBeNull();
  });
});

describe("agentLoop", () => {
  it("连接后在下一轮暴露并调用 MCP 工具", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("connect", "connect_mcp", { name: "docs" })],
        "tool_use",
      ),
      fakeMessage(
        [
          toolUseBlock("search", "mcp__docs__search", {
            query: "agent hooks",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const state = createMcpState();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "search docs" },
    ];

    expect(
      await agentLoop(messages, {
        client,
        logger: noopLogger,
        hooks: createHooks(noopLogger),
        mcp: state,
      }),
    ).toBe("done");

    const calls = vi.mocked(client.messages.create).mock.calls;
    const firstTools = calls[0][0].tools ?? [];
    const secondTools = calls[1][0].tools ?? [];
    expect(firstTools.map((tool) => tool.name)).not.toContain(
      "mcp__docs__search",
    );
    expect(secondTools.map((tool) => tool.name)).toContain("mcp__docs__search");
    expect(calls[1][0].system).toContain("Connected MCP servers: docs");

    const resultMessage = messages[4];
    const results = resultMessage.content as Anthropic.ToolResultBlockParam[];
    expect(results[0].content).toBe("[docs] Found 3 results for 'agent hooks'");
  });
});

/**
 * s14_mcp_plugin/main.ts - MCP 工具
 *
 * 连接外部 server、发现工具，并把它们动态加入 Agent 的工具循环。
 *
 *     connect_mcp("docs")
 *               |
 *               v
 *     +------------------+     tools/list     +------------------+
 *     | Agent Harness    | <----------------- | MCP server       |
 *     |                  |                    | docs             |
 *     | built-in tools   |     tools/call     |                  |
 *     | + MCP tools      | -----------------> | search           |
 *     +--------+---------+                    | get_version      |
 *              |                              +------------------+
 *              v
 *     +-----------------------------------------------+
 *     | bash | read | write | edit | glob | connect  |
 *     | mcp__docs__search | mcp__docs__get_version   |
 *     +-----------------------------------------------+
 *
 * 相比 s04 的变化：
 *   基础工具和 Hook 系统继续复用，不再内联。本文件只新增 MCP 这一层：
 *   + MCPClient：保存 tools/list 的发现结果，并提供 tools/call 边界
 *   + McpState：保存跨轮连接、动态权限策略与可连接的 server factory
 *   + connectMcp：连接进程内模拟 server；下一轮才向模型暴露新工具
 *   + assembleToolPool：使用 mcp__{server}__{tool} 前缀合并动态工具
 *   + 名称规范化、64 字符限制、规范化后冲突检查与 input schema 检查
 *   + 宿主侧 MCP 权限策略；server annotations 只作元数据，不能自行授权
 *
 * 课程中的 docs / deploy 是进程内模拟 server，只展示 tools/list、tools/call
 * 与动态工具池；真实 MCP transport 留给产品级实现。
 *
 * Usage:
 *
 *     pnpm dev s14_mcp_plugin/main.ts
 */

import * as readline from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, type SessionLogger } from "../lib/logger";
import { createClient, MODEL_ID, type ModelClient } from "../lib/model";
import { colorize, print } from "../lib/terminal";
import { printProse, textOf, zodTool } from "../lib/tools";
import {
  TOOL_SCHEMAS as BASE_TOOL_SCHEMAS,
  tools as baseTools,
  errMsg,
  type Handlers,
} from "../s02_tool_use/main";
import {
  TOOL_HANDLERS as BASE_TOOL_HANDLERS,
  type Confirm,
  makeConfirm,
} from "../s03_permission/main";
import {
  contextInjectHook,
  createHooks,
  type Hook,
  type HookSystem,
  largeOutputHook,
  logHook,
  makePermissionHook,
  summaryHook,
} from "../s04_hooks/main";

const WORKDIR = process.cwd();

export const BASE_SYSTEM =
  `You are a coding agent at ${WORKDIR}. Use built-in and connected MCP ` +
  "tools to solve tasks. Call connect_mcp before using a server.";

// ═══════════════════════════════════════════════════════════
//  s14 新增：MCPClient —— tools/list 与 tools/call 的最小协议边界
// ═══════════════════════════════════════════════════════════

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type McpToolHandler = (args: Record<string, unknown>) => unknown;

// 真实 MCP 里 client 通过 transport（stdio / HTTP）和 server 通信；
// 这里把 server 放进同一进程，只保留协议里对 Agent 真正重要的两个动作：
//   tools/list -> 读 this.tools（连接时一次性发现）
//   tools/call -> callTool()（每次工具调用穿过这个边界）
export class MCPClient {
  tools: McpToolDefinition[] = [];
  private handlers = new Map<string, McpToolHandler>();

  constructor(public name: string) {}

  // register 相当于 server 端启动时声明自己有哪些工具。
  // 三个校验都在这里做完：连接后 tools 列表就是可信的，
  // assembleToolPool 不必再兜底 server 自己的定义错误。
  register(
    toolDefs: McpToolDefinition[],
    handlers: Record<string, McpToolHandler>,
  ): void {
    const names = toolDefs.map((tool) => tool.name);
    if (names.some((name) => typeof name !== "string" || name.length === 0)) {
      throw new Error("Every MCP tool needs a non-empty name");
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate MCP tool name on server '${this.name}'`);
    }
    const missing = names.filter((name) => !Object.hasOwn(handlers, name));
    if (missing.length) {
      throw new Error(`Missing MCP handlers: ${missing.join(", ")}`);
    }
    this.tools = [...toolDefs];
    this.handlers = new Map(Object.entries(handlers));
  }

  // 边界的意义：外部 server 的任何异常都不该掀翻 agent loop，
  // 统一转成字符串结果，最终作为 tool_result 回给模型让它自己纠错。
  callTool(toolName: string, args: Record<string, unknown>): string {
    const handler = this.handlers.get(toolName);
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try {
      return String(handler(args));
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      return `MCP error: ${name}: ${errMsg(e)}`;
    }
  }
}

// 模拟 Python 的 **kwargs：必填字符串缺失或出现额外参数时，都在 MCP 边界内报错。
function stringArg(
  args: Record<string, unknown>,
  key: string,
  allowed: string[],
): string {
  const extras = Object.keys(args).filter((name) => !allowed.includes(name));
  if (extras.length) {
    throw new TypeError(`unexpected argument '${extras[0]}'`);
  }
  const value = args[key];
  if (typeof value !== "string") {
    throw new TypeError(`argument '${key}' must be a string`);
  }
  return value;
}

function noArgs(args: Record<string, unknown>): void {
  const extra = Object.keys(args)[0];
  if (extra) throw new TypeError(`unexpected argument '${extra}'`);
}

// 两个模拟 server 的差别是刻意的：docs 全是只读工具，deploy 带一个
// destructiveHint 的 trigger，用来演示宿主策略如何区别对待（见 MCP_HOST_POLICY）。
export function createMockDocsServer(): MCPClient {
  const server = new MCPClient("docs");
  server.register(
    [
      {
        name: "search",
        description: "Search the documentation.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_version",
        description: "Get the documentation API version.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      search: (args) =>
        `[docs] Found 3 results for '${stringArg(args, "query", ["query"])}'`,
      get_version: (args) => {
        noArgs(args);
        return "[docs] API v2.1.0";
      },
    },
  );
  return server;
}

export function createMockDeployServer(): MCPClient {
  const server = new MCPClient("deploy");
  server.register(
    [
      {
        name: "trigger",
        description: "Trigger a deployment.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { destructiveHint: true },
      },
      {
        name: "status",
        description: "Check deployment status.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      trigger: (args) =>
        `[deploy] Triggered: ${stringArg(args, "service", ["service"])}`,
      status: (args) =>
        `[deploy] ${stringArg(args, "service", ["service"])}: running (v1.4.2)`,
    },
  );
  return server;
}

export type McpServerFactory = () => MCPClient;
export type McpPolicy = "allow" | "confirm";

export const MOCK_SERVERS: Readonly<Record<string, McpServerFactory>> = {
  docs: createMockDocsServer,
  deploy: createMockDeployServer,
};

// 用 NUL 拼 key，避免 server 名或 tool 名里带分隔符时，两组不同的
// (server, tool) 撞成同一个 key。
function policyKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

// 授权来自宿主配置，而不是 server 自己提供的 description / annotations。
export const MCP_HOST_POLICY: ReadonlyMap<string, McpPolicy> = new Map([
  [policyKey("docs", "search"), "allow"],
  [policyKey("docs", "get_version"), "allow"],
  [policyKey("deploy", "status"), "allow"],
  [policyKey("deploy", "trigger"), "confirm"],
]);

// 跨轮状态收进实例，而不是模块级变量：入口建一个，测试各建各的，互不污染
//（和 s04 的 createHooks 同一套思路）。
export class McpState {
  // 已连接的 server：连接在一轮工具调用后仍然有效，所以必须活在 agentLoop 之外。
  clients = new Map<string, MCPClient>();
  // 规范化后的模型工具名 -> 本轮宿主策略。每次 assembleToolPool 整体重建。
  toolPolicies = new Map<string, McpPolicy>();

  // servers / hostPolicy 做成构造参数，测试可以注入自己的 server 和策略表。
  constructor(
    public servers: Readonly<Record<string, McpServerFactory>> = MOCK_SERVERS,
    public hostPolicy: ReadonlyMap<string, McpPolicy> = MCP_HOST_POLICY,
  ) {}
}

export function createMcpState(): McpState {
  return new McpState();
}

// ═══════════════════════════════════════════════════════════
//  s14 新增：连接、命名与动态工具池
// ═══════════════════════════════════════════════════════════

// API 只接受 [a-zA-Z0-9_-] 的工具名，但 MCP server 可以叫任意名字
//（含点号、中文、空格），所以进工具池前必须先过一遍规范化。
const DISALLOWED_MCP_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

export function normalizeMcpName(name: string): string {
  const normalized = name.replace(DISALLOWED_MCP_NAME_CHARS, "_");
  if (!normalized) {
    throw new Error("MCP names cannot normalize to an empty string");
  }
  return normalized;
}

// 这是 connect_mcp 工具的 handler。注意它只往 state.clients 里塞一个 client，
// 不碰当前这轮的 tools 数组：模型要等下一轮 assembleToolPool 才看得见新工具。
// 返回值里列出发现的工具名，就是给模型的「下一轮你可以调这些」的提示。
export function connectMcp(name: string, state: McpState): string {
  if (state.clients.has(name)) {
    return `MCP server '${name}' already connected`;
  }
  const factory = state.servers[name];
  if (!factory) {
    return `Unknown server '${name}'. Available: ${Object.keys(state.servers).join(", ")}`;
  }
  const server = factory();
  state.clients.set(name, server);
  const names = server.tools.map((tool) => tool.name).join(", ");
  print(`  [mcp] connected: ${name} -> ${names}`, "gray");
  return (
    `Connected to MCP server '${name}'. ` +
    `Discovered ${server.tools.length} tools: ${names}`
  );
}

export const connectMcpSchema = z.object({
  name: z.enum(["docs", "deploy"]),
});

export const CONNECT_TOOL: Anthropic.Tool = zodTool(
  "connect_mcp",
  "Connect to an MCP server and discover its tools.",
  connectMcpSchema,
);

// 内置工具是固定的那一份；MCP 工具每轮从 state.clients 现算，不进这个数组。
export const BUILTIN_TOOLS: Anthropic.Tool[] = [...baseTools, CONNECT_TOOL];

export const TOOL_SCHEMAS: Partial<Record<string, z.ZodObject>> = {
  ...BASE_TOOL_SCHEMAS,
  connect_mcp: connectMcpSchema,
};

export type ToolPool = {
  tools: Anthropic.Tool[];
  handlers: Handlers;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 本节的核心：把「内置工具」和「已连接 server 的工具」合成模型这一轮能看到的
// 工具池。每轮重算，所以 connect_mcp 的效果自然会在下一轮生效。
export function assembleToolPool(state: McpState): ToolPool {
  const tools = [...BUILTIN_TOOLS];
  const handlers: Handlers = {
    ...BASE_TOOL_HANDLERS,
    connect_mcp: ({ name }) => connectMcp(name, state),
  };
  const policies = new Map<string, McpPolicy>();
  // origins 先装满内置工具名，这样 MCP 工具撞到 bash / read 时也会被拦下，
  // 报错信息里还能说清冲突的两边分别是谁。
  const origins = new Map(
    tools.map((tool) => [tool.name, `built-in tool '${tool.name}'`]),
  );

  for (const [serverName, server] of state.clients) {
    const safeServer = normalizeMcpName(serverName);
    for (const toolDef of server.tools) {
      const rawName = toolDef.name;
      const safeTool = normalizeMcpName(rawName);
      // mcp__{server}__{tool} 前缀有两个作用：避免和内置工具重名，
      // 以及让 hook 只看名字就能判断这是不是外部工具。
      const prefixed = `mcp__${safeServer}__${safeTool}`;
      // API 对工具名有 64 字符上限，超了必须在发请求前就失败。
      if (prefixed.length > 64) {
        throw new Error(
          `MCP tool name is longer than 64 characters: ${prefixed}`,
        );
      }

      // 规范化是多对一的：a.b 和 a-b 都会变成 a_b。撞名时宁可整轮失败，
      // 也不能让模型调 X 却打到 Y 上。
      const origin = `MCP tool '${serverName}/${rawName}'`;
      const previous = origins.get(prefixed);
      if (previous) {
        throw new Error(
          `MCP tool name collision after normalization: '${prefixed}' maps both ${previous} and ${origin}`,
        );
      }

      // schema 来自外部 server，直接转发会让整个 messages.create 报 400，
      // 所以在这里先确认它是个 object schema。
      const schema = toolDef.inputSchema ?? {};
      if (!isObject(schema) || (schema.type ?? "object") !== "object") {
        throw new Error(`Invalid input schema for ${origin}`);
      }

      origins.set(prefixed, origin);
      tools.push({
        name: prefixed,
        description: toolDef.description ?? "",
        input_schema: {
          ...schema,
          type: "object",
        } as Anthropic.Tool.InputSchema,
      });
      // 闭包捕获本次循环的 server 和原始 tool name；模型只看到 prefixed。
      handlers[prefixed] = (input) =>
        server.callTool(rawName, isObject(input) ? input : {});
      // 策略查宿主配置表，查不到就退回 confirm：未知的外部工具默认要人确认，
      // 而不是默认放行。toolDef.annotations 只是元数据，不参与这个决定。
      policies.set(
        prefixed,
        state.hostPolicy.get(policyKey(serverName, rawName)) ?? "confirm",
      );
    }
  }

  // 先完整组装成功再替换策略，失败时不留下半轮状态。
  state.toolPolicies = policies;
  return { tools, handlers };
}

// system prompt 也跟着连接状态变：模型知道哪些 server 已连上，就不会
// 对着已连接的 server 再调一次 connect_mcp。
export function assembleSystemPrompt(state: McpState): string {
  if (!state.clients.size) return BASE_SYSTEM;
  return (
    BASE_SYSTEM +
    `\n\nConnected MCP servers: ${[...state.clients.keys()].join(", ")}`
  );
}

// ═══════════════════════════════════════════════════════════
//  s14 新增：外部工具权限 Hook
// ═══════════════════════════════════════════════════════════

// 工厂函数闭包捕获 state 和 confirm，返回 hook 本体（s04 的 makePermissionHook 同款手法）。
export function makeMcpPermissionHook(state: McpState, confirm: Confirm): Hook {
  return async function mcpPermissionHook(
    _logger: SessionLogger,
    call: Anthropic.ToolUseBlock,
  ): Promise<string | null> {
    // 只管外部工具，内置工具交给 s04 的 permissionHook。
    if (!call.name.startsWith("mcp__")) return null;
    // 查不到策略同样退回 confirm，比如工具池刚被重建、策略表还没覆盖到它。
    const policy = state.toolPolicies.get(call.name) ?? "confirm";
    if (policy === "allow") return null;
    const allowed = await confirm(call, `External tool ${call.name}`);
    return allowed ? null : "Permission denied by user";
  };
}

// s04 默认 hook 的装配方式原样保留，在 permission 与日志之间插入 MCP 权限层。
export function loadMcpHooks(
  logger: SessionLogger,
  confirm: Confirm,
  state: McpState,
): HookSystem {
  const hooks = createHooks(logger);
  hooks.register("UserPromptSubmit", contextInjectHook);
  hooks.register("PreToolUse", makePermissionHook(confirm));
  hooks.register("PreToolUse", makeMcpPermissionHook(state, confirm));
  hooks.register("PreToolUse", logHook);
  hooks.register("PostToolUse", largeOutputHook);
  hooks.register("Stop", summaryHook);
  hooks.logRegistration();
  return hooks;
}

// ═══════════════════════════════════════════════════════════
//  Agent loop —— 每轮重新组装动态工具池
// ═══════════════════════════════════════════════════════════

export type Deps = {
  client: ModelClient;
  logger: SessionLogger;
  hooks: HookSystem;
  mcp: McpState;
};

// 查表 + 基础工具 schema 校验；所有异常都收敛成 tool_result 文本。
export function callTool(
  block: Anthropic.ToolUseBlock,
  handlers: Handlers,
): string {
  const handler = handlers[block.name];
  if (!handler) return `Unknown: ${block.name}`;
  try {
    // MCP 工具在 TOOL_SCHEMAS 里查不到（它们的 schema 由 server 提供），
    // 参数校验交给 MCPClient 那一侧的 stringArg / noArgs。
    const schema = TOOL_SCHEMAS[block.name];
    return handler(schema ? schema.parse(block.input) : block.input);
  } catch (e) {
    return `Error: ${errMsg(e)}`;
  }
}

export async function agentLoop(
  messages: Anthropic.MessageParam[],
  deps: Deps,
): Promise<string> {
  const { client, logger, hooks, mcp } = deps;

  while (true) {
    // s14 的关键改动：工具池在循环内部、每轮请求前重算。
    // s04 是把固定的 tools 传进去，这里 tools 会随连接状态变化。
    let pool: ToolPool;
    try {
      pool = assembleToolPool(mcp);
    } catch (e) {
      // 组装失败（撞名、超长、schema 非法）不抛给调用方，
      // 和请求失败一样收敛成一条 assistant 消息后结束本轮。
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      await hooks.trigger("Stop", messages);
      return errText;
    }

    logger.request(messages);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL_ID,
        system: assembleSystemPrompt(mcp),
        messages,
        tools: pool.tools,
        max_tokens: 8000,
      });
    } catch (e) {
      logger.responseError(e);
      const name = e instanceof Error ? e.name : "Error";
      const errText = `[Error] ${name}: ${errMsg(e)}`;
      messages.push({ role: "assistant", content: errText });
      await hooks.trigger("Stop", messages);
      return errText;
    }

    logger.response(response);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = await hooks.trigger("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return textOf(response);
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      printProse(block);
      if (block.type !== "tool_use") continue;

      const blocked = await hooks.trigger("PreToolUse", block);
      const output = blocked ?? callTool(block, pool.handlers);
      logger.toolResult(block.name, output);
      await hooks.trigger("PostToolUse", block, output);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });
  }
}

// ── 入口 ──────────────────────────────────────────
if (import.meta.main) {
  const client = createClient();
  const logger = createLogger(import.meta.dirname);
  const mcp = createMcpState();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });

  const hooks = loadMcpHooks(logger, makeConfirm(rl, logger), mcp);
  // 启动时只有内置工具可记；MCP 工具要等连接之后才存在，
  // 它们的出现由 connectMcp 的 [mcp] connected 那行体现。
  logger.config({
    model: MODEL_ID,
    system: BASE_SYSTEM,
    tools: BUILTIN_TOOLS,
  });

  print("s14: MCP tools — 发现并调用外部工具", "cyan");
  print("输入问题，回车发送。输入 q 退出。\n", "green");

  const history: Anthropic.MessageParam[] = [];
  while (true) {
    let query: string;
    try {
      query = await rl.question(colorize("s14 >> ", "cyan"));
    } catch {
      break;
    }
    const q = query.trim().toLowerCase();
    if (q === "" || q === "q" || q === "exit") break;
    logger.userInput(query);

    await hooks.trigger("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history, { client, logger, hooks, mcp });
    print(finalText, "green");
    print();
  }
  rl.close();
}

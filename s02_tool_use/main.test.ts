/**
 * s02_tool_use/main.test.ts
 *
 * 文件工具（runRead / runWrite / runEdit / runGlob）在仓库内的临时目录里
 * 真实读写，验证越界拦截和各自的边界行为。
 * agentLoop：用 fake client 验证 TOOL_HANDLERS 按 tool name 分发。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
  useTempDir,
} from "../lib/testing";
import {
  agentLoop,
  runEdit,
  runGlob,
  runRead,
  runWrite,
  safePath,
} from "./main";

let tmp: string;
const rel = useTempDir(import.meta.dirname, (dir) => {
  tmp = dir;
});

// ── safePath ──────────────────────────────────────────────
describe("safePath", () => {
  it("解析工作区内的相对路径", () => {
    expect(safePath("a/b.txt")).toBe(path.join(process.cwd(), "a/b.txt"));
  });

  it("允许工作区根目录本身", () => {
    expect(safePath(".")).toBe(process.cwd());
  });

  it("路径越出工作区时抛出异常", () => {
    expect(() => safePath("../outside.txt")).toThrow(/escapes workspace/);
    expect(() => safePath("/etc/passwd")).toThrow(/escapes workspace/);
  });
});

// ── runRead ───────────────────────────────────────────────
describe("runRead", () => {
  it("读取文件内容", () => {
    fs.writeFileSync(path.join(tmp, "read.txt"), "line1\nline2");
    expect(runRead(rel("read.txt"))).toBe("line1\nline2");
  });

  it("按上限截断并报告剩余行数", () => {
    fs.writeFileSync(path.join(tmp, "long.txt"), "a\nb\nc\nd");
    expect(runRead(rel("long.txt"), 2)).toBe("a\nb\n... (2 more lines)");
  });

  it("文件不存在时返回错误", () => {
    expect(runRead(rel("nope.txt"))).toMatch(/^Error: /);
  });

  it("路径越界时返回错误而不是抛出异常", () => {
    expect(runRead("../outside.txt")).toMatch(/^Error: Path escapes/);
  });
});

// ── runWrite ──────────────────────────────────────────────
describe("runWrite", () => {
  it("写入内容并报告字节数", () => {
    expect(runWrite(rel("write.txt"), "hello")).toBe(
      `Wrote 5 bytes to ${rel("write.txt")}`,
    );
    expect(fs.readFileSync(path.join(tmp, "write.txt"), "utf8")).toBe("hello");
  });

  it("创建缺失的父目录", () => {
    runWrite(rel("deep/nested/file.txt"), "x");
    expect(fs.existsSync(path.join(tmp, "deep/nested/file.txt"))).toBe(true);
  });

  it("路径越界时返回错误而不是抛出异常", () => {
    expect(runWrite("../outside.txt", "x")).toMatch(/^Error: Path escapes/);
  });
});

// ── runEdit ───────────────────────────────────────────────
describe("runEdit", () => {
  it("只替换第一次出现的内容", () => {
    fs.writeFileSync(path.join(tmp, "edit.txt"), "foo bar foo");
    expect(runEdit(rel("edit.txt"), "foo", "baz")).toBe(
      `Edited ${rel("edit.txt")}`,
    );
    expect(fs.readFileSync(path.join(tmp, "edit.txt"), "utf8")).toBe(
      "baz bar foo",
    );
  });

  it("相邻重复内容只替换第一个", () => {
    fs.writeFileSync(path.join(tmp, "repeat.txt"), "abcabcab abc");
    runEdit(rel("repeat.txt"), "abc", "def");
    expect(fs.readFileSync(path.join(tmp, "repeat.txt"), "utf8")).toBe(
      "defabcab abc",
    );
  });

  it("按字面值插入替换模式字符", () => {
    fs.writeFileSync(path.join(tmp, "dollar.txt"), "abc");
    runEdit(rel("dollar.txt"), "b", "$&$'");
    expect(fs.readFileSync(path.join(tmp, "dollar.txt"), "utf8")).toBe(
      "a$&$'c",
    );
  });

  it("找不到文本时返回错误", () => {
    fs.writeFileSync(path.join(tmp, "miss.txt"), "abc");
    expect(runEdit(rel("miss.txt"), "zzz", "x")).toMatch(
      /^Error: text not found/,
    );
  });

  it("文件不存在时返回错误", () => {
    expect(runEdit(rel("nope.txt"), "a", "b")).toMatch(/^Error: /);
  });
});

// ── runGlob ───────────────────────────────────────────────
describe("runGlob", () => {
  it("列出匹配的文件", () => {
    fs.writeFileSync(path.join(tmp, "g1.mjsx"), "");
    fs.writeFileSync(path.join(tmp, "g2.mjsx"), "");
    const out = runGlob(rel("*.mjsx"));
    expect(out.split("\n").sort()).toEqual([rel("g1.mjsx"), rel("g2.mjsx")]);
  });

  it("没有匹配项时返回占位符", () => {
    expect(runGlob(rel("*.does-not-exist"))).toBe("(no matches)");
  });
});

// ── agentLoop：按 tool name 分发 ──────────────────────────
describe("agentLoop", () => {
  it("分发给与工具名称匹配的处理器", async () => {
    fs.writeFileSync(path.join(tmp, "loop.txt"), "from file");
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "read_file", { path: rel("loop.txt") })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "read it" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("done");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].tool_use_id).toBe("tu_1");
    expect(toolResults[0].content).toBe("from file");
  });

  it("按顺序处理单次响应中的混合工具调用", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_a", "bash", { command: "echo hi" }),
          toolUseBlock("tu_b", "write_file", {
            path: rel("mix.txt"),
            content: "ok",
          }),
        ],
        "tool_use",
      ),
      fakeMessage([textBlock("ok")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "do both" },
    ];

    await agentLoop(messages, { client, logger: noopLogger });

    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults.map((r) => r.content)).toEqual([
      "hi",
      `Wrote 2 bytes to ${rel("mix.txt")}`,
    ]);
  });

  it("未注册工具返回 Unknown 结果并继续循环", async () => {
    const client = fakeClient(
      fakeMessage([toolUseBlock("tu_x", "no_such_tool", {})], "tool_use"),
      fakeMessage([textBlock("recovered")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "x" }];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("recovered");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Unknown: no_such_tool");
  });

  it("拒绝不符合 schema 的工具输入", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_bad", "read_file", { path: 123 })],
        "tool_use",
      ),
    );

    await expect(
      agentLoop([{ role: "user", content: "x" }], {
        client,
        logger: noopLogger,
      }),
    ).rejects.toThrow();
  });
});

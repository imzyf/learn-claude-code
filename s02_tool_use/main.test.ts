/**
 * s02_tool_use/main.test.ts
 *
 * 文件工具（runRead / runWrite / runEdit / runGlob）在仓库内的临时目录里
 * 真实读写，验证越界拦截和各自的边界行为。
 * agentLoop：用 fake client 验证 TOOL_HANDLERS 按 tool name 分发。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
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
const rel = useTempDir("s02", (dir) => {
  tmp = dir;
});

// ── safePath ──────────────────────────────────────────────
describe("safePath", () => {
  it("resolves a relative path inside the workspace", () => {
    expect(safePath("a/b.txt")).toBe(path.join(process.cwd(), "a/b.txt"));
  });

  it("allows the workspace root itself", () => {
    expect(safePath(".")).toBe(process.cwd());
  });

  it("throws when the path escapes the workspace", () => {
    expect(() => safePath("../outside.txt")).toThrow(/escapes workspace/);
    expect(() => safePath("/etc/passwd")).toThrow(/escapes workspace/);
  });
});

// ── runRead ───────────────────────────────────────────────
describe("runRead", () => {
  it("reads file contents", () => {
    fs.writeFileSync(path.join(tmp, "read.txt"), "line1\nline2");
    expect(runRead(rel("read.txt"))).toBe("line1\nline2");
  });

  it("truncates to limit and reports remaining lines", () => {
    fs.writeFileSync(path.join(tmp, "long.txt"), "a\nb\nc\nd");
    expect(runRead(rel("long.txt"), 2)).toBe("a\nb\n... (2 more lines)");
  });

  it("returns an error for a missing file", () => {
    expect(runRead(rel("nope.txt"))).toMatch(/^Error: /);
  });

  it("returns an error instead of throwing on path escape", () => {
    expect(runRead("../outside.txt")).toMatch(/^Error: Path escapes/);
  });
});

// ── runWrite ──────────────────────────────────────────────
describe("runWrite", () => {
  it("writes content and reports byte count", () => {
    expect(runWrite(rel("write.txt"), "hello")).toBe(
      `Wrote 5 bytes to ${rel("write.txt")}`,
    );
    expect(fs.readFileSync(path.join(tmp, "write.txt"), "utf8")).toBe("hello");
  });

  it("creates missing parent directories", () => {
    runWrite(rel("deep/nested/file.txt"), "x");
    expect(fs.existsSync(path.join(tmp, "deep/nested/file.txt"))).toBe(true);
  });

  it("returns an error instead of throwing on path escape", () => {
    expect(runWrite("../outside.txt", "x")).toMatch(/^Error: Path escapes/);
  });
});

// ── runEdit ───────────────────────────────────────────────
describe("runEdit", () => {
  it("replaces only the first occurrence", () => {
    fs.writeFileSync(path.join(tmp, "edit.txt"), "foo bar foo");
    expect(runEdit(rel("edit.txt"), "foo", "baz")).toBe(
      `Edited ${rel("edit.txt")}`,
    );
    expect(fs.readFileSync(path.join(tmp, "edit.txt"), "utf8")).toBe(
      "baz bar foo",
    );
  });

  it("replaces only the first of adjacent repeats", () => {
    fs.writeFileSync(path.join(tmp, "repeat.txt"), "abcabcab abc");
    runEdit(rel("repeat.txt"), "abc", "def");
    expect(fs.readFileSync(path.join(tmp, "repeat.txt"), "utf8")).toBe(
      "defabcab abc",
    );
  });

  it("inserts replacement-pattern characters literally", () => {
    fs.writeFileSync(path.join(tmp, "dollar.txt"), "abc");
    runEdit(rel("dollar.txt"), "b", "$&$'");
    expect(fs.readFileSync(path.join(tmp, "dollar.txt"), "utf8")).toBe(
      "a$&$'c",
    );
  });

  it("returns an error when the text is not found", () => {
    fs.writeFileSync(path.join(tmp, "miss.txt"), "abc");
    expect(runEdit(rel("miss.txt"), "zzz", "x")).toMatch(/^Error: text not found/);
  });

  it("returns an error for a missing file", () => {
    expect(runEdit(rel("nope.txt"), "a", "b")).toMatch(/^Error: /);
  });
});

// ── runGlob ───────────────────────────────────────────────
describe("runGlob", () => {
  it("lists matching files", () => {
    fs.writeFileSync(path.join(tmp, "g1.mjsx"), "");
    fs.writeFileSync(path.join(tmp, "g2.mjsx"), "");
    const out = runGlob(rel("*.mjsx"));
    expect(out.split("\n").sort()).toEqual([rel("g1.mjsx"), rel("g2.mjsx")]);
  });

  it("returns placeholder when nothing matches", () => {
    expect(runGlob(rel("*.does-not-exist"))).toBe("(no matches)");
  });
});

// ── agentLoop：按 tool name 分发 ──────────────────────────
describe("agentLoop", () => {
  it("dispatches to the handler matching the tool name", async () => {
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

  it("handles mixed tool calls in one response, in order", async () => {
    const client = fakeClient(
      fakeMessage(
        [
          toolUseBlock("tu_a", "bash", { command: "echo hi" }),
          toolUseBlock("tu_b", "write_file", { path: rel("mix.txt"), content: "ok" }),
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

  it("returns an Unknown result for an unregistered tool and keeps looping", async () => {
    const client = fakeClient(
      fakeMessage([toolUseBlock("tu_x", "no_such_tool", {})], "tool_use"),
      fakeMessage([textBlock("recovered")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "x" },
    ];

    const result = await agentLoop(messages, { client, logger: noopLogger });

    expect(result).toBe("recovered");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("Unknown: no_such_tool");
  });

  it("rejects tool input that does not match the schema", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_bad", "read_file", { path: 123 })],
        "tool_use",
      ),
    );

    await expect(
      agentLoop([{ role: "user", content: "x" }], { client, logger: noopLogger }),
    ).rejects.toThrow();
  });
});

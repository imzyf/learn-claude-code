/**
 * s07_skill_loading/main.test.ts
 *
 * s07 的新增点是两级技能加载：启动扫描 skills/ 目录得到 registry，
 * SYSTEM 里只放名称+描述（便宜），完整 SKILL.md 由 load_skill 工具按需注入（昂贵）。
 * 扫描/解析都是纯函数（传目录或 registry，不依赖模块级全局），可直接单测；
 * agentLoop 通过 load_skill 工具分发，用 fake client + 内存 registry 验证。
 * 其余（基础工具、permissionHook）沿用 s02/s05，其测试不在此重复。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { SessionLogger } from "../lib/logger";
import {
  fakeClient,
  fakeMessage,
  noopLogger,
  textBlock,
  toolUseBlock,
  useTempDir,
} from "../lib/testing";
import { createHooks } from "../s04_hooks/main";
import {
  agentLoop,
  buildSystem,
  listSkills,
  loadSkill,
  parseFrontmatter,
  runLoadSkill,
  type SkillRegistry,
  scanSkills,
} from "./main";

// 探针 logger：截获 skill 写进 transcript 的 SKILL 摘要，验证专属 skill 日志通道。
function spyLogger(): { logger: SessionLogger; logged: string[] } {
  const logged: string[] = [];
  const logger: SessionLogger = {
    ...noopLogger,
    section: (title, body) => {
      if (title === "SKILL") logged.push(body);
    },
  };
  return { logger, logged };
}

// 内存 registry：loadSkill / agentLoop 的技能查表无需碰文件系统。
const registry: SkillRegistry = {
  "code-review": {
    name: "code-review",
    description: "Review a diff for bugs.",
    content: "FULL code-review content",
  },
  pdf: {
    name: "pdf",
    description: "Work with PDFs.",
    content: "FULL pdf content",
  },
};

// ── parseFrontmatter ──────────────────────────────────────
describe("parseFrontmatter", () => {
  it("把 frontmatter 的 meta 和正文 body 分开", () => {
    const { meta, body } = parseFrontmatter(
      "---\nname: x\ndescription: hello\n---\n# Title\n\nbody",
    );
    expect(meta.name).toBe("x");
    expect(meta.description).toBe("hello");
    expect(body).toBe("# Title\n\nbody");
  });

  it("去掉值两侧的引号", () => {
    expect(parseFrontmatter(`---\nname: "quoted"\n---\nx`).meta.name).toBe(
      "quoted",
    );
  });

  it("没有 frontmatter 时整段文本都算 body", () => {
    const { meta, body } = parseFrontmatter("# just markdown");
    expect(meta).toEqual({});
    expect(body).toBe("# just markdown");
  });

  it("正文里靠后的 '---' 会保留（按下标切，不是 split 截断）", () => {
    const { body } = parseFrontmatter("---\nname: x\n---\nabove\n---\nbelow");
    expect(body).toBe("above\n---\nbelow");
  });

  it("能解析多行块标量（交给 yaml 库，不逐行解析）", () => {
    const { meta, body } = parseFrontmatter(
      "---\nname: x\ndescription: |\n  First line.\n  Second line.\n---\nbody",
    );
    expect(meta.description).toBe("First line.\nSecond line.\n");
    expect(body).toBe("body");
  });

  it("frontmatter 不是合法 YAML 时退回空 meta", () => {
    const { meta, body } = parseFrontmatter("---\nkey: [unclosed\n---\nbody");
    expect(meta).toEqual({});
    expect(body).toBe("body");
  });
});

// ── scanSkills (real files in a temp dir) ─────────────────
describe("scanSkills", () => {
  let dir = "";

  useTempDir(import.meta.dirname, (d) => {
    dir = d;
    const skill = (name: string, body: string) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, "SKILL.md"), body);
    };
    skill(
      "code-review",
      "---\nname: code-review\ndescription: Review a diff.\n---\nbody",
    );
    skill("pdf", "# PDF tools\n\nno frontmatter here");
    skill(
      "mcp-builder",
      "---\nname: mcp-builder\ndescription: |\n  Build MCP servers.\n  Second line.\n---\nbody",
    );
    fs.mkdirSync(path.join(dir, "not-a-skill"), { recursive: true }); // no SKILL.md → skipped
    fs.writeFileSync(path.join(dir, "loose.txt"), "ignored"); // top-level file → skipped
  });

  it("目录不存在时返回空 registry", () => {
    expect(scanSkills(path.join(dir, "nope"))).toEqual({});
  });

  it("只收录带 SKILL.md 的目录，其余跳过", () => {
    const reg = scanSkills(dir);
    expect(Object.keys(reg).sort()).toEqual([
      "code-review",
      "mcp-builder",
      "pdf",
    ]);
  });

  it("把多行 description 压成目录里的一行", () => {
    expect(scanSkills(dir)["mcp-builder"].description).toBe(
      "Build MCP servers. Second line.",
    );
  });

  it("name 与 description 优先取 frontmatter", () => {
    const reg = scanSkills(dir);
    expect(reg["code-review"].description).toBe("Review a diff.");
    expect(reg["code-review"].content).toContain("body");
  });

  it("没有 frontmatter 时退回目录名与正文首行标题", () => {
    const reg = scanSkills(dir);
    expect(reg.pdf.name).toBe("pdf"); // key/name from the directory
    expect(reg.pdf.description).toBe("PDF tools"); // description from the heading
  });
});

// ── listSkills / buildSystem ──────────────────────────────
describe("catalog", () => {
  it("每个技能列一行：名称加描述", () => {
    expect(listSkills(registry)).toBe(
      "- code-review: Review a diff for bugs.\n- pdf: Work with PDFs.",
    );
  });

  it("一个技能都没有时给出提示文案", () => {
    expect(listSkills({})).toBe("(no skills found)");
  });

  it("把技能目录嵌进 SYSTEM prompt", () => {
    const system = buildSystem(registry);
    expect(system).toContain("code-review");
    expect(system).toContain("load_skill");
  });
});

// ── loadSkill ─────────────────────────────────────────────
describe("loadSkill", () => {
  it("按名称返回完整内容", () => {
    expect(loadSkill(registry, "code-review")).toBe("FULL code-review content");
  });

  it("查不到时返回可选名字，而不是抛异常", () => {
    expect(loadSkill(registry, "ghost")).toBe(
      "Error: Unknown skill 'ghost'. Available: code-review, pdf",
    );
  });

  it("registry 为空时可选名字是 none", () => {
    expect(loadSkill({}, "ghost")).toBe(
      "Error: Unknown skill 'ghost'. Available: none",
    );
  });
});

// ── runLoadSkill: 专属 skill 日志通道 ─────────────────────
describe("runLoadSkill", () => {
  it("返回内容，并把这次命中记进专属 skill 日志通道", () => {
    const { logger, logged } = spyLogger();

    const out = runLoadSkill("code-review", {
      client: fakeClient(),
      logger,
      hooks: createHooks(noopLogger),
      skills: registry,
      system: "",
    });

    expect(out).toBe("FULL code-review content");
    expect(logged).toEqual([
      `load code-review (${"FULL code-review content".length} chars)`,
    ]);
  });

  it("未命中时照样记日志并返回错误文案，不抛异常", () => {
    const { logger, logged } = spyLogger();

    const out = runLoadSkill("ghost", {
      client: fakeClient(),
      logger,
      hooks: createHooks(noopLogger),
      skills: registry,
      system: "",
    });

    expect(out).toBe(
      "Error: Unknown skill 'ghost'. Available: code-review, pdf",
    );
    expect(logged[0]).toBe("not found: ghost");
  });
});

// ── agentLoop: load_skill dispatch ────────────────────────
describe("agentLoop", () => {
  it("分发 load_skill，把完整内容作为 tool_result 注入", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "load_skill", { name: "code-review" })],
        "tool_use",
      ),
      fakeMessage([textBlock("used the skill")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "review this" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      skills: registry,
      system: buildSystem(registry),
    });

    expect(result).toBe("used the skill");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("FULL code-review content");
  });

  it("执行一次普通工具调用", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "bash", { command: "echo hi" })],
        "tool_use",
      ),
      fakeMessage([textBlock("done")], "end_turn"),
    );
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "go" },
    ];

    const result = await agentLoop(messages, {
      client,
      logger: noopLogger,
      hooks: createHooks(noopLogger),
      skills: {},
      system: "test",
    });

    expect(result).toBe("done");
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("hi");
  });
});

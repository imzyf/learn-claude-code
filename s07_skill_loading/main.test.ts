/**
 * s07_skill_loading/main.test.ts
 *
 * s07 的新增点是两级技能加载：启动扫描 skills/ 目录得到 registry，
 * SYSTEM 里只放名称+描述（便宜），完整 SKILL.md 由 load_skill 工具按需注入（昂贵）。
 * 扫描/解析都是纯函数（传目录或 registry，不依赖模块级全局），可直接单测；
 * agentLoop 通过 load_skill 工具分发，用 fake client + 内存 registry 验证。
 * 其余（subagent 隔离、permissionHook、todo）沿用 s05/s06，其测试不在此重复。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
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
// s05/s06 的层沿用旧实现，各自的测试不在此重复；这里只借 resetNagCounter 做 setup。
import { resetNagCounter } from "../s05_todo_write/main";
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

beforeEach(() => {
  resetNagCounter();
});

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
  it("splits meta from body", () => {
    const { meta, body } = parseFrontmatter(
      "---\nname: x\ndescription: hello\n---\n# Title\n\nbody",
    );
    expect(meta.name).toBe("x");
    expect(meta.description).toBe("hello");
    expect(body).toBe("# Title\n\nbody");
  });

  it("strips surrounding quotes from values", () => {
    expect(parseFrontmatter(`---\nname: "quoted"\n---\nx`).meta.name).toBe(
      "quoted",
    );
  });

  it("returns the whole text as body when there is no frontmatter", () => {
    const { meta, body } = parseFrontmatter("# just markdown");
    expect(meta).toEqual({});
    expect(body).toBe("# just markdown");
  });

  it("keeps a later '---' in the body (index slice, not split truncation)", () => {
    const { body } = parseFrontmatter("---\nname: x\n---\nabove\n---\nbelow");
    expect(body).toBe("above\n---\nbelow");
  });

  it("parses a multi-line block scalar (yaml lib, not line-by-line parsing)", () => {
    const { meta, body } = parseFrontmatter(
      "---\nname: x\ndescription: |\n  First line.\n  Second line.\n---\nbody",
    );
    expect(meta.description).toBe("First line.\nSecond line.\n");
    expect(body).toBe("body");
  });

  it("falls back to empty meta when the frontmatter is invalid YAML", () => {
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
    fs.mkdirSync(path.join(dir, "not-a-skill"), { recursive: true }); // no SKILL.md → skipped
    fs.writeFileSync(path.join(dir, "loose.txt"), "ignored"); // top-level file → skipped
  });

  it("returns an empty registry for a missing directory", () => {
    expect(scanSkills(path.join(dir, "nope"))).toEqual({});
  });

  it("indexes each dir that has a SKILL.md and skips the rest", () => {
    const reg = scanSkills(dir);
    expect(Object.keys(reg).sort()).toEqual(["code-review", "pdf"]);
  });

  it("prefers frontmatter name/description over fallbacks", () => {
    const reg = scanSkills(dir);
    expect(reg["code-review"].description).toBe("Review a diff.");
    expect(reg["code-review"].content).toContain("body");
  });

  it("falls back to the dir name and first heading when frontmatter is absent", () => {
    const reg = scanSkills(dir);
    expect(reg.pdf.name).toBe("pdf"); // key/name from the directory
    expect(reg.pdf.description).toBe("PDF tools"); // description from the heading
  });
});

// ── listSkills / buildSystem ──────────────────────────────
describe("catalog", () => {
  it("lists each skill as a bullet with its description", () => {
    expect(listSkills(registry)).toBe(
      "- **code-review**: Review a diff for bugs.\n- **pdf**: Work with PDFs.",
    );
  });

  it("reports when there are no skills", () => {
    expect(listSkills({})).toBe("(no skills found)");
  });

  it("embeds the catalog in the SYSTEM prompt", () => {
    const system = buildSystem(registry);
    expect(system).toContain("code-review");
    expect(system).toContain("load_skill");
  });
});

// ── loadSkill ─────────────────────────────────────────────
describe("loadSkill", () => {
  it("returns the full content by name", () => {
    expect(loadSkill(registry, "code-review")).toBe("FULL code-review content");
  });

  it("reports a miss instead of throwing", () => {
    expect(loadSkill(registry, "ghost")).toBe("Skill not found: ghost");
  });
});

// ── runLoadSkill: 专属 skill 日志通道 ─────────────────────
describe("runLoadSkill", () => {
  it("returns content and logs the hit through the dedicated skill channel", () => {
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

  it("logs a miss without throwing and still returns the not-found text", () => {
    const { logger, logged } = spyLogger();

    const out = runLoadSkill("ghost", {
      client: fakeClient(),
      logger,
      hooks: createHooks(noopLogger),
      skills: registry,
      system: "",
    });

    expect(out).toBe("Skill not found: ghost");
    expect(logged[0]).toBe("not found: ghost");
  });
});

// ── agentLoop: load_skill + task dispatch ─────────────────
describe("agentLoop", () => {
  it("dispatches load_skill and injects the full content as the tool result", async () => {
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

  it("dispatches the task tool to a subagent and keeps only its summary", async () => {
    const client = fakeClient(
      fakeMessage(
        [toolUseBlock("tu_1", "task", { description: "sub work" })],
        "tool_use",
      ),
      fakeMessage([textBlock("sub result")], "end_turn"), // subagent's own turn
      fakeMessage([textBlock("parent done")], "end_turn"), // parent resumes
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

    expect(result).toBe("parent done");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
    const toolResults = messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(toolResults[0].content).toBe("sub result");
  });

  it("executes a plain tool call", async () => {
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

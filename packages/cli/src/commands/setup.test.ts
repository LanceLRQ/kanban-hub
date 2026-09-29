import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { EXIT } from "../errors";
import { main } from "../main";

function fakeContext(homeDir: string, overrides: Partial<CliContext> = {}): { ctx: CliContext; stdout: () => string } {
  let stdout = "";
  const ctx: CliContext = {
    cwd: "/tmp",
    env: {},
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-09-29T10:20:30"),
    platform: "linux",
    hostname: "test-host",
    homeDir,
    fetch: (() => {
      throw new Error("不应该在 setup 命令测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
  return { ctx, stdout: () => stdout };
}

const dirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-setup-cmd-test-"));
  dirs.push(dir);
  return fs.realpath(dir);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

/** 递归列出目录下所有文件（相对路径，按字典序），供前后快照比较 */
async function listFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(full)));
    } else {
      files.push(full);
    }
  }
  return files.sort();
}

/** 一份文件快照：路径 -> 内容与修改时间，用于比对“完全没有变化” */
type FileSnapshot = Record<string, { content: string; mtimeMs: number }>;

async function snapshotHome(home: string): Promise<FileSnapshot> {
  const files = await listFilesRecursively(home);
  const snapshot: FileSnapshot = {};
  for (const file of files) {
    const [content, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    snapshot[path.relative(home, file)] = { content, mtimeMs: stat.mtimeMs };
  }
  return snapshot;
}

describe("kh setup --dry-run", () => {
  it("退出码 0，只打印计划，不写入任何内容", async () => {
    const home = await tempHome();
    const { ctx, stdout } = fakeContext(home);

    const before = await fs.readdir(home).catch(() => []);
    const code = await main(["setup", "--dry-run"], ctx);
    const after = await fs.readdir(home).catch(() => []);

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("通用 skill");
    expect(after).toEqual(before);
  });

  it("主目录已有一批文件（含需要更新的 skill、需要添加 hook 的 settings.json）：--dry-run 前后全部文件的内容与修改时间完全不变，也不会新增文件", async () => {
    const home = await tempHome();

    // 预置一份内容与源码不同的旧 SKILL.md：计划里会是“更新”
    const oldAgentSkillPath = path.join(home, ".agents", "skills", "kanban-hub", "SKILL.md");
    await fs.mkdir(path.dirname(oldAgentSkillPath), { recursive: true });
    await fs.writeFile(oldAgentSkillPath, "旧版本的 skill 正文，和当前源码不一样");

    // 预置 ~/.claude/，带一份已有其他 hook、还没有本工具 hook 的 settings.json：计划里会是“添加 hook”
    const claudeDir = path.join(home, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    const settingsFile = path.join(claudeDir, "settings.json");
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }] } }, null, 2),
    );

    // 再放一份与本工具无关的文件，确认它也完全不受影响
    const untouchedFile = path.join(home, "untouched.txt");
    await fs.writeFile(untouchedFile, "不相关的文件");

    const { ctx, stdout } = fakeContext(home);
    const before = await snapshotHome(home);
    const beforeFiles = Object.keys(before).sort();

    const code = await main(["setup", "--dry-run"], ctx);

    const after = await snapshotHome(home);
    const afterFiles = Object.keys(after).sort();

    expect(code).toBe(EXIT.OK);
    // 计划里确实同时出现“更新”和“添加 hook”，不是因为没有变化才凑巧全部相同
    expect(stdout()).toContain("更新");
    expect(stdout()).toContain("添加 hook");

    expect(afterFiles).toEqual(beforeFiles);
    for (const file of beforeFiles) {
      expect(after[file], `${file} 的内容应保持不变`).toEqual(before[file]);
    }
  });
});

describe("kh setup --yes", () => {
  it("写入通用 skill 与 Claude Code 的 skill、hook", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const { ctx, stdout } = fakeContext(home);

    const code = await main(["setup", "--yes"], ctx);

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("已完成");
    await expect(fs.stat(path.join(home, ".agents", "skills", "kanban-hub", "SKILL.md"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(home, ".claude", "skills", "kanban-hub", "SKILL.md"))).resolves.toBeDefined();
    const settings = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it("第二次执行：全部跳过，退出码仍为 0", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await main(["setup", "--yes"], fakeContext(home).ctx);

    const { ctx, stdout } = fakeContext(home);
    const code = await main(["setup", "--yes"], ctx);
    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("已安装，跳过");
  });
});

describe("kh setup --uninstall --yes", () => {
  it("卸载后 skill 与 hook 都不在", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await main(["setup", "--yes"], fakeContext(home).ctx);

    const { ctx, stdout } = fakeContext(home);
    const code = await main(["setup", "--uninstall", "--yes"], ctx);

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("已卸载");
    await expect(fs.stat(path.join(home, ".agents", "skills", "kanban-hub"))).rejects.toThrow();
    await expect(fs.stat(path.join(home, ".claude", "skills", "kanban-hub"))).rejects.toThrow();
  });
});

describe("非交互环境", () => {
  it("不带 --yes 且不带 --dry-run：退出码 2", async () => {
    const home = await tempHome();
    const { ctx } = fakeContext(home, { isTTY: false });
    const code = await main(["setup"], ctx);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("交互确认", () => {
  it("输入 y：执行计划", async () => {
    const home = await tempHome();
    const stdin = new PassThrough();
    const { ctx, stdout } = fakeContext(home, { isTTY: true, stdin });

    const resultPromise = main(["setup"], ctx);
    stdin.end("y\n");
    const code = await resultPromise;

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("已完成");
    await expect(fs.stat(path.join(home, ".agents", "skills", "kanban-hub", "SKILL.md"))).resolves.toBeDefined();
  });

  it("等待确认期间 settings.json 被别人改了：确认后别人的改动保留，并提示已按最新内容重新合并", async () => {
    const home = await tempHome();
    const settings = path.join(home, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settings), { recursive: true });
    await fs.writeFile(settings, JSON.stringify({ theme: "dark" }));
    const stdin = new PassThrough();
    const { ctx, stdout } = fakeContext(home, { isTTY: true, stdin });

    const resultPromise = main(["setup"], ctx);
    while (!stdout().includes("(y/N)")) await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(settings, JSON.stringify({ theme: "dark", model: "opus" }));
    stdin.end("y\n");
    const code = await resultPromise;

    expect(code).toBe(EXIT.OK);
    const written = JSON.parse(await fs.readFile(settings, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.Stop).toBeDefined();
    expect(stdout()).toContain("重新合并");
  });

  it("输入 n：取消，不写入任何内容", async () => {
    const home = await tempHome();
    const stdin = new PassThrough();
    const { ctx, stdout } = fakeContext(home, { isTTY: true, stdin });

    const resultPromise = main(["setup"], ctx);
    stdin.end("n\n");
    const code = await resultPromise;

    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("已取消");
    await expect(fs.readdir(home)).resolves.toEqual([]);
  });
});

describe("kh setup --help", () => {
  it("退出码 0", async () => {
    const home = await tempHome();
    const { ctx, stdout } = fakeContext(home);
    const code = await main(["setup", "--help"], ctx);
    expect(code).toBe(EXIT.OK);
    expect(stdout()).toContain("setup");
  });
});

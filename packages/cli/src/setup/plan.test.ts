import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { EXIT, type CliError } from "../errors";
import { applySetup, planSetup, renderSetupPlan } from "./plan";
import { HOOK_COMMANDS } from "./claude-settings";
import { SKILL_MD } from "./skill";

const FIXED_NOW = new Date("2026-09-29T10:20:30");

function fakeContext(homeDir: string, overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => FIXED_NOW,
    platform: "linux",
    hostname: "test-host",
    homeDir,
    fetch: (() => {
      throw new Error("不应该在 setup 测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

function captureError(fn: () => unknown): Promise<CliError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("期望抛出异常，但没有抛出");
      },
      (err) => err as CliError,
    );
}

const dirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-setup-test-"));
  dirs.push(dir);
  return fs.realpath(dir);
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

function agentSkillPath(home: string): string {
  return path.join(home, ".agents", "skills", "kanban-hub", "SKILL.md");
}

function claudeSkillPath(home: string): string {
  return path.join(home, ".claude", "skills", "kanban-hub", "SKILL.md");
}

function settingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

describe("planSetup / applySetup：没有 ~/.claude/", () => {
  it("只写 .agents 下的 skill，claudeDirExists 为 false", async () => {
    const home = await tempHome();
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeDirExists).toBe(false);
    expect(plan.claudeSkill).toBeNull();
    expect(plan.claudeSettings).toBeNull();
    expect(plan.agentSkill.action).toBe("create");

    await applySetup(ctx, plan);
    expect(await fs.readFile(agentSkillPath(home), "utf8")).toBe(SKILL_MD);
    await expect(fs.stat(path.join(home, ".claude"))).rejects.toThrow();
  });

  it("--dry-run（只调用 planSetup，不调用 applySetup）：主目录下不产生任何文件", async () => {
    const home = await tempHome();
    const ctx = fakeContext(home);
    await planSetup(ctx, { uninstall: false });
    await expect(fs.readdir(home)).resolves.toEqual([]);
  });
});

describe("planSetup / applySetup：有 ~/.claude/，全新安装", () => {
  async function setupClaudeDir(home: string): Promise<void> {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  }

  it("settings.json 不存在：新建，只含 hooks，两个 hook 都添加", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeSkill?.action).toBe("create");
    expect(plan.claudeSettings?.action).toBe("create");
    expect(plan.claudeSettings?.added).toEqual(["SessionStart", "Stop"]);
    expect(plan.claudeSettings?.backupPath).toBeNull();

    await applySetup(ctx, plan);
    expect(await fs.readFile(claudeSkillPath(home), "utf8")).toBe(SKILL_MD);

    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: HOOK_COMMANDS.SessionStart, timeout: 15 }] }],
        Stop: [{ hooks: [{ type: "command", command: HOOK_COMMANDS.Stop, timeout: 15 }] }],
      },
    });
  });

  it("settings.json 为空文件：当作 {}", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    await fs.writeFile(settingsPath(home), "");
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeSettings?.action).toBe("update");
    await applySetup(ctx, plan);
    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written.hooks.SessionStart).toBeDefined();
  });

  it("settings.json 带 BOM：能正常解析并合并", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    await fs.writeFile(settingsPath(home), `\uFEFF${JSON.stringify({ theme: "dark" })}`);
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    await applySetup(ctx, plan);
    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.hooks.Stop).toBeDefined();
  });

  it("settings.json 不是合法 JSON：拒绝，字节不变，两处 skill 都没有写", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    const original = "{ 这不是合法的 json";
    await fs.writeFile(settingsPath(home), original);
    const ctx = fakeContext(home);

    const err = await captureError(() => planSetup(ctx, { uninstall: false }));
    expect(err.exitCode).toBe(EXIT.DATA);

    expect(await fs.readFile(settingsPath(home), "utf8")).toBe(original);
    await expect(fs.stat(agentSkillPath(home))).rejects.toThrow();
    await expect(fs.stat(claudeSkillPath(home))).rejects.toThrow();
  });

  it("已有其他事件、同一事件下已有别的组：合并后原有内容逐字不变", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    const existing = {
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "some-other-tool" }] }],
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "other-session-hook" }] }],
      },
    };
    await fs.writeFile(settingsPath(home), JSON.stringify(existing, null, 2));
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    await applySetup(ctx, plan);
    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(written.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(written.hooks.SessionStart[1].hooks[0].command).toBe(HOOK_COMMANDS.SessionStart);
  });

  it("修改前生成备份，内容等于原文件；文件权限保留", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    const original = JSON.stringify({ theme: "dark" });
    await fs.writeFile(settingsPath(home), original, { mode: 0o640 });
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    const backupPath = plan.claudeSettings?.backupPath;
    expect(backupPath).not.toBeNull();
    await applySetup(ctx, plan);

    expect(await fs.readFile(backupPath!, "utf8")).toBe(original);
    const finalMode = (await fs.stat(settingsPath(home))).mode & 0o777;
    if (process.platform !== "win32") expect(finalMode).toBe(0o640);
  });

  it("同一秒内重复备份时文件名加序号", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    await fs.writeFile(settingsPath(home), JSON.stringify({ theme: "dark" }));
    const stamp = "20260929-102030";
    const collision = path.join(home, ".claude", `settings.json.bak-${stamp}`);
    await fs.writeFile(collision, "占位");
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeSettings?.backupPath).toBe(path.join(home, ".claude", `settings.json.bak-${stamp}-1`));
  });

  it("软链接的 settings.json：链接仍是链接，目标文件被更新，备份放在目标旁边", async () => {
    const home = await tempHome();
    await setupClaudeDir(home);
    const realDir = path.join(home, "real-config");
    await fs.mkdir(realDir);
    const realFile = path.join(realDir, "actual-settings.json");
    await fs.writeFile(realFile, JSON.stringify({ theme: "dark" }));
    await fs.symlink(realFile, settingsPath(home));

    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeSettings?.isSymlink).toBe(true);
    expect(plan.claudeSettings?.realPath).toBe(realFile);

    await applySetup(ctx, plan);

    const linkStat = await fs.lstat(settingsPath(home));
    expect(linkStat.isSymbolicLink()).toBe(true);
    const written = JSON.parse(await fs.readFile(realFile, "utf8"));
    expect(written.hooks.SessionStart).toBeDefined();
    expect(path.dirname(plan.claudeSettings!.backupPath!)).toBe(realDir);
  });
});

describe("计划与执行之间 settings.json 被别人改了", () => {
  async function prepare(home: string, content: string | null): Promise<void> {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    if (content !== null) await fs.writeFile(settingsPath(home), content);
  }

  it("基于最新内容重新合并：别人加的键保留，备份存的是写入前的实际内容", async () => {
    const home = await tempHome();
    await prepare(home, JSON.stringify({ theme: "dark" }));
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });

    const changed = JSON.stringify({ theme: "dark", model: "opus" });
    await fs.writeFile(settingsPath(home), changed);
    const applied = await applySetup(ctx, plan);

    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(HOOK_COMMANDS.SessionStart);
    expect(applied.claudeSettings!.originalRaw).toBe(changed);
    expect(await fs.readFile(applied.claudeSettings!.backupPath!, "utf8")).toBe(changed);
  });

  it("计划时文件还不存在、执行前被别人建好：合并进去而不是覆盖，并先备份", async () => {
    const home = await tempHome();
    await prepare(home, null);
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.claudeSettings!.action).toBe("create");

    await fs.writeFile(settingsPath(home), JSON.stringify({ model: "opus" }));
    const applied = await applySetup(ctx, plan);

    expect(JSON.parse(await fs.readFile(settingsPath(home), "utf8")).model).toBe("opus");
    expect(applied.claudeSettings!.action).toBe("update");
    expect(await fs.readFile(applied.claudeSettings!.backupPath!, "utf8")).toBe(JSON.stringify({ model: "opus" }));
  });

  it("最新内容已经装好了 hook：跳过，不写也不备份", async () => {
    const home = await tempHome();
    await prepare(home, JSON.stringify({ theme: "dark" }));
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });

    // 另一个 kh setup 抢先装好了
    const other = await planSetup(ctx, { uninstall: false });
    await applySetup(ctx, other);
    const installed = await fs.readFile(settingsPath(home), "utf8");
    const filesBefore = await fs.readdir(path.join(home, ".claude"));

    const applied = await applySetup(ctx, plan);
    expect(applied.claudeSettings!.action).toBe("skip");
    expect(await fs.readFile(settingsPath(home), "utf8")).toBe(installed);
    expect(await fs.readdir(path.join(home, ".claude"))).toEqual(filesBefore);
  });

  it("最新内容不再是合法 JSON：以退出码 5 拒绝，settings.json 与两处 skill 都不写", async () => {
    const home = await tempHome();
    await prepare(home, JSON.stringify({ theme: "dark" }));
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });

    await fs.writeFile(settingsPath(home), "{ broken");
    const err = await captureError(() => applySetup(ctx, plan));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(await fs.readFile(settingsPath(home), "utf8")).toBe("{ broken");
    await expect(fs.stat(agentSkillPath(home))).rejects.toThrow();
    await expect(fs.stat(claudeSkillPath(home))).rejects.toThrow();
  });
});

describe("悬空软链接的 settings.json", () => {
  async function danglingLink(home: string): Promise<string> {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const target = path.join(home, "dotfiles", "claude", "settings.json");
    await fs.symlink(target, settingsPath(home));
    return target;
  }

  it("安装：以退出码 5 拒绝并指出链接目标，链接不被替换，什么都不写", async () => {
    const home = await tempHome();
    const target = await danglingLink(home);
    const ctx = fakeContext(home);

    const err = await captureError(() => planSetup(ctx, { uninstall: false }));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toContain(target);
    expect((await fs.lstat(settingsPath(home))).isSymbolicLink()).toBe(true);
    await expect(fs.stat(agentSkillPath(home))).rejects.toThrow();
  });

  it("卸载：没有可移除的 hook，跳过 settings.json，链接保持原样", async () => {
    const home = await tempHome();
    await danglingLink(home);
    const ctx = fakeContext(home);

    const plan = await planSetup(ctx, { uninstall: true });
    expect(plan.claudeSettings!.action).toBe("skip");
    await applySetup(ctx, plan);
    expect((await fs.lstat(settingsPath(home))).isSymbolicLink()).toBe(true);
  });
});

describe("幂等：连续执行两次", () => {
  it("第二次全部跳过，不产生备份", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const ctx = fakeContext(home);

    const plan1 = await planSetup(ctx, { uninstall: false });
    await applySetup(ctx, plan1);

    const plan2 = await planSetup(ctx, { uninstall: false });
    expect(plan2.agentSkill.action).toBe("skip");
    expect(plan2.claudeSkill?.action).toBe("skip");
    expect(plan2.claudeSettings?.action).toBe("skip");
    expect(plan2.claudeSettings?.backupPath).toBeNull();

    const beforeFiles = await fs.readdir(path.join(home, ".claude"));
    await applySetup(ctx, plan2);
    const afterFiles = await fs.readdir(path.join(home, ".claude"));
    expect(afterFiles).toEqual(beforeFiles);
    expect(afterFiles.some((f) => f.includes(".bak-"))).toBe(false);
  });
});

describe("--uninstall", () => {
  it("卸载之后，skill 文件与本工具的 hook 都不在，其他配置不变", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(settingsPath(home), JSON.stringify({ theme: "dark" }));
    const ctx = fakeContext(home);

    await applySetup(ctx, await planSetup(ctx, { uninstall: false }));

    const uninstallPlan = await planSetup(ctx, { uninstall: true });
    expect(uninstallPlan.agentSkill.action).toBe("remove");
    expect(uninstallPlan.claudeSkill?.action).toBe("remove");
    expect(uninstallPlan.claudeSettings?.removed).toEqual(["SessionStart", "Stop"]);

    await applySetup(ctx, uninstallPlan);

    await expect(fs.stat(agentSkillPath(home))).rejects.toThrow();
    await expect(fs.stat(claudeSkillPath(home))).rejects.toThrow();
    const written = JSON.parse(await fs.readFile(settingsPath(home), "utf8"));
    expect(written).toEqual({ theme: "dark" });
  });

  it("卸载空目录：清理掉空的 kanban-hub 目录", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const ctx = fakeContext(home);

    await applySetup(ctx, await planSetup(ctx, { uninstall: false }));
    await applySetup(ctx, await planSetup(ctx, { uninstall: true }));

    await expect(fs.stat(path.join(home, ".agents", "skills", "kanban-hub"))).rejects.toThrow();
    await expect(fs.stat(path.join(home, ".claude", "skills", "kanban-hub"))).rejects.toThrow();
  });
});

describe("renderSetupPlan", () => {
  it("列出各目标的动作，包含添加的 hook 名与备份文件名", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });
    const text = renderSetupPlan(plan);
    expect(text).toContain("新建");
    expect(text).toContain("SessionStart");
    expect(text).toContain("Stop");
  });

  it("没有 ~/.claude/ 时提示跳过", async () => {
    const home = await tempHome();
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });
    expect(renderSetupPlan(plan)).toContain("未检测到 ~/.claude/");
  });

  it("第二次执行提示已安装，跳过", async () => {
    const home = await tempHome();
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const ctx = fakeContext(home);
    await applySetup(ctx, await planSetup(ctx, { uninstall: false }));
    const plan2 = await planSetup(ctx, { uninstall: false });
    expect(renderSetupPlan(plan2)).toContain("已安装，跳过");
  });

  it("本机还没登录时提示先执行 kh login", async () => {
    const home = await tempHome();
    const ctx = fakeContext(home);
    const plan = await planSetup(ctx, { uninstall: false });
    expect(plan.loggedIn).toBe(false);
    expect(renderSetupPlan(plan)).toContain("kh login");
  });
});

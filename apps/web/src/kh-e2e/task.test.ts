/**
 * kh task 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）驱动 cli 的 main()。
 *
 * 这个文件独立起服务端、临时仓库、临时 KH_HOME。register 命令自己的行为在 register.test.ts
 * 单独测试，这里用 harness 的 loginFixture / registerProjectFixture 搭好前置条件，
 * 再额外建一个编号 M2 的阶段容器供任务测试使用。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, loginFixture, makeTempKhHome, makeTempRepo, registerProjectFixture, runKh, type TempDir, type TempRepo } from "./harness";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

let server: TestServer;
let home: TempDir;
let repo: TempRepo;

beforeEach(async () => {
  server = await startTestServer();
  home = await makeTempKhHome();
  repo = await makeTempRepo();
});

afterEach(async () => {
  await cleanupAll(home, repo);
  await server.close();
});

/** 登录（走真实的 /pair 路由），后续命令才能通过 requireLogin */
async function login(): Promise<void> {
  await loginFixture(server, repo, home);
}

/**
 * 建一个项目（带一个编号 M2 的阶段容器），把本机（已登录得到的机器）登记为它在本仓库的位置，
 * 再写出仓库配置，让 requireRegisteredRepo 能找到它。必须先 login()。
 */
async function setupProject(): Promise<{ projectId: string }> {
  const { projectId } = await registerProjectFixture(server, repo, home, { name: "示例项目" });

  const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
  if (!admin) throw new Error("测试前置条件失败：找不到管理员账号");
  const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
  await server.api.store.createContainer(projectId, { kind: "phase", code: "M2", title: "阶段二" }, actor);

  return { projectId };
}

/** 用 kh task add 建一个任务，从输出里解析出打印的短 ID（后续命令用 #短ID 定位） */
async function addTask(title: string, opts: { code?: string; cwd?: string } = {}): Promise<string> {
  const args = ["task", "add", "M2", title];
  if (opts.code !== undefined) args.push("--code", opts.code);
  const result = await runKh(args, { cwd: opts.cwd ?? repo.dir, khHome: home.dir });
  if (result.code !== 0) throw new Error(`测试前置条件失败：kh task add 退出码 ${result.code}，stderr=${result.stderr}`);
  const match = /#([0-9a-z]{4,10})/.exec(result.stdout);
  if (!match) throw new Error(`未能从输出里解析出短 ID：${result.stdout}`);
  return match[1]!;
}

function findTask(projectId: string, shortId: string) {
  const board = server.api.store.getBoard(projectId);
  if (!board) throw new Error(`项目不存在：${projectId}`);
  const task = board.tasks.find((t) => t.id.startsWith(shortId));
  if (!task) throw new Error(`按短 ID 找不到任务：${shortId}`);
  return task;
}

/** 把 10 位小写字母数字 ID 转成 generateId 的 randomBytes 输入（每个字符对应它在字母表里的下标） */
function idToBytes(id: string): number[] {
  return [...id].map((ch) => {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`测试用例给的 id 不合法（必须是小写字母或数字）：${id}`);
    return idx;
  });
}

/**
 * 临时把 core generateId() 依赖的 crypto.getRandomValues 换成按顺序吐出 ids 的桩实现，
 * 用来制造“两个任务的 ID 前缀相同”这种自然情况下几乎不可能随机撞上的歧义场景。
 * fn 执行完毕后自动还原，不影响这个文件里其它测试用例的随机 ID 生成。
 */
async function withFixedIds<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const queue = [...ids];
  const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
    const next = queue.shift();
    arr.set(next !== undefined ? idToBytes(next) : new Array(arr.length).fill(0));
    return arr;
  }) as typeof globalThis.crypto.getRandomValues);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("kh task add", () => {
  it("用容器编号新增任务，打印的短 ID 能被后续命令使用", async () => {
    await login();
    const { projectId } = await setupProject();

    const result = await runKh(["task", "add", "M2", "示例任务"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("已新建任务 #");

    const match = /#([0-9a-z]{4,10})/.exec(result.stdout)!;
    const shortId = match[1]!;

    const setResult = await runKh(["task", "set", `#${shortId}`, "--title", "改名后的任务"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(setResult.code).toBe(0);

    const task = findTask(projectId, shortId);
    expect(task.title).toBe("改名后的任务");
  });

  it("用 misc 新增任务，落在杂项容器下", async () => {
    await login();
    const { projectId } = await setupProject();

    const result = await runKh(["task", "add", "misc", "杂项任务"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);

    const board = server.api.store.getBoard(projectId)!;
    const misc = board.containers.find((c) => c.kind === "misc")!;
    const task = board.tasks.find((t) => t.title === "杂项任务")!;
    expect(task.containerId).toBe(misc.id);
  });

  it("有编号时输出里带上 容器编号/任务编号", async () => {
    await login();
    await setupProject();

    const result = await runKh(["task", "add", "M2", "有编号的任务", "--code", "2.4"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("（M2/2.4）");
  });

  it("--doc 在子目录里执行时，路径换算成仓库内的相对路径", async () => {
    await login();
    const { projectId } = await setupProject();
    const subDir = path.join(repo.dir, "docs", "sub");
    await fs.mkdir(subDir, { recursive: true });

    const result = await runKh(["task", "add", "M2", "带文档的任务", "--doc", "notes.md"], {
      cwd: subDir,
      khHome: home.dir,
    });
    expect(result.code).toBe(0);

    const board = server.api.store.getBoard(projectId)!;
    const task = board.tasks.find((t) => t.title === "带文档的任务")!;
    expect(task.docRefs).toEqual(["docs/sub/notes.md"]);
  });

  it("--doc 落在仓库外，退出码 2", async () => {
    await login();
    await setupProject();
    const outside = await makeTempRepo({ git: false });
    try {
      const result = await runKh(["task", "add", "M2", "任务", "--doc", outside.dir], {
        cwd: repo.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(2);
      expect(result.stderr.startsWith("错误：")).toBe(true);
    } finally {
      await outside.cleanup();
    }
  });

  it("--due 格式不对，退出码 2", async () => {
    await login();
    await setupProject();
    const result = await runKh(["task", "add", "M2", "任务", "--due", "not-a-date"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(result.code).toBe(2);
  });
});

describe("kh task set", () => {
  it("状态依次改为 in_progress、review、done，服务端上的 startedAt、completedAt 相应变化", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("状态流转任务");

    let r = await runKh(["task", "set", `#${shortId}`, "--status", "in_progress"], { cwd: repo.dir, khHome: home.dir });
    expect(r.code).toBe(0);
    let task = findTask(projectId, shortId);
    expect(task.status).toBe("in_progress");
    expect(task.startedAt).not.toBeNull();
    expect(task.completedAt).toBeNull();

    r = await runKh(["task", "set", `#${shortId}`, "--status", "review"], { cwd: repo.dir, khHome: home.dir });
    expect(r.code).toBe(0);
    task = findTask(projectId, shortId);
    expect(task.status).toBe("review");
    expect(task.completedAt).toBeNull();

    r = await runKh(["task", "set", `#${shortId}`, "--status", "done"], { cwd: repo.dir, khHome: home.dir });
    expect(r.code).toBe(0);
    task = findTask(projectId, shortId);
    expect(task.status).toBe("done");
    expect(task.completedAt).not.toBeNull();
  });

  it("用 M2/2.3 和 #短ID 都能定位任务", async () => {
    await login();
    const { projectId } = await setupProject();
    await addTask("有编号任务", { code: "2.3" });

    const r1 = await runKh(["task", "set", "M2/2.3", "--note", "备注一"], { cwd: repo.dir, khHome: home.dir });
    expect(r1.code).toBe(0);
    const board1 = server.api.store.getBoard(projectId)!;
    const task1 = board1.tasks.find((t) => t.code === "2.3")!;
    expect(task1.note).toBe("备注一");

    const shortId = task1.id.slice(0, 4);
    const r2 = await runKh(["task", "set", `#${shortId}`, "--note", "备注二"], { cwd: repo.dir, khHome: home.dir });
    expect(r2.code).toBe(0);
    const board2 = server.api.store.getBoard(projectId)!;
    expect(board2.tasks.find((t) => t.code === "2.3")!.note).toBe("备注二");
  });

  it("--status suspended --reason 一起给出才成功；只给 --status suspended 退出码 2", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("待挂起任务");

    const bad = await runKh(["task", "set", `#${shortId}`, "--status", "suspended"], { cwd: repo.dir, khHome: home.dir });
    expect(bad.code).toBe(2);
    expect(findTask(projectId, shortId).status).toBe("todo");

    const ok = await runKh(["task", "set", `#${shortId}`, "--status", "suspended", "--reason", "等待外部依赖"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(ok.code).toBe(0);
    const task = findTask(projectId, shortId);
    expect(task.status).toBe("suspended");
    expect(task.suspendReason).toBe("等待外部依赖");
  });

  it("--doc 追加并去掉重复", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("带文档任务");

    await runKh(["task", "set", `#${shortId}`, "--doc", "docs/a.md", "--doc", "docs/a.md", "--doc", "docs/b.md"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(findTask(projectId, shortId).docRefs).toEqual(["docs/a.md", "docs/b.md"]);

    await runKh(["task", "set", `#${shortId}`, "--doc", "docs/a.md", "--doc", "docs/c.md"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(findTask(projectId, shortId).docRefs).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
  });

  it("--container misc 把任务移到杂项", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("待移动任务");

    const result = await runKh(["task", "set", `#${shortId}`, "--container", "misc"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);

    const board = server.api.store.getBoard(projectId)!;
    const misc = board.containers.find((c) => c.kind === "misc")!;
    expect(findTask(projectId, shortId).containerId).toBe(misc.id);
  });

  it('--code "" 清空编号', async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("有编号任务2", { code: "9.9" });

    const result = await runKh(["task", "set", `#${shortId}`, "--code", ""], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(findTask(projectId, shortId).code).toBeNull();
  });

  it("没有给任何选项，退出码 2", async () => {
    await login();
    await setupProject();
    const shortId = await addTask("空选项任务");
    const result = await runKh(["task", "set", `#${shortId}`], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
  });

  it("任务写法不合法，退出码 2", async () => {
    await login();
    await setupProject();
    const result = await runKh(["task", "set", "not a valid ref", "--note", "x"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
  });

  it("找不到，退出码 5", async () => {
    await login();
    await setupProject();
    const result = await runKh(["task", "set", "#zzzzzz", "--note", "x"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(5);
  });

  it("有歧义，退出码 5，并列出候选的短 ID", async () => {
    await login();
    const { projectId } = await setupProject();
    const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin")!;
    const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const board = server.api.store.getBoard(projectId)!;
    const container = board.containers.find((c) => c.code === "M2")!;

    // 制造两个 ID 共享前 4 位（"aaaa"）的任务：自然随机生成里几乎不会发生，这里临时固定
    // generateId() 的随机源。每次 createTask 会申请两个 id（任务本体 + task.created 事件），
    // 第一、第三个是我们关心的任务 id，第二、第四个是事件 id（内容不重要，只要合法）。
    await withFixedIds(["aaaa111111", "eeeeeeeee1", "aaaa222222", "eeeeeeeee2"], async () => {
      await server.api.store.createTask(projectId, { containerId: container.id, title: "任务甲" }, actor);
      await server.api.store.createTask(projectId, { containerId: container.id, title: "任务乙" }, actor);
    });

    const result = await runKh(["task", "set", "#aaaa", "--note", "x"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(5);
    // 两个任务 id 只在第 5 位分叉（aaaa1... / aaaa2...），resolveTaskRef 列出的候选短 id 就是 #aaaa1、#aaaa2
    expect(result.stderr).toMatch(/#aaaa1\b/);
    expect(result.stderr).toMatch(/#aaaa2\b/);
  });
});

describe("kh task human", () => {
  it("设置后服务端 human 正确，事件里有 task.human_changed；--clear 之后为 null", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("待处理任务");

    const setResult = await runKh(["task", "human", `#${shortId}`, "--decision", "选择方案 A 还是 B"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(setResult.code).toBe(0);
    expect(findTask(projectId, shortId).human).toEqual({ kind: "decision", note: "选择方案 A 还是 B" });

    const events = await server.api.store.listEvents({ projectId, limit: 50 });
    expect(events.some((e) => e.type === "task.human_changed")).toBe(true);

    const clearResult = await runKh(["task", "human", `#${shortId}`, "--clear"], { cwd: repo.dir, khHome: home.dir });
    expect(clearResult.code).toBe(0);
    expect(findTask(projectId, shortId).human).toBeNull();
  });

  it("同时给两个类型，退出码 2", async () => {
    await login();
    await setupProject();
    const shortId = await addTask("任务");
    const result = await runKh(["task", "human", `#${shortId}`, "--decision", "x", "--verify", "y"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(result.code).toBe(2);
  });

  it("给了类型却没有说明，退出码 2", async () => {
    await login();
    await setupProject();
    const shortId = await addTask("任务");
    const result = await runKh(["task", "human", `#${shortId}`, "--decision"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
  });

  it("什么都不给，退出码 2", async () => {
    await login();
    await setupProject();
    const shortId = await addTask("任务");
    const result = await runKh(["task", "human", `#${shortId}`], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
  });
});

describe("kh task check", () => {
  it("勾选、--undo", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("清单任务");
    await runKh(["task", "checklist", `#${shortId}`, "--add", "第一步", "--add", "第二步"], {
      cwd: repo.dir,
      khHome: home.dir,
    });

    let r = await runKh(["task", "check", `#${shortId}`, "1"], { cwd: repo.dir, khHome: home.dir });
    expect(r.code).toBe(0);
    let task = findTask(projectId, shortId);
    expect(task.checklist[0]?.done).toBe(true);
    expect(task.checklist[1]?.done).toBe(false);

    r = await runKh(["task", "check", `#${shortId}`, "1", "--undo"], { cwd: repo.dir, khHome: home.dir });
    expect(r.code).toBe(0);
    task = findTask(projectId, shortId);
    expect(task.checklist[0]?.done).toBe(false);
  });

  it("序号为 0 或超出范围，退出码 2", async () => {
    await login();
    await setupProject();
    const shortId = await addTask("清单任务2");
    await runKh(["task", "checklist", `#${shortId}`, "--add", "唯一一项"], { cwd: repo.dir, khHome: home.dir });

    const zero = await runKh(["task", "check", `#${shortId}`, "0"], { cwd: repo.dir, khHome: home.dir });
    expect(zero.code).toBe(2);

    const over = await runKh(["task", "check", `#${shortId}`, "2"], { cwd: repo.dir, khHome: home.dir });
    expect(over.code).toBe(2);
  });
});

describe("kh task checklist", () => {
  it("一次加两项，顺序正确", async () => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("清单顺序任务");

    const result = await runKh(["task", "checklist", `#${shortId}`, "--add", "先做这个", "--add", "再做这个"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(result.code).toBe(0);
    expect(findTask(projectId, shortId).checklist.map((i) => i.text)).toEqual(["先做这个", "再做这个"]);
  });
});

describe("上报时间", () => {
  function reportFileFor(projectId: string): string {
    return path.join(home.dir, "cache", "reports", `${projectId}.json`);
  }

  async function lastReportAt(projectId: string): Promise<number> {
    const raw = JSON.parse(await fs.readFile(reportFileFor(projectId), "utf8")) as { lastReportAt: string };
    return Date.parse(raw.lastReportAt);
  }

  it("task add 成功后更新上报时间", async () => {
    await login();
    const { projectId } = await setupProject();
    const before = Date.now();
    await addTask("上报测试任务");
    expect(await lastReportAt(projectId)).toBeGreaterThanOrEqual(before);
  });

  // task set/human/check/checklist 都要各自更新上报时间，逐条验证而不是只测一种子命令
  it.each<[string, boolean, (shortId: string) => string[]]>([
    ["task set", false, (id) => ["task", "set", `#${id}`, "--note", "更新一下"]],
    ["task human", false, (id) => ["task", "human", `#${id}`, "--decision", "选 A 还是 B"]],
    ["task check", true, (id) => ["task", "check", `#${id}`, "1"]],
    ["task checklist", false, (id) => ["task", "checklist", `#${id}`, "--add", "追加一项"]],
  ])("%s 成功后更新上报时间", async (_name, needsChecklistItem, buildArgs) => {
    await login();
    const { projectId } = await setupProject();
    const shortId = await addTask("上报测试任务");
    if (needsChecklistItem) {
      await runKh(["task", "checklist", `#${shortId}`, "--add", "唯一一项"], { cwd: repo.dir, khHome: home.dir });
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = Date.now();
    const result = await runKh(buildArgs(shortId), { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(await lastReportAt(projectId)).toBeGreaterThanOrEqual(before);
  });
});

describe("kh task：不泄露令牌", () => {
  it("stdout/stderr 不包含令牌", async () => {
    await login();
    await setupProject();
    const token = (await fs.readFile(path.join(home.dir, "credentials"), "utf8")).trim();

    const result = await runKh(["task", "add", "M2", "任务"], { cwd: repo.dir, khHome: home.dir });
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });
});

/**
 * kh hook session-start / stop / sync 的端到端测试：进程内测试服务端 + 临时仓库与 KH_HOME。
 * hook 的输入从 stdin 喂 JSON；后台启动只记录调用参数（真实进程的脱离在打包冒烟里验证）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE } from "@kanban-hub/core/sync";
import { runHookCommand } from "../../../../packages/cli/src/commands/hook";
import { STOP_REMINDER } from "../../../../packages/cli/src/hook/stop";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { makeFleet, sha, type Fleet, type Machine } from "./fleet";
import {
  cleanupAll,
  gitFixture,
  loginFixture,
  makeKhContext,
  makeTempKhHome,
  makeTempRepo,
  registerProjectFixture,
  runKh,
  type RunKhOptions,
  type SpawnBackgroundCall,
  type TempDir,
} from "./harness";

type HookName = "session-start" | "stop" | "sync";

interface HookStdin {
  session_id?: string;
  cwd?: string;
  source?: string;
  stop_hook_active?: boolean;
}

interface HookRunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnCalls: SpawnBackgroundCall[];
}

/** 执行一次 kh hook <name>：stdin 是 JSON（传字符串时原样使用），cwd 默认取 stdin 里的 cwd */
async function hook(
  name: HookName,
  stdin: HookStdin | string,
  opts: Omit<RunKhOptions, "stdin" | "spawnBackground" | "cwd"> & { cwd?: string },
): Promise<HookRunResult> {
  const spawnCalls: SpawnBackgroundCall[] = [];
  const raw = typeof stdin === "string" ? stdin : JSON.stringify(stdin);
  const cwd = opts.cwd ?? (typeof stdin === "string" ? os.tmpdir() : (stdin.cwd ?? os.tmpdir()));
  const result = await runKh(["hook", name], {
    ...opts,
    cwd,
    stdin: raw,
    spawnBackground: (args, spawnOpts) => spawnCalls.push({ args, cwd: spawnOpts.cwd, logFile: spawnOpts.logFile }),
  });
  return { ...result, spawnCalls };
}

async function readHookLog(home: string): Promise<string> {
  try {
    return await fs.readFile(path.join(home, "logs", "hook.log"), "utf8");
  } catch {
    return "";
  }
}

async function readToken(home: string): Promise<string | null> {
  try {
    return (await fs.readFile(path.join(home, "credentials"), "utf8")).trim();
  } catch {
    return null;
  }
}

/** 目录里每个文件的相对路径、大小、修改时间（用来断言 hook 没有写任何文件） */
async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${childRel}/`);
        await walk(childAbs, childRel);
      } else {
        const stat = await fs.lstat(childAbs);
        out.push(`${childRel} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function markerPath(home: string, sessionId: string): string {
  return path.join(home, "cache", "sessions", `${sessionId}.json`);
}

async function readMarkerFile(home: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(markerPath(home, sessionId), "utf8")) as Record<string, unknown>;
}

function lockFile(home: string, projectId: string): string {
  return path.join(home, "cache", projectId, "lock");
}

/** 用当前测试进程的 pid 占住同步锁：持有者活着、刚刷新过，按规则判定为“被占用” */
async function holdLock(home: string, projectId: string): Promise<void> {
  await fs.mkdir(path.dirname(lockFile(home, projectId)), { recursive: true });
  await fs.writeFile(lockFile(home, projectId), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "held-by-test" }));
}

async function commit(repo: string, rel: string, content: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  gitFixture(["add", rel], repo);
  gitFixture(["commit", "-q", "-m", `edit ${rel}`], repo);
}

/** 每个用例结束时检查：用过的 KH_HOME 里 hook.log 都不含令牌 */
const homesToCheck: string[] = [];

afterEach(async () => {
  const homes = homesToCheck.splice(0);
  for (const home of homes) {
    const token = await readToken(home);
    if (token === null || token === "") continue;
    expect(await readHookLog(home)).not.toContain(token);
  }
});

describe("kh hook：单台机器", () => {
  let server: TestServer;
  let repo: TempDir & { dir: string };
  let home: TempDir;
  let projectId: string;
  const cleanups: TempDir[] = [];

  beforeEach(async () => {
    server = await startTestServer();
    repo = await makeTempRepo();
    home = await makeTempKhHome();
    cleanups.push(repo, home);
    await loginFixture(server, repo, home);
    ({ projectId } = await registerProjectFixture(server, repo, home, { name: "钩子项目", focus: "接入 hook" }));
    homesToCheck.push(home.dir);
  });

  afterEach(async () => {
    await cleanupAll(...cleanups.splice(0));
    await server.close();
  });

  const base = () => ({ cwd: repo.dir, khHome: home.dir });

  async function adminActor(): Promise<Actor> {
    const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
    if (!admin) throw new Error("找不到管理员");
    return { userId: admin.id, machineId: null, via: "web", agent: null };
  }

  describe("静默", () => {
    it("没有 .kanban-hub/ 的仓库：两个 hook 都退出码 0、不输出、不写 KH_HOME 的任何文件、不启动后台进程", async () => {
      const plain = await makeTempRepo();
      cleanups.push(plain);
      const before = await listTree(home.dir);
      for (const name of ["session-start", "stop"] as const) {
        const r = await hook(name, { session_id: "s-plain", cwd: plain.dir }, { khHome: home.dir });
        expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
        expect(r.spawnCalls).toEqual([]);
      }
      expect(await listTree(home.dir)).toEqual(before);
    });

    it("stdin 无效、session_id 含 ../：退出码 0、不输出；KH_HOME 下只多了 hook.log，KH_HOME 之外没有新文件", async () => {
      const outer = await makeTempKhHome();
      cleanups.push(outer);
      const nestedHome = path.join(outer.dir, "a", "b", "kh");
      await fs.mkdir(nestedHome, { recursive: true });
      const repoBefore = await listTree(repo.dir);

      const inputs: (HookStdin | string)[] = [
        "不是 JSON",
        { session_id: "../../../evil", cwd: repo.dir },
        { session_id: "../../../../evil", cwd: repo.dir },
        { cwd: repo.dir },
        { session_id: "ok", cwd: 42 as unknown as string },
      ];
      for (const name of ["session-start", "stop"] as const) {
        for (const input of inputs) {
          const r = await hook(name, input, { khHome: nestedHome, cwd: repo.dir });
          expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
          expect(r.spawnCalls).toEqual([]);
        }
      }

      const tree = await listTree(outer.dir);
      expect(tree.filter((e) => !e.endsWith("/")).map((e) => e.split(" ")[0])).toEqual(["a/b/kh/logs/hook.log"]);
      expect(await listTree(repo.dir)).toEqual(repoBefore);
      expect(await readHookLog(nestedHome)).toContain("输入无效");
    });

    it("cwd 不存在：退出码 0、不输出", async () => {
      const r = await hook("session-start", { session_id: "s1", cwd: path.join(repo.dir, "no-such-dir") }, { khHome: home.dir });
      expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    });

    it("cwd 经过软链接：能找到仓库", async () => {
      const links = await makeTempKhHome();
      cleanups.push(links);
      const link = path.join(links.dir, "repo-link");
      await fs.symlink(repo.dir, link);
      const r = await hook("session-start", { session_id: "s-link", cwd: link }, { khHome: home.dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("钩子项目");
    });

    it("服务端连不上：session-start 退出码 0、不输出，标记照常创建，日志里有原因", async () => {
      const r = await hook("session-start", { session_id: "s-down", cwd: repo.dir }, {
        ...base(),
        fetch: (() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))) as typeof fetch,
      });
      expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(await exists(markerPath(home.dir, "s-down"))).toBe(true);
      expect(await readHookLog(home.dir)).toContain("无法连接到服务端");
    });

    it("凭据文件的权限是 644：session-start 的 stderr 为空，权限修复的提示进了日志", async () => {
      await fs.chmod(path.join(home.dir, "credentials"), 0o644);
      const r = await hook("session-start", { session_id: "s-perm", cwd: repo.dir }, base());
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("钩子项目");
      expect(await readHookLog(home.dir)).toContain("改回 600");
    });

    it("会话内容不进日志：stdin 里的最后回复、会话记录路径和其他未知字段都不写进 hook.log", async () => {
      const secrets = {
        last_assistant_message: "SECRET-LAST-MESSAGE-7f3a",
        transcript_path: "/tmp/SECRET-TRANSCRIPT-9c1d.jsonl",
        prompt: "SECRET-PROMPT-2b8e",
        hook_event_name: "SECRET-EVENT-4d6f",
      };
      await hook("session-start", { session_id: "s-secret", cwd: repo.dir, ...secrets } as HookStdin, base());
      await commit(repo.dir, "src/secret.ts", "x\n");
      const stop = await hook("stop", { session_id: "s-secret", cwd: repo.dir, ...secrets } as HookStdin, base());
      expect(stop.code).toBe(2);
      // 输入无效的路径同样不回显输入
      await hook("stop", { session_id: "../bad", cwd: repo.dir, ...secrets } as HookStdin, base());
      await hook("stop", `{"session_id": "x", ${JSON.stringify(secrets.last_assistant_message)}`, base());

      const log = await readHookLog(home.dir);
      expect(log).not.toBe("");
      for (const value of Object.values(secrets)) expect(log).not.toContain(value);
      expect(log).not.toContain("SECRET");
    });

    it("hook 子树的解析错误不变成退出码 2；其他命令的行为不变", async () => {
      for (const args of [["hook", "stop", "--no-such-option"], ["hook", "unknown"]]) {
        const r = await runKh(args, base());
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toBe("");
      }
      const sync = await runKh(["sync", "--no-such-option"], base());
      expect(sync.code).toBe(2);
    });
  });

  it("硬性兜底：拉取卡在永不返回的请求上，session-start 在兜底时长后返回，不输出", async () => {
    const { ctx, output } = makeKhContext({
      ...base(),
      stdin: JSON.stringify({ session_id: "s-hang", cwd: repo.dir }),
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    const started = Date.now();
    await runHookCommand(ctx, "session-start", undefined, { hardLimitMs: 100 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1500);
    expect(output()).toEqual({ stdout: "", stderr: "" });
    expect(await readHookLog(home.dir)).toContain("放弃等待");
  });

  describe("session-start", () => {
    it("摘要含项目名、进行中任务的短 ID、待你处理、上报规则；日志记下拉取结果", async () => {
      const actor = await adminActor();
      const container = await server.api.store.createContainer(projectId, { kind: "phase", title: "阶段一", code: "P1" }, actor);
      await server.api.store.createTask(projectId, { containerId: container.id, title: "写 hook", code: "1", status: "in_progress" }, actor);
      await server.api.store.createTask(
        projectId,
        { containerId: container.id, title: "选方案", code: "2", human: { kind: "decision", note: "二选一" } },
        actor,
      );

      const r = await hook("session-start", { session_id: "s-sum", cwd: repo.dir, source: "startup" }, base());
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("钩子项目");
      expect(r.stdout).toContain("焦点：接入 hook");
      expect(r.stdout).toMatch(/进行中 #[0-9a-z]{4,} P1\/1 写 hook/);
      expect(r.stdout).toContain("待你处理");
      expect(r.stdout).toMatch(/#[0-9a-z]{4,} 选方案（待决策：二选一）/);
      expect(r.stdout).toContain("上报规则");
      expect(r.stdout).toContain("kanban-hub skill");
      // 其他机器都还没有同步过：没有拉取这一行
      expect(r.stdout).not.toContain("自动拉取");
      expect(await readHookLog(home.dir)).toContain("自动拉取：其他机器还没有同步过");
    });

    it("大看板：不超过 40 行、4000 字符，各段有“另有 N 项”", async () => {
      const actor = await adminActor();
      const container = await server.api.store.createContainer(projectId, { kind: "phase", title: "大阶段", code: "P1" }, actor);
      for (let i = 1; i <= 50; i++) {
        await server.api.store.createTask(
          projectId,
          {
            containerId: container.id,
            title: `进行中任务 ${i}`,
            code: String(i),
            status: "in_progress",
            ...(i <= 20 ? { human: { kind: "action" as const, note: "处理一下" } } : {}),
          },
          actor,
        );
      }
      const conflicts: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) {
        conflicts[`notes/c${String(i).padStart(2, "0")}.md`] = {
          remoteSha: sha(`r${i}`),
          remoteMachineId: "m000000009",
          remoteMachineName: "机器B",
          baseSha: null,
          detectedAt: "2026-09-29T00:00:00.000Z",
        };
      }
      await fs.mkdir(path.join(home.dir, "cache", projectId), { recursive: true });
      await fs.writeFile(path.join(home.dir, "cache", projectId, "state.json"), JSON.stringify({ root: repo.dir, conflicts }));

      const r = await hook("session-start", { session_id: "s-big", cwd: repo.dir }, base());
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines.length).toBeLessThanOrEqual(40);
      expect(r.stdout.length).toBeLessThanOrEqual(4000);
      expect(r.stdout).toContain("另有 38 项，执行 kh status 查看");
      expect(r.stdout).toContain("另有 12 项，执行 kh status 查看");
      expect(r.stdout).toContain("另有 12 项，执行 kh conflicts 查看");
      expect(r.stdout).toContain("先处理冲突再开始任务");
    });

    it("本机有未解决的冲突（没有记下对方机器名时显示机器 ID）", async () => {
      await fs.mkdir(path.join(home.dir, "cache", projectId), { recursive: true });
      await fs.writeFile(
        path.join(home.dir, "cache", projectId, "state.json"),
        JSON.stringify({
          root: repo.dir,
          conflicts: {
            "notes/x.md": { remoteSha: sha("x"), remoteMachineId: "m000000009", baseSha: null, detectedAt: "2026-09-29T00:00:00.000Z" },
          },
        }),
      );
      const r = await hook("session-start", { session_id: "s-cf", cwd: repo.dir }, base());
      expect(r.stdout).toContain("notes/x.md（对方：m000000009）→ kh conflicts show notes/x.md");
    });

    it("压缩之后再次触发（同一个 session_id）：标记不被覆盖", async () => {
      await hook("session-start", { session_id: "s-compact", cwd: repo.dir, source: "startup" }, base());
      const first = await readMarkerFile(home.dir, "s-compact");
      await commit(repo.dir, "src/a.ts", "a\n");
      await hook("session-start", { session_id: "s-compact", cwd: repo.dir, source: "compact" }, base());
      expect(await readMarkerFile(home.dir, "s-compact")).toEqual(first);
    });
  });

  describe("stop", () => {
    it("每次都在后台启动一次 kh hook sync（cwd 是仓库根，日志写到 hook.log）；锁被占用时不启动", async () => {
      const sub = path.join(repo.dir, "sub");
      await fs.mkdir(sub);
      const r = await hook("stop", { session_id: "s-bg", cwd: sub }, base());
      expect(r.code).toBe(0);
      expect(r.spawnCalls).toEqual([{ args: ["hook", "sync"], cwd: repo.dir, logFile: path.join(home.dir, "logs", "hook.log") }]);
      expect(await readHookLog(home.dir)).toContain("已在后台启动同步");

      await holdLock(home.dir, projectId);
      const busy = await hook("stop", { session_id: "s-bg", cwd: repo.dir }, base());
      expect(busy.code).toBe(0);
      expect(busy.spawnCalls).toEqual([]);
    });

    it("改了仓库、没上报：退出码 2，stderr 与提醒原文一致，标记变为已提醒；同一会话再次 Stop 退出码 0", async () => {
      await hook("session-start", { session_id: "s-remind", cwd: repo.dir }, base());
      await commit(repo.dir, "src/a.ts", "a\n");

      const r = await hook("stop", { session_id: "s-remind", cwd: repo.dir }, base());
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(STOP_REMINDER);
      expect(r.stdout).toBe("");
      expect((await readMarkerFile(home.dir, "s-remind")).reminded).toBe(true);

      const again = await hook("stop", { session_id: "s-remind", cwd: repo.dir }, base());
      expect(again).toMatchObject({ code: 0, stderr: "" });
    });

    it("兜底时限已到、流程才走到提醒：不把会话标为已提醒，下一轮照常提醒", async () => {
      await hook("session-start", { session_id: "s-late", cwd: repo.dir }, base());
      await commit(repo.dir, "src/a.ts", "a\n");

      // stdin 在兜底时限之后才给出输入：外壳已经放弃等待，流程还在后台接着跑
      const { ctx, output } = makeKhContext(base());
      const stdin = new PassThrough();
      ctx.stdin = stdin;
      await runHookCommand(ctx, "stop", undefined, { hardLimitMs: 50 });
      stdin.end(JSON.stringify({ session_id: "s-late", cwd: repo.dir }));
      expect(output()).toEqual({ stdout: "", stderr: "" });

      const deadline = Date.now() + 5_000;
      while (!/本轮不提醒|已提醒/.test(await readHookLog(home.dir)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await readMarkerFile(home.dir, "s-late")).reminded).toBe(false);

      const next = await hook("stop", { session_id: "s-late", cwd: repo.dir }, base());
      expect(next.code).toBe(2);
      expect(next.stderr).toBe(STOP_REMINDER);
    });

    it("只改了未提交的文件也算改动", async () => {
      await hook("session-start", { session_id: "s-dirty", cwd: repo.dir }, base());
      await fs.writeFile(path.join(repo.dir, "draft.txt"), "draft\n");
      const r = await hook("stop", { session_id: "s-dirty", cwd: repo.dir }, base());
      expect(r.code).toBe(2);
    });

    it("在链接工作树里开的会话（仓库根是主工作树）：在链接工作树里提交，Stop 退出码 2", async () => {
      const wtParent = await makeTempKhHome();
      cleanups.push(wtParent);
      const wt = path.join(wtParent.dir, "wt");
      gitFixture(["worktree", "add", "-q", wt], repo.dir);

      const start = await hook("session-start", { session_id: "s-wt", cwd: wt }, base());
      expect(start.stdout).toContain("钩子项目");
      expect((await readMarkerFile(home.dir, "s-wt")).worktree).toBe(wt);

      await commit(wt, "src/wt.ts", "wt\n");
      const r = await hook("stop", { session_id: "s-wt", cwd: wt }, base());
      expect(r.code).toBe(2);
      expect(r.spawnCalls[0]?.cwd).toBe(repo.dir);
    });

    it("stop_hook_active 为 true：退出码 0", async () => {
      await hook("session-start", { session_id: "s-active", cwd: repo.dir }, base());
      await commit(repo.dir, "src/a.ts", "a\n");
      const r = await hook("stop", { session_id: "s-active", cwd: repo.dir, stop_hook_active: true }, base());
      expect(r).toMatchObject({ code: 0, stderr: "" });
    });

    it("会话开始后执行过 kh task set：退出码 0", async () => {
      const actor = await adminActor();
      const container = await server.api.store.createContainer(projectId, { kind: "phase", title: "阶段一", code: "P1" }, actor);
      await server.api.store.createTask(projectId, { containerId: container.id, title: "写 hook", code: "1" }, actor);

      await hook("session-start", { session_id: "s-reported", cwd: repo.dir }, base());
      await commit(repo.dir, "src/a.ts", "a\n");
      const set = await runKh(["task", "set", "P1/1", "--status", "in_progress"], base());
      expect(set.code).toBe(0);

      const r = await hook("stop", { session_id: "s-reported", cwd: repo.dir }, base());
      expect(r).toMatchObject({ code: 0, stderr: "" });
    });

    it("没有改动：退出码 0", async () => {
      await hook("session-start", { session_id: "s-clean", cwd: repo.dir }, base());
      const r = await hook("stop", { session_id: "s-clean", cwd: repo.dir }, base());
      expect(r).toMatchObject({ code: 0, stderr: "" });
    });

    it("没有标记（hook 装上之前开始的会话）：退出码 0", async () => {
      await commit(repo.dir, "src/a.ts", "a\n");
      const r = await hook("stop", { session_id: "s-none", cwd: repo.dir }, base());
      expect(r).toMatchObject({ code: 0, stderr: "" });
    });

    it("超过 7 天的标记在下一次 hook 运行时被清理，7 天之内的保留", async () => {
      const dir = path.join(home.dir, "cache", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const marker = (sessionId: string, startedAt: string) =>
        JSON.stringify({ sessionId, projectId, root: repo.dir, worktree: repo.dir, startedAt, head: null, dirty: null, reminded: false });
      await fs.writeFile(path.join(dir, "old.json"), marker("old", new Date(Date.now() - 8 * 86_400_000).toISOString()));
      await fs.writeFile(path.join(dir, "recent.json"), marker("recent", new Date(Date.now() - 6 * 86_400_000).toISOString()));

      await hook("stop", { session_id: "s-gc", cwd: repo.dir }, base());
      expect(await exists(path.join(dir, "old.json"))).toBe(false);
      expect(await exists(path.join(dir, "recent.json"))).toBe(true);
    });
  });

  describe("sync（后台）", () => {
    const T0 = Date.parse("2026-09-29T08:00:00.000Z");

    async function prepareDocs(): Promise<void> {
      await writeRepoConfig(repo.dir, {
        projectId,
        sync: { include: ["notes/**"], exclude: [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
        pull: { auto: true },
      });
      await fs.mkdir(path.join(repo.dir, "notes"), { recursive: true });
      await fs.writeFile(path.join(repo.dir, "notes", "a.md"), "A1\n");
    }

    function countingFetch(): { fetch: typeof fetch; count: () => number } {
      let n = 0;
      const real = globalThis.fetch.bind(globalThis);
      return {
        fetch: ((...args: Parameters<typeof fetch>) => {
          n += 1;
          return real(...args);
        }) as typeof fetch,
        count: () => n,
      };
    }

    const syncAt = (ms: number, extra: Partial<RunKhOptions> = {}) =>
      runKh(["hook", "sync"], { ...base(), now: () => new Date(ms), ...extra });

    it("首次推送成功，日志有计数；10 分钟内没有变化不发任何请求；改了文件、超过 10 分钟都照常推送", async () => {
      await prepareDocs();
      const first = await syncAt(T0);
      expect(first).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(await readHookLog(home.dir)).toContain("已同步：新增 1");

      const quiet = countingFetch();
      const skipped = await syncAt(T0 + 5 * 60_000, { fetch: quiet.fetch });
      expect(skipped.code).toBe(0);
      expect(quiet.count()).toBe(0);
      expect(await readHookLog(home.dir)).toContain("没有变化，跳过");

      await fs.writeFile(path.join(repo.dir, "notes", "a.md"), "A2\n");
      const changed = countingFetch();
      await syncAt(T0 + 6 * 60_000, { fetch: changed.fetch });
      expect(changed.count()).toBeGreaterThan(0);
      expect(await readHookLog(home.dir)).toContain("已同步：修改 1");

      const late = countingFetch();
      await syncAt(T0 + 17 * 60_000, { fetch: late.fetch });
      expect(late.count()).toBeGreaterThan(0);
    });

    it("后台同步用自己的上限，不套用前台的硬性兜底：比前台兜底慢的推送照常完成", async () => {
      await prepareDocs();
      const real = globalThis.fetch.bind(globalThis);
      const slow = (async (...args: Parameters<typeof fetch>) => {
        await new Promise((r) => setTimeout(r, 100));
        return real(...args);
      }) as typeof fetch;

      // 前台兜底只有 50 毫秒，后台上限 10 秒：推送要几百毫秒，仍然完成
      const ok = makeKhContext({ ...base(), fetch: slow });
      await runHookCommand(ok.ctx, "sync", undefined, { hardLimitMs: 50, backgroundSyncLimitMs: 10_000 });
      let log = await readHookLog(home.dir);
      expect(log).toContain("已同步：新增 1");
      expect(log).not.toContain("放弃等待");

      // 对照：后台上限本身太短时才会放弃等待
      await fs.writeFile(path.join(repo.dir, "notes", "a.md"), "A2\n");
      const cut = makeKhContext({ ...base(), fetch: slow });
      await runHookCommand(cut.ctx, "sync", undefined, { hardLimitMs: 10_000, backgroundSyncLimitMs: 50 });
      log = await readHookLog(home.dir);
      expect(log).toContain("超过 50 毫秒仍未结束，放弃等待");
      // 等被放弃的推送在进程内跑完，再清理临时目录
      await new Promise((r) => setTimeout(r, 1500));
    });

    it("kh sync 不受窗口影响，每次都推送", async () => {
      await prepareDocs();
      await syncAt(T0);
      const manual = countingFetch();
      const r = await runKh(["sync"], { ...base(), now: () => new Date(T0 + 1000), fetch: manual.fetch });
      expect(r.code).toBe(0);
      expect(manual.count()).toBeGreaterThan(0);
    });

    it("锁被占用：日志写“跳过”，退出码 0，不等待", async () => {
      await prepareDocs();
      await holdLock(home.dir, projectId);
      const started = Date.now();
      const r = await runKh(["hook", "sync"], base());
      expect(Date.now() - started).toBeLessThan(3000);
      expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(await readHookLog(home.dir)).toContain("另一个同步或拉取正在进行，跳过");
    });

    it("服务端连不上：日志写原因，退出码 0", async () => {
      await prepareDocs();
      const r = await runKh(["hook", "sync"], {
        ...base(),
        fetch: (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
      });
      expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(await readHookLog(home.dir)).toContain("同步失败：无法连接到服务端");
    });
  });
});

describe("kh hook session-start：自动拉取（多台机器）", () => {
  let server: TestServer;
  let fleet: Fleet;
  let A: Machine;
  let B: Machine;

  beforeEach(async () => {
    server = await startTestServer();
    const made = await makeFleet(server);
    fleet = made.fleet;
    A = made.first;
    B = await fleet.add("机器B");
    homesToCheck.push(A.home, B.home);
  });

  afterEach(async () => {
    await fleet.cleanup();
    await server.close();
  });

  const startB = (sessionId: string, extra: Partial<RunKhOptions> = {}) =>
    hook("session-start", { session_id: sessionId, cwd: B.repo }, { khHome: B.home, ...extra });

  it("另一台机器推送了新文件：摘要里有“自动拉取：新建 1”，文件已写入仓库", async () => {
    await A.write("notes/new.md", "from A\n");
    expect((await A.kh(["sync"])).code).toBe(0);

    const r = await startB("s-pull");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("自动拉取：新建 1");
    expect(await B.read("notes/new.md")).toBe("from A\n");
  });

  it("pull.auto 为 false：不拉取，摘要里没有拉取这一行", async () => {
    await A.write("notes/new.md", "from A\n");
    await A.kh(["sync"]);
    await writeRepoConfig(B.repo, {
      projectId: fleet.projectId,
      sync: { include: ["notes/**"], exclude: [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
      pull: { auto: false },
    });
    const r = await startB("s-off");
    expect(r.stdout).toContain("上报规则");
    expect(r.stdout).not.toContain("自动拉取");
    expect(await B.exists("notes/new.md")).toBe(false);
  });

  it("截止时间立刻到达：摘要里提示稍后执行 kh pull", async () => {
    await A.write("notes/new.md", "from A\n");
    await A.kh(["sync"]);
    let t = Date.now();
    const r = await startB("s-deadline", { now: () => new Date((t += 10_000)) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("自动拉取超时，已停止；稍后执行 kh pull");
  });

  it("同步锁被占用：摘要里有“本次没有自动拉取”，不等待 5 秒", async () => {
    await A.write("notes/new.md", "from A\n");
    await A.kh(["sync"]);
    await holdLock(B.home, fleet.projectId);
    const started = Date.now();
    const r = await startB("s-busy");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.stdout).toContain("另一个同步或拉取正在进行，本次没有自动拉取");
    expect(await B.exists("notes/new.md")).toBe(false);
  });

  it("其他机器都没有快照：摘要里没有拉取这一行", async () => {
    const r = await startB("s-none");
    expect(r.stdout).toContain("上报规则");
    expect(r.stdout).not.toContain("自动拉取");
  });

  it("拉取中途下载文件遇到 404：摘要里是“自动拉取失败”，已完成的部分照常计入", async () => {
    await A.write("notes/a.md", "a\n");
    await A.write("notes/b.md", "b\n");
    await A.kh(["sync"]);
    const real = globalThis.fetch.bind(globalThis);
    const failing = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/files/") && url.includes("b.md")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "not_found", message: "快照文件不存在" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return real(input, init);
    }) as typeof fetch;
    const r = await startB("s-404", { fetch: failing });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("自动拉取：新建 1");
    expect(r.stdout).toContain("自动拉取失败：快照文件不存在；稍后执行 kh pull");
    expect(await B.read("notes/a.md")).toBe("a\n");
  });

  it("两边都改了同一个文件：登记冲突，摘要列出路径、对方机器名、kh conflicts show，并提示先处理冲突", async () => {
    await B.write("notes/c.md", "B 的版本\n");
    await A.write("notes/c.md", "A 的版本\n");
    await A.kh(["sync"]);
    const r = await startB("s-conflict");
    expect(r.stdout).toContain("自动拉取：冲突 1");
    expect(r.stdout).toContain("先处理冲突再开始任务");
    expect(r.stdout).toContain("notes/c.md（对方：机器A）→ kh conflicts show notes/c.md");
  });

  it("自动拉取写入的文件不算本次会话的改动：紧接着 stop 退出码 0", async () => {
    const config = (auto: boolean) => ({
      projectId: fleet.projectId,
      sync: { include: ["notes/**", "docs/**"], exclude: [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
      pull: { auto },
    });
    await writeRepoConfig(A.repo, config(true));
    await writeRepoConfig(B.repo, config(true));
    // docs/ 没有被 git 忽略：拉下来的文件会出现在 git status 里
    await A.write("docs/shared.md", "shared\n");
    await A.kh(["sync"]);

    const start = await startB("s-pulled");
    expect(start.stdout).toContain("自动拉取：新建 1");
    expect(gitFixture(["status", "--porcelain"], B.repo)).toContain("docs/");

    const stop = await hook("stop", { session_id: "s-pulled", cwd: B.repo }, { khHome: B.home });
    expect(stop).toMatchObject({ code: 0, stderr: "" });
  });
});

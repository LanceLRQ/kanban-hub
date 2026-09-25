/**
 * kh 全流程端到端测试：用同一个临时 KH_HOME 和同一个临时仓库，依次执行真实的
 * login → register --new --yes → container add → task add/set/human/checklist/check → log → status --json，
 * 证明 M3 的各条命令能串成一条完整的使用路径（验收条件），而不是分别测试单个命令。
 *
 * 断言四件事：
 * 1. `status --json` 的内容与实际执行过的操作一致（项目、容器进度、任务状态、待你处理、清单）；
 * 2. 服务端事件的类型序列，以及每条事件的 actor.agent（本文件统一传 CLAUDECODE=1 环境变量）；
 * 3. 仓库的 `git status --porcelain` 全程保持为空（kh 不侵入被管理的仓库）；
 * 4. 所有命令的 stdout/stderr 都不包含令牌。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMachineConfig } from "../../../../packages/cli/src/config/home";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, makeTempKhHome, makeTempRepo, runKh, type RunKhResult, type TempDir, type TempRepo } from "./harness";

interface StatusJsonTask {
  id: string;
  ref: string;
  code: string | null;
  title: string;
  status: string;
  human: { kind: string; note: string } | null;
  checklist: { done: number; total: number };
}

interface StatusJsonContainer {
  id: string;
  code: string | null;
  status: string | null;
  progress: { done: number; total: number };
  tasks: StatusJsonTask[];
}

interface StatusJsonInboxItem {
  ref: string;
  taskTitle: string;
  kind: string;
  note: string;
  container: string;
}

interface StatusJson {
  project: { id: string; name: string; progress: { done: number; total: number } };
  location: { path: string; lastSyncAt: string | null } | null;
  containers: StatusJsonContainer[];
  inbox: StatusJsonInboxItem[];
}

function gitStatusPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
}

/** 从 "已新建任务 #xxxx" 这类输出里解析出打印的短 ID，后续命令用 #短ID 定位任务 */
function parseShortId(stdout: string): string {
  const match = /#([0-9a-z]{4,10})/.exec(stdout);
  if (!match) throw new Error(`未能从输出里解析出短 ID：${stdout}`);
  return match[1]!;
}

describe("kh 全流程", () => {
  let server: TestServer;
  let repo: TempRepo;
  let home: TempDir;
  const results: RunKhResult[] = [];

  beforeAll(async () => {
    server = await startTestServer();
    repo = await makeTempRepo();
    home = await makeTempKhHome();
  });

  afterAll(async () => {
    await cleanupAll(repo, home);
    await server.close();
  });

  /** 全流程统一用同一个 KH_HOME、同一个临时仓库；agent 固定用 CLAUDECODE=1 标注成 claude-code */
  async function run(args: string[]): Promise<RunKhResult> {
    const result = await runKh(args, { cwd: repo.dir, khHome: home.dir, env: { CLAUDECODE: "1" } });
    results.push(result);
    return result;
  }

  it("login → register → container/task/log 上报 → status --json，全流程一致", async () => {
    // 1. login
    const { code } = server.issuePairingCode();
    const login = await run(["login", "--server", server.url, "--code", code, "--name", "端到端测试机"]);
    expect(login.code).toBe(0);

    const machineConfig = await readMachineConfig(home.dir);
    if (!machineConfig?.machineId) throw new Error("测试前置条件失败：登录后读不到 machineId");

    // 2. register --new --yes：真实的注册命令，不再借道测试服务端的 Store
    const register = await run(["register", "--new", "--yes"]);
    expect(register.code).toBe(0);
    expect(register.stdout).toContain("kh status");
    expect(gitStatusPorcelain(repo.dir)).toBe("");

    const projects = server.api.store.listProjects();
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    const expectedProjectName = path.basename(repo.dir);
    expect(project.name).toBe(expectedProjectName);

    const config = await fs.readFile(path.join(repo.dir, ".kanban-hub", "config.yaml"), "utf8");
    expect(config).toContain(project.id);

    // 3. container add phase 两个
    const container1 = await run(["container", "add", "phase", "阶段一", "--code", "M1"]);
    expect(container1.code).toBe(0);
    const container2 = await run(["container", "add", "phase", "阶段二", "--code", "M2"]);
    expect(container2.code).toBe(0);
    expect(gitStatusPorcelain(repo.dir)).toBe("");

    // 4. task add 若干
    const addA = await run(["task", "add", "M1", "完成设计", "--code", "1.1", "--due", "2026-10-01"]);
    expect(addA.code).toBe(0);
    const taskA = parseShortId(addA.stdout);

    const addB = await run(["task", "add", "M1", "编写代码", "--code", "1.2"]);
    expect(addB.code).toBe(0);
    const taskB = parseShortId(addB.stdout);

    const addC = await run(["task", "add", "M2", "调研方案", "--code", "2.1"]);
    expect(addC.code).toBe(0);
    const taskC = parseShortId(addC.stdout);

    // 5. task set 改状态：taskA 走完整的状态流转，taskB 只推进到进行中
    expect((await run(["task", "set", `#${taskA}`, "--status", "in_progress"])).code).toBe(0);
    expect((await run(["task", "set", `#${taskA}`, "--status", "review"])).code).toBe(0);
    expect((await run(["task", "set", `#${taskA}`, "--status", "done"])).code).toBe(0);
    expect((await run(["task", "set", `#${taskB}`, "--status", "in_progress"])).code).toBe(0);

    // 6. task human：taskC 标记待决策
    const human = await run(["task", "human", `#${taskC}`, "--decision", "选型A还是B"]);
    expect(human.code).toBe(0);

    // 7. task check（先 checklist --add，再勾选第一项）
    const checklist = await run(["task", "checklist", `#${taskB}`, "--add", "自测", "--add", "提交PR"]);
    expect(checklist.code).toBe(0);
    const check = await run(["task", "check", `#${taskB}`, "1"]);
    expect(check.code).toBe(0);

    // 8. log
    const log = await run(["log", "阶段一已完成"]);
    expect(log.code).toBe(0);

    expect(gitStatusPorcelain(repo.dir)).toBe("");

    // 9. status --json：内容要和上面的操作一致
    const status = await run(["status", "--json"]);
    expect(status.code).toBe(0);
    const json = JSON.parse(status.stdout) as StatusJson;

    expect(json.project.name).toBe(expectedProjectName);
    expect(json.project.progress).toEqual({ done: 1, total: 3 });
    expect(json.location).not.toBeNull();
    expect(json.location?.path).toBe(repo.dir);

    const m1 = json.containers.find((c) => c.code === "M1");
    expect(m1?.status).toBe("in_progress");
    expect(m1?.progress).toEqual({ done: 1, total: 2 });

    const jsonTaskA = m1?.tasks.find((t) => t.title === "完成设计");
    expect(jsonTaskA?.status).toBe("done");
    expect(jsonTaskA?.code).toBe("1.1");

    const jsonTaskB = m1?.tasks.find((t) => t.title === "编写代码");
    expect(jsonTaskB?.status).toBe("in_progress");
    expect(jsonTaskB?.checklist).toEqual({ done: 1, total: 2 });

    const m2 = json.containers.find((c) => c.code === "M2");
    expect(m2?.status).toBe("todo");
    expect(m2?.progress).toEqual({ done: 0, total: 1 });

    const jsonTaskC = m2?.tasks.find((t) => t.title === "调研方案");
    expect(jsonTaskC?.human).toEqual({ kind: "decision", note: "选型A还是B" });

    expect(json.inbox).toHaveLength(1);
    expect(json.inbox[0]).toMatchObject({
      taskTitle: "调研方案",
      kind: "decision",
      note: "选型A还是B",
      container: "M2",
    });

    // 事件类型序列：按时间正序排列（store 按倒序返回，这里反转），逐条核对类型与 actor
    const events = [...(await server.api.store.listEvents({ projectId: project.id, limit: 100 }))].reverse();
    expect(events.map((e) => e.type)).toEqual([
      "project.created",
      "project.updated",
      "container.created",
      "container.created",
      "task.created",
      "task.created",
      "task.created",
      "task.status_changed",
      "task.status_changed",
      "task.status_changed",
      "task.status_changed",
      "task.human_changed",
      "task.updated",
      "task.updated",
      "log",
    ]);
    for (const event of events) {
      expect(event.actor.via).toBe("cli");
      expect(event.actor.agent).toBe("claude-code");
      expect(event.actor.machineId).toBe(machineConfig.machineId);
    }

    // 令牌不出现在任何一步的输出里
    const token = (await fs.readFile(path.join(home.dir, "credentials"), "utf8")).trim();
    expect(token.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
    }
  });
});

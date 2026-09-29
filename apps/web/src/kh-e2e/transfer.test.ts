/**
 * kh import / kh export 的端到端测试：进程内测试服务端 + 驱动 cli 的 main()。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeBoardForCompare } from "@kanban-hub/core/test-fixtures";
import { EXIT } from "../../../../packages/cli/src/errors";
import { readLastReport } from "../../../../packages/cli/src/report-log";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, loginFixture, makeTempKhHome, makeTempRepo, registerProjectFixture, runKh, type TempDir, type TempRepo } from "./harness";
import { makeFleet } from "./fleet";

const DOC = `format: kanban-hub/v1
project:
  cycle: development
  focus: 完成 M6
containers:
  - kind: phase
    code: "P0"
    title: 工程骨架
    targetVersion: "1.10"
    tasks:
      - code: "0.1"
        title: 初始化仓库
        status: done
        completedAt: 2026-09-03T18:00:00+08:00
      - code: "0.2"
        title: 写文档
        status: todo
        checklist:
          - { text: 列提纲, done: true }
  - kind: misc
    tasks:
      - title: 杂项任务
events:
  - ts: 2026-09-03T18:00:00+08:00
    text: 完成工程骨架
`;

let server: TestServer;
let home: TempDir;
let repo: TempRepo;
let projectId: string;

beforeEach(async () => {
  server = await startTestServer();
  home = await makeTempKhHome();
  repo = await makeTempRepo();
  await loginFixture(server, repo, home);
  ({ projectId } = await registerProjectFixture(server, repo, home, { name: "导入导出项目" }));
});

afterEach(async () => {
  await cleanupAll(home, repo);
  await server.close();
});

const kh = (args: string[], cwd = repo.dir) => runKh(args, { cwd, khHome: home.dir });
const write = (name: string, content: string, dir = repo.dir) => fs.writeFile(path.join(dir, name), content);

describe("kh import", () => {
  it("--dry-run 不改任何数据，输出列出将要新建的条目", async () => {
    await write("in.yaml", DOC);
    const boardBefore = JSON.stringify(server.api.store.getBoard(projectId));
    const eventsBefore = (await server.api.store.listEvents({ projectId, limit: 100 })).length;

    const r = await kh(["import", "in.yaml", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("没有写入任何数据");
    expect(r.stdout).toContain("新建容器");
    expect(r.stdout).toContain("初始化仓库");

    expect(JSON.stringify(server.api.store.getBoard(projectId))).toBe(boardBefore);
    expect((await server.api.store.listEvents({ projectId, limit: 100 })).length).toBe(eventsBefore);
    expect(await readLastReport(home.dir, projectId)).toBeNull();
  });

  it("正式导入后 status 能看到任务，再导一次没有变化，改状态再导有状态变化并记 import.applied", async () => {
    await write("in.yaml", DOC);
    const first = await kh(["import", "in.yaml"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("新建任务");
    expect(await readLastReport(home.dir, projectId)).not.toBeNull();

    const status = await kh(["status"]);
    expect(status.stdout).toContain("工程骨架");
    expect(status.stdout).toContain("写文档");

    const again = await kh(["import", "in.yaml"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("没有需要导入的变化");

    const reportBefore = await readLastReport(home.dir, projectId);
    await new Promise((r) => setTimeout(r, 20));
    await write("in.yaml", DOC.replace("title: 写文档\n        status: todo", "title: 写文档\n        status: in_progress"));
    const changed = await kh(["import", "in.yaml"]);
    expect(changed.code).toBe(0);
    expect(changed.stdout).toContain("状态变化");
    expect((await readLastReport(home.dir, projectId))!.getTime()).toBeGreaterThan(reportBefore!.getTime());

    const events = await server.api.store.listEvents({ projectId, limit: 100 });
    expect(events.filter((e) => e.type === "import.applied").length).toBe(2);
  });

  it("文件不存在：退出码 2", async () => {
    const r = await kh(["import", "nope.yaml"]);
    expect(r.code).toBe(EXIT.USAGE);
  });

  it("语法错误带行号列号：退出码 5", async () => {
    await write("bad.yaml", "format: kanban-hub/v1\ncontainers: [\n");
    const r = await kh(["import", "bad.yaml"]);
    expect(r.code).toBe(EXIT.DATA);
    expect(r.stderr).toMatch(/第 \d+ 行第 \d+ 列/);
  });

  it("重复的键：退出码 5", async () => {
    await write("dup.yaml", "format: kanban-hub/v1\ncontainers: []\ncontainers: []\n");
    const r = await kh(["import", "dup.yaml"]);
    expect(r.code).toBe(EXIT.DATA);
    expect(r.stderr).toMatch(/第 \d+ 行/);
  });

  it("%YAML 1.1 指令：退出码 5", async () => {
    await write("old.yaml", "%YAML 1.1\n---\nformat: kanban-hub/v1\ncontainers: []\n");
    const r = await kh(["import", "old.yaml"]);
    expect(r.code).toBe(EXIT.DATA);
    expect(r.stderr).toContain("%YAML");
  });

  it("字段错误逐条列出路径：退出码 5", async () => {
    await write("f.yaml", "format: kanban-hub/v1\ncontainers:\n  - kind: phase\n    title: A\n    tasks:\n      - title: T\n        status: bogus\n");
    const r = await kh(["import", "f.yaml"]);
    expect(r.code).toBe(EXIT.DATA);
    expect(r.stderr).toContain("containers[0].tasks[0].status");
  });

  it("编号写成数字：退出码 5，提示加引号", async () => {
    await write("n.yaml", "format: kanban-hub/v1\ncontainers:\n  - kind: phase\n    code: 2.3\n    title: A\n");
    const r = await kh(["import", "n.yaml"]);
    expect(r.code).toBe(EXIT.DATA);
    expect(r.stderr).toContain("containers[0].code");
    expect(r.stderr).toContain("引号");
  });
});

describe("kh export", () => {
  beforeEach(async () => {
    await write("in.yaml", DOC);
    const r = await kh(["import", "in.yaml"]);
    if (r.code !== 0) throw new Error(r.stderr);
  });

  it("YAML 能被 import --dry-run 读回，没有变化", async () => {
    const out = await kh(["export"]);
    expect(out.code).toBe(0);
    await write("back.yaml", out.stdout);
    const r = await kh(["import", "back.yaml", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("没有需要导入的变化");
  });

  it("导进另一个新项目后看板等价", async () => {
    const out = await kh(["export"]);
    const repo2 = await makeTempRepo();
    try {
      const { projectId: p2 } = await registerProjectFixture(server, repo2, home, { name: "另一个项目" });
      await write("back.yaml", out.stdout, repo2.dir);
      const r = await kh(["import", "back.yaml"], repo2.dir);
      expect(r.code).toBe(0);
      const a = server.api.store.getBoard(projectId)!;
      const b = server.api.store.getBoard(p2)!;
      expect(normalizeBoardForCompare(b as never)).toEqual(normalizeBoardForCompare(a as never));
    } finally {
      await cleanupAll(repo2);
    }
  });

  it("--md 含项目名和容器标题", async () => {
    const r = await kh(["export", "--md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("导入导出项目");
    expect(r.stdout).toContain("工程骨架");
  });

  it("-o 写出文件，stdout 为空，stderr 提示路径", async () => {
    const r = await kh(["export", "-o", "out.yaml"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("已导出到 out.yaml");
    const written = await fs.readFile(path.join(repo.dir, "out.yaml"), "utf8");
    expect(written).toBe((await kh(["export"])).stdout);
  });

  it("-o 的父目录不存在：退出码 2", async () => {
    const r = await kh(["export", "-o", "no-such-dir/out.yaml"]);
    expect(r.code).toBe(EXIT.USAGE);
  });
});

describe("跨机器导出", () => {
  it("另一台机器导出同一个项目的 YAML，内容逐字一致", async () => {
    const { fleet, first } = await makeFleet(server);
    try {
      await first.write("in.yaml", DOC);
      const imported = await first.kh(["import", "in.yaml"]);
      expect(imported.code).toBe(0);
      const second = await fleet.add("机器B");
      const a = await first.kh(["export"]);
      const b = await second.kh(["export"]);
      expect(a.code).toBe(0);
      expect(b.stdout).toBe(a.stdout);
      expect(a.stdout.length).toBeGreaterThan(0);
    } finally {
      await fleet.cleanup();
    }
  });
});

/**
 * kh project / container / log 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）
 * 驱动 cli 的 main()。register 命令自己的行为在 register.test.ts 单独测试，这里用 harness 的
 * loginFixture / registerProjectFixture 直接搭好前置条件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../../../packages/cli/src/errors";
import { readLastReport } from "../../../../packages/cli/src/report-log";
import { startTestServer, type TestServer } from "../server/api/test-server";
import {
  cleanupAll,
  loginFixture,
  makeTempKhHome,
  makeTempRepo,
  registerProjectFixture,
  runKh,
  type RegisterFixtureResult,
  type TempDir,
  type TempRepo,
} from "./harness";

async function setupProject(
  server: TestServer,
  repo: TempRepo,
  khHome: TempDir,
  name = "看板测试项目",
): Promise<RegisterFixtureResult> {
  await loginFixture(server, repo, khHome);
  return registerProjectFixture(server, repo, khHome, { name });
}

describe("kh project / container / log", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe("kh project set", () => {
    it("修改周期、健康度、焦点后，服务端数据同步变化，事件 actor.via 是 cli 且带 machineId", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId, machineId } = await setupProject(server, repo, home);

        const result = await runKh(
          ["project", "set", "--cycle", "development", "--health", "at_risk", "--focus", "重构存储层"],
          { cwd: repo.dir, khHome: home.dir },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("开发期");
        expect(result.stdout).toContain("重构存储层");

        const project = server.api.store.getProject(projectId);
        expect(project?.cycle).toBe("development");
        expect(project?.health).toBe("at_risk");
        expect(project?.focus).toBe("重构存储层");

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "project.updated");
        expect(event).toBeDefined();
        expect(event?.actor.via).toBe("cli");
        expect(event?.actor.machineId).toBe(machineId);
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("设置了 CLAUDECODE=1 时，事件的 agent 是 claude-code", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const result = await runKh(["project", "set", "--focus", "阶段一"], {
          cwd: repo.dir,
          khHome: home.dir,
          env: { CLAUDECODE: "1" },
        });
        expect(result.code).toBe(0);

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "project.updated");
        expect(event?.actor.agent).toBe("claude-code");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--agent foo 覆盖环境变量识别结果，事件里是 foo", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const result = await runKh(["--agent", "foo", "project", "set", "--focus", "阶段二"], {
          cwd: repo.dir,
          khHome: home.dir,
          env: { CLAUDECODE: "1" },
        });
        expect(result.code).toBe(0);

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "project.updated");
        expect(event?.actor.agent).toBe("foo");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--agent 写在子命令后面也生效", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const result = await runKh(["project", "set", "--focus", "阶段三", "--agent", "after-leaf"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(result.code).toBe(0);

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "project.updated");
        expect(event?.actor.agent).toBe("after-leaf");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--agent 前后都给时，以子命令上的为准", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const result = await runKh(
          ["--agent", "before-root", "project", "set", "--focus", "阶段四", "--agent", "after-leaf"],
          { cwd: repo.dir, khHome: home.dir },
        );
        expect(result.code).toBe(0);

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "project.updated");
        expect(event?.actor.agent).toBe("after-leaf");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("不给任何选项，退出码 2", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const result = await runKh(["project", "set"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(EXIT.USAGE);
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("取值非法，退出码 2，并列出可选值", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const result = await runKh(["project", "set", "--cycle", "不存在的周期"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(EXIT.USAGE);
        expect(result.stderr).toContain("development");
        expect(result.stderr).toContain("提示：");
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });

  describe("kh container add", () => {
    it("新建阶段和特性容器", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const phase = await runKh(["container", "add", "phase", "阶段一", "--code", "M1"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(phase.code).toBe(0);
        expect(phase.stdout).toContain("阶段");
        expect(phase.stdout).toContain("M1");

        const feature = await runKh(["container", "add", "feature", "某个特性", "--code", "F1"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(feature.code).toBe(0);
        expect(feature.stdout).toContain("特性");

        const board = server.api.store.getBoard(projectId);
        expect(board?.containers.some((c) => c.kind === "phase" && c.code === "M1" && c.title === "阶段一")).toBe(true);
        expect(board?.containers.some((c) => c.kind === "feature" && c.code === "F1" && c.title === "某个特性")).toBe(true);
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--version 不会被根命令的 -v/--version 截走，服务端的 targetVersion 正确（回归 C1）", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        const result = await runKh(["container", "add", "phase", "阶段一", "--code", "M1", "--version", "v1.1"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(result.code).toBe(0);
        expect(result.stdout).not.toBe("0.1.0\n");

        const board = server.api.store.getBoard(projectId);
        expect(board?.containers.find((c) => c.code === "M1")?.targetVersion).toBe("v1.1");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("编号与已有容器重复时，退出码 5", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const first = await runKh(["container", "add", "phase", "阶段一", "--code", "M1"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(first.code).toBe(0);

        const dup = await runKh(["container", "add", "feature", "重复编号", "--code", "M1"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(dup.code).toBe(EXIT.DATA);
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });

  describe("kh container set", () => {
    async function addContainer(repo: TempRepo, home: TempDir, code: string, title = "容器"): Promise<void> {
      const result = await runKh(["container", "add", "phase", title, "--code", code], { cwd: repo.dir, khHome: home.dir });
      if (result.code !== 0) throw new Error(`测试前置条件失败：新建容器失败（${result.code}）：${result.stderr}`);
    }

    it("按编号能找到容器；--status suspended 不给 --reason 时退出码 2，给了 --reason 才生效", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        await addContainer(repo, home, "M1");

        const noReason = await runKh(["container", "set", "M1", "--status", "suspended"], { cwd: repo.dir, khHome: home.dir });
        expect(noReason.code).toBe(EXIT.USAGE);

        const board = server.api.store.getBoard(projectId);
        const untouched = board?.containers.find((c) => c.code === "M1");
        expect(untouched?.manualStatus).toBeNull();

        const withReason = await runKh(["container", "set", "M1", "--status", "suspended", "--reason", "等待评审"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(withReason.code).toBe(0);
        expect(withReason.stdout).toContain("挂起");

        const after = server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M1");
        expect(after?.manualStatus).toBe("suspended");
        expect(after?.manualReason).toBe("等待评审");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("挂起改成储备后，原因被清空", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        await addContainer(repo, home, "M2");
        await runKh(["container", "set", "M2", "--status", "suspended", "--reason", "等待联调"], {
          cwd: repo.dir,
          khHome: home.dir,
        });

        const result = await runKh(["container", "set", "M2", "--status", "backlog"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(0);

        const container = server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M2");
        expect(container?.manualStatus).toBe("backlog");
        expect(container?.manualReason).toBeNull();
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--status auto 恢复自动", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        await addContainer(repo, home, "M3");
        await runKh(["container", "set", "M3", "--status", "suspended", "--reason", "占位"], {
          cwd: repo.dir,
          khHome: home.dir,
        });

        const result = await runKh(["container", "set", "M3", "--status", "auto"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(0);

        const container = server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M3");
        expect(container?.manualStatus).toBeNull();
        expect(container?.manualReason).toBeNull();
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("按 misc 和 ID 前缀都能找到容器", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const viaMisc = await runKh(["container", "set", "misc", "--title", "杂项容器"], { cwd: repo.dir, khHome: home.dir });
        expect(viaMisc.code).toBe(0);

        const board = server.api.store.getBoard(projectId);
        const misc = board?.containers.find((c) => c.kind === "misc");
        expect(misc?.title).toBe("杂项容器");

        const viaId = await runKh(["container", "set", misc!.id, "--title", "杂项容器（改名）"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(viaId.code).toBe(0);
        const renamed = server.api.store.getBoard(projectId)?.containers.find((c) => c.kind === "misc");
        expect(renamed?.title).toBe("杂项容器（改名）");
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("对杂项容器设置状态，退出码 5", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const result = await runKh(["container", "set", "misc", "--status", "suspended", "--reason", "x"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(result.code).toBe(EXIT.DATA);
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--target-date 空字符串清空日期", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        const created = await runKh(["container", "add", "phase", "阶段四", "--code", "M4", "--target-date", "2026-12-31"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(created.code).toBe(0);
        expect(server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M4")?.targetDate).toBe(
          "2026-12-31",
        );

        const cleared = await runKh(["container", "set", "M4", "--target-date", ""], { cwd: repo.dir, khHome: home.dir });
        expect(cleared.code).toBe(0);

        const container = server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M4");
        expect(container?.targetDate).toBeNull();
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("--version 空字符串清空版本号，且不会被根命令的 -v/--version 截走（回归 C1）", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        const created = await runKh(["container", "add", "phase", "阶段五", "--code", "M5", "--version", "v1.0"], {
          cwd: repo.dir,
          khHome: home.dir,
        });
        expect(created.code).toBe(0);
        expect(server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M5")?.targetVersion).toBe(
          "v1.0",
        );

        const cleared = await runKh(["container", "set", "M5", "--version", ""], { cwd: repo.dir, khHome: home.dir });
        expect(cleared.code).toBe(0);
        expect(cleared.stdout).not.toBe("0.1.0\n");

        const container = server.api.store.getBoard(projectId)?.containers.find((c) => c.code === "M5");
        expect(container?.targetVersion).toBeNull();
      } finally {
        await cleanupAll(repo, home);
      }
    });

    it("找不到容器，退出码 5", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const result = await runKh(["container", "set", "找不到的容器", "--title", "x"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(EXIT.DATA);
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });

  describe("kh log", () => {
    it("写入后，事件里有 log，正文一致", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);

        const result = await runKh(["log", "修复了同步的一个 bug"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(0);

        const events = await server.api.store.listEvents({ projectId, limit: 10 });
        const event = events.find((e) => e.type === "log");
        expect(event?.text).toBe("修复了同步的一个 bug");
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });

  describe("上报时间", () => {
    it("命令失败时不写 cache/reports/<项目ID>.json", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        expect(await readLastReport(home.dir, projectId)).toBeNull();

        const failed = await runKh(["container", "set", "找不到的容器", "--title", "x"], { cwd: repo.dir, khHome: home.dir });
        expect(failed.code).not.toBe(0);
        expect(await readLastReport(home.dir, projectId)).toBeNull();
      } finally {
        await cleanupAll(repo, home);
      }
    });

    // 每个看板写命令成功后都要更新上报时间，逐条验证时间戳确实前进了一格，
    // 而不是只在第一次成功后检查一次“非空”就当作全部覆盖到
    it.each<[string, string[][], string[]]>([
      ["project set", [], ["project", "set", "--focus", "阶段一"]],
      ["container add", [], ["container", "add", "phase", "新阶段", "--code", "P1"]],
      [
        "container set",
        [["container", "add", "phase", "新阶段", "--code", "P1"]],
        ["container", "set", "P1", "--title", "阶段一（修订）"],
      ],
      ["log", [], ["log", "记一笔"]],
    ])("%s 成功后更新上报时间", async (_name, prepareCommands, args) => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        const { projectId } = await setupProject(server, repo, home);
        for (const prepare of prepareCommands) {
          const prepared = await runKh(prepare, { cwd: repo.dir, khHome: home.dir });
          if (prepared.code !== 0) throw new Error(`准备阶段失败：${prepare.join(" ")}：${prepared.stderr}`);
        }

        const before = Date.now();
        const result = await runKh(args, { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(0);

        const report = await readLastReport(home.dir, projectId);
        expect(report).not.toBeNull();
        expect(report!.getTime()).toBeGreaterThanOrEqual(before);
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });

  describe("输出不带令牌", () => {
    it("project set 的 stdout/stderr 不含令牌", async () => {
      const repo = await makeTempRepo();
      const home = await makeTempKhHome();
      try {
        await setupProject(server, repo, home);
        const credentials = await fs.readFile(path.join(home.dir, "credentials"), "utf8");
        const realToken = credentials.trim();

        const result = await runKh(["project", "set", "--focus", "阶段一"], { cwd: repo.dir, khHome: home.dir });
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain(realToken);
        expect(result.stderr).not.toContain(realToken);
      } finally {
        await cleanupAll(repo, home);
      }
    });
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { projectDetailResponse } from "@kanban-hub/core/api";
import type { Board } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { EXIT, type CliError } from "../errors";
import { writeMachineConfig, writeToken } from "../config/home";
import { writeRepoConfig } from "../repo/config";
import { ApiClient } from "../http/client";
import {
  afterReport,
  assertAnyOptionGiven,
  containerRefLabel,
  displayEmpty,
  formatChange,
  globalAgentFlag,
  loadProject,
  loadProjectOrFail,
  parseEnumOption,
  parseNullableDateOption,
  parseNullableOption,
  requireLogin,
  requireRegisteredRepo,
  resolveContainerOrFail,
  resolveTaskOrFail,
  shortRef,
  withAgentOption,
} from "./shared";

/** 测试用的合法机器令牌：kh_ 加 43 位 [A-Za-z0-9_-] */
const FAKE_TOKEN = `kh_${"a".repeat(43)}`;

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function fakeContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在这个测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望 promise 被 reject，但它 resolve 了");
}

interface CapturingServer {
  url: string;
  headers(): http.IncomingHttpHeaders | undefined;
  close(): Promise<void>;
}

/** 起一个只记录最近一次请求头、返回固定 200 的桩服务，用来验证 ApiClient 实际发出的请求头 */
function serveCapturingHeaders(): Promise<CapturingServer> {
  return new Promise((resolve) => {
    let captured: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((req, res) => {
      captured = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        headers: () => captured,
        close: () => new Promise((res2, rej2) => server.close((e) => (e ? rej2(e) : res2()))),
      });
    });
  });
}

const okSchema = z.object({ ok: z.boolean() });

describe("globalAgentFlag", () => {
  it("子命令能拿到根命令的全局 --agent", () => {
    const root = new Command().exitOverride().option("--agent <名称>", "agent");
    let captured: string | undefined;
    root
      .command("sub")
      .exitOverride()
      .action(function (this: Command) {
        captured = globalAgentFlag(this);
      });
    root.parse(["sub", "--agent", "claude-code"], { from: "user" });
    expect(captured).toBe("claude-code");
  });

  it("没给 --agent 时为 undefined", () => {
    const root = new Command().exitOverride().option("--agent <名称>", "agent");
    let captured: string | undefined = "not-set" as string | undefined;
    root
      .command("sub")
      .exitOverride()
      .action(function (this: Command) {
        captured = globalAgentFlag(this);
      });
    root.parse(["sub"], { from: "user" });
    expect(captured).toBeUndefined();
  });
});

describe("requireLogin：agent 解析（收进公共件，写命令不用各自调 resolveAgent）", () => {
  async function loggedInHome(server: string): Promise<string> {
    const home = await tmpDir("kh-shared-home-");
    await writeMachineConfig(home, { server, machineId: "abcdefghij", machineName: "m" });
    await writeToken(home, FAKE_TOKEN);
    return home;
  }

  it("没给 flag 时按环境变量识别，请求头带 X-KH-Agent", async () => {
    const stub = await serveCapturingHeaders();
    try {
      const home = await loggedInHome(stub.url);
      const ctx = fakeContext({ env: { KH_HOME: home, CLAUDECODE: "1" }, fetch });
      const { client } = await requireLogin(ctx);
      await client.get("/x", okSchema);
      expect(stub.headers()?.["x-kh-agent"]).toBe("claude-code");
    } finally {
      await stub.close();
    }
  });

  it("给了 flag 时覆盖环境变量识别结果", async () => {
    const stub = await serveCapturingHeaders();
    try {
      const home = await loggedInHome(stub.url);
      const ctx = fakeContext({ env: { KH_HOME: home, CLAUDECODE: "1" }, fetch });
      const { client } = await requireLogin(ctx, "custom-agent");
      await client.get("/x", okSchema);
      expect(stub.headers()?.["x-kh-agent"]).toBe("custom-agent");
    } finally {
      await stub.close();
    }
  });

  it("都没有时不带 X-KH-Agent 请求头", async () => {
    const stub = await serveCapturingHeaders();
    try {
      const home = await loggedInHome(stub.url);
      const ctx = fakeContext({ env: { KH_HOME: home }, fetch });
      const { client } = await requireLogin(ctx);
      await client.get("/x", okSchema);
      expect(stub.headers()?.["x-kh-agent"]).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it("agent 超过 50 个字符时抛 CliError(2)", async () => {
    const home = await tmpDir("kh-shared-home-");
    await writeMachineConfig(home, { server: "http://example.test", machineId: "abcdefghij", machineName: "m" });
    await writeToken(home, FAKE_TOKEN);
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await captureError(requireLogin(ctx, "a".repeat(51)));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("agent 不合法时，即使没有登录也抛 CliError(2)：本地可判定的用法错误优先于登录检查", async () => {
    const home = await tmpDir("kh-shared-home-");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await captureError(requireLogin(ctx, "非法 agent 名称"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("requireLogin", () => {
  it("没有本机配置时抛 CliError(3)，提示 kh login", async () => {
    const home = await tmpDir("kh-shared-home-");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await captureError(requireLogin(ctx));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.hint).toContain("kh login");
  });

  it("有配置但从未配对（没有 machineId）时抛 CliError(3)，本机配置里已有服务端地址，提示 /setup", async () => {
    const home = await tmpDir("kh-shared-home-");
    await writeMachineConfig(home, { server: "http://example.test" });
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await captureError(requireLogin(ctx));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.hint).toContain("http://example.test/setup");
    expect(err.hint).toContain("kh login --code");
  });

  it("配置里有机器身份但凭据文件缺失时抛 CliError(3)", async () => {
    const home = await tmpDir("kh-shared-home-");
    await writeMachineConfig(home, { server: "http://example.test", machineId: "abcdefghij", machineName: "m" });
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await captureError(requireLogin(ctx));
    expect(err.exitCode).toBe(EXIT.AUTH);
  });

  it("配置和凭据都在时返回 client/machine/server", async () => {
    const home = await tmpDir("kh-shared-home-");
    await writeMachineConfig(home, { server: "http://example.test", machineId: "abcdefghij", machineName: "我的电脑" });
    await writeToken(home, FAKE_TOKEN);
    const ctx = fakeContext({ env: { KH_HOME: home }, platform: "linux" });
    const result = await requireLogin(ctx);
    expect(result.server).toBe("http://example.test");
    expect(result.machine).toEqual({ id: "abcdefghij", name: "我的电脑" });
    expect(result.client).toBeInstanceOf(ApiClient);
  });
});

describe("requireRegisteredRepo", () => {
  it("当前目录不在已注册的仓库里时抛 CliError(2)，提示 kh register", async () => {
    const dir = await tmpDir("kh-shared-repo-");
    const ctx = fakeContext({ cwd: dir, homeDir: dir });
    const err = await captureError(requireRegisteredRepo(ctx));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("kh register");
  });

  it("找到注册信息时返回 root 和 config", async () => {
    const dir = await tmpDir("kh-shared-repo-");
    await writeRepoConfig(dir, { projectId: "abcdefghij", sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" }, pull: { auto: true } });
    // homeDir 不能等于 dir：默认 KH_HOME 是 homeDir 下的 .kanban-hub，等于 dir 会被
    // collidesWithKhHome 判定为撞路径而跳过（这里只是想要一个和仓库目录无关的 homeDir）
    const ctx = fakeContext({ cwd: dir, homeDir: path.dirname(dir) });
    const result = await requireRegisteredRepo(ctx);
    expect(result.root).toBe(dir);
    expect(result.config.projectId).toBe("abcdefghij");
  });
});

describe("loadProject", () => {
  it("按项目 ID 请求 /api/v1/projects/:id，并按 schema 解析返回", async () => {
    const project = {
      id: "abcdefghij",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "示例项目",
      description: "",
      cycle: "development",
      health: "on_track",
      focus: "",
      fingerprint: null,
      locations: [],
    };
    const board: Board = { containers: [{ id: "cccccccccc", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", kind: "misc", code: null, title: "杂项", order: 0, targetVersion: null, targetDate: null, manualStatus: null, manualReason: null }], tasks: [] };
    const body = { project, lastEventAt: null, stale: false, board };
    let requestedPath = "";
    const server = http.createServer((req, res) => {
      requestedPath = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new ApiClient({ server: `http://127.0.0.1:${port}`, fetch });
      const result = await loadProject(client, "abcdefghij");
      expect(requestedPath).toBe("/api/v1/projects/abcdefghij");
      expect(projectDetailResponse.parse(result)).toEqual(result);
      expect(result.project.name).toBe("示例项目");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe("loadProjectOrFail", () => {
  it("项目找不到（带错误信封的 404）时补一条提示，指向仓库配置文件", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "项目不存在" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new ApiClient({ server: `http://127.0.0.1:${port}`, fetch });
      const err = await captureError(loadProjectOrFail(client, "zzzzzzzzzz"));
      expect(err.exitCode).toBe(EXIT.DATA);
      expect(err.hint).toContain(".kanban-hub/config.yaml");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

function makeBoard(): Board {
  return {
    containers: [
      { id: "0000000001", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", kind: "misc", code: "misc", title: "杂项", order: 0, targetVersion: null, targetDate: null, manualStatus: null, manualReason: null },
      { id: "0000000002", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", kind: "phase", code: "M1", title: "阶段一", order: 1, targetVersion: null, targetDate: null, manualStatus: null, manualReason: null },
    ],
    tasks: [
      {
        id: "1111111111",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        containerId: "0000000002",
        code: "1.1",
        title: "任务一",
        order: 0,
        status: "todo",
        suspendReason: null,
        human: null,
        group: null,
        assigneeUserId: null,
        note: "",
        docRefs: [],
        checklist: [],
        dueDate: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  };
}

describe("resolveContainerOrFail", () => {
  it("写法不合法时抛 CliError(2)", () => {
    const board = makeBoard();
    expect(() => resolveContainerOrFail(board, "")).toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE }),
    );
  });

  it("找不到时抛 CliError(5)", () => {
    const board = makeBoard();
    expect(() => resolveContainerOrFail(board, "ZZ")).toThrowError(expect.objectContaining({ exitCode: EXIT.DATA }));
  });

  it("找到时返回容器对象", () => {
    const board = makeBoard();
    const container = resolveContainerOrFail(board, "M1");
    expect(container.id).toBe("0000000002");
  });
});

describe("resolveTaskOrFail", () => {
  it("写法不合法时抛 CliError(2)", () => {
    const board = makeBoard();
    expect(() => resolveTaskOrFail(board, "#ab")).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("找不到时抛 CliError(5)", () => {
    const board = makeBoard();
    expect(() => resolveTaskOrFail(board, "#zzzz")).toThrowError(expect.objectContaining({ exitCode: EXIT.DATA }));
  });

  it("找到时返回任务对象", () => {
    const board = makeBoard();
    const task = resolveTaskOrFail(board, "M1/1.1");
    expect(task.id).toBe("1111111111");
  });
});

describe("shortRef", () => {
  it("返回带 # 前缀的最短唯一前缀", () => {
    const board = makeBoard();
    expect(shortRef(board, "1111111111")).toBe("#1111");
  });
});

describe("afterReport", () => {
  it("成功写入上报时间戳", async () => {
    const home = await tmpDir("kh-shared-home-");
    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => new Date("2026-02-02T00:00:00.000Z") });
    await afterReport(ctx, "abcdefghij");
    const raw = await fs.readFile(path.join(home, "cache", "reports", "abcdefghij.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ lastReportAt: "2026-02-02T00:00:00.000Z" });
  });

  it("写入失败时忽略异常，不抛出，也确实没有写出上报文件", async () => {
    const home = await tmpDir("kh-shared-home-");
    // 制造一个真实的写入失败场景：cache 本该是目录，这里让它是一个普通文件，
    // recordReport 内部 mkdir(cache/reports, { recursive: true }) 会因为 ENOTDIR 失败
    await fs.writeFile(path.join(home, "cache"), "占位文件，不是目录");
    const ctx = fakeContext({ env: { KH_HOME: home } });

    await expect(afterReport(ctx, "abcdefghij")).resolves.toBeUndefined();
    await expect(fs.stat(path.join(home, "cache", "reports", "abcdefghij.json"))).rejects.toThrow();
  });
});

describe("parseEnumOption", () => {
  const values = ["a", "b"] as const;
  const labels: Record<(typeof values)[number], string> = { a: "甲", b: "乙" };

  it("取值合法时原样返回", () => {
    expect(parseEnumOption("a", values, labels)).toBe("a");
  });

  it("取值不合法时抛 CliError(2)，提示列出全部可选值及中文名", () => {
    const err = (() => {
      try {
        parseEnumOption("c", values, labels);
      } catch (e) {
        return e as CliError;
      }
      throw new Error("应该抛出");
    })();
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("a（甲）");
    expect(err.hint).toContain("b（乙）");
  });
});

describe("parseNullableOption", () => {
  it("undefined 原样返回 undefined（不改动字段）", () => {
    expect(parseNullableOption(undefined)).toBeUndefined();
  });

  it("空串转成 null（清空字段）", () => {
    expect(parseNullableOption("")).toBeNull();
  });

  it("非空字符串原样返回", () => {
    expect(parseNullableOption("v1.0")).toBe("v1.0");
  });
});

describe("parseNullableDateOption", () => {
  it("undefined 原样返回 undefined", () => {
    expect(parseNullableDateOption(undefined)).toBeUndefined();
  });

  it("空串转成 null", () => {
    expect(parseNullableDateOption("")).toBeNull();
  });

  it("合法日期原样返回", () => {
    expect(parseNullableDateOption("2026-09-25")).toBe("2026-09-25");
  });

  it("格式不对时抛 CliError(2)", () => {
    const err = (() => {
      try {
        parseNullableDateOption("2026/09/25");
      } catch (e) {
        return e as CliError;
      }
      throw new Error("应该抛出");
    })();
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("displayEmpty", () => {
  it("null 显示成（无）", () => {
    expect(displayEmpty(null)).toBe("（无）");
  });

  it("undefined 显示成（无）", () => {
    expect(displayEmpty(undefined)).toBe("（无）");
  });

  it("空字符串显示成（无）", () => {
    expect(displayEmpty("")).toBe("（无）");
  });

  it("非空字符串原样返回", () => {
    expect(displayEmpty("v1.0")).toBe("v1.0");
  });
});

describe("containerRefLabel", () => {
  const all = [{ id: "aaaa000001" }, { id: "bbbb000002" }];

  it("有编号用编号", () => {
    expect(containerRefLabel({ id: "aaaa000001", kind: "phase", code: "M1" }, all)).toBe("M1");
  });

  it("杂项容器固定显示 misc（即便自己有 code）", () => {
    expect(containerRefLabel({ id: "aaaa000001", kind: "misc", code: "misc" }, all)).toBe("misc");
    expect(containerRefLabel({ id: "aaaa000001", kind: "misc", code: null }, all)).toBe("misc");
  });

  it("非杂项容器没有编号时用整个看板范围内的最短唯一 ID 前缀，可以直接拿来引用", () => {
    const label = containerRefLabel({ id: "aaaa000001", kind: "phase", code: null }, all);
    expect(label).toBe("aaaa");
  });
});

describe("assertAnyOptionGiven", () => {
  it("全部为 false 时抛 CliError(2)", () => {
    const err = (() => {
      try {
        assertAnyOptionGiven([false, false]);
      } catch (e) {
        return e as CliError;
      }
      throw new Error("应该抛出");
    })();
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("至少一个为 true 时不抛", () => {
    expect(() => assertAnyOptionGiven([false, true])).not.toThrow();
  });
});

describe("formatChange", () => {
  it("拼成“标签 改前 → 改后”", () => {
    expect(formatChange("状态", "进行中", "复核中")).toBe("状态 进行中 → 复核中");
  });
});

describe("withAgentOption", () => {
  it("给命令加上 --agent <名称> 选项", () => {
    const cmd = withAgentOption(new Command("x").exitOverride());
    cmd.parse(["--agent", "claude-code"], { from: "user" });
    expect((cmd.opts() as { agent?: string }).agent).toBe("claude-code");
  });
});

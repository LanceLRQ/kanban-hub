import fs from "node:fs/promises";
import path from "node:path";
import { fixtureId } from "@kanban-hub/core/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../errors";
import { cleanupDir, makeTempDir } from "./test-helpers";
import {
  formatByteSize,
  parseByteSize,
  readRepoConfig,
  repoConfigSchema,
  toSyncScope,
  writeRepoConfig,
  type RepoConfig,
} from "./config";

describe("parseByteSize", () => {
  it.each([
    ["5MB", 5 * 1024 * 1024],
    ["500kb", 500 * 1024],
    ["1024", 1024],
    [1024, 1024],
  ])("接受 %s", (input, expected) => {
    expect(parseByteSize(input)).toBe(expected);
  });

  it.each([
    ["21MB", "超过 20MB"],
    ["5GB", "单位不认识"],
    ["-1024", "负数"],
  ])("拒绝 %s（%s）", (input) => {
    expect(() => parseByteSize(input)).toThrowError(expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }));
  });

  it("拒绝负数（数字形式）", () => {
    expect(() => parseByteSize(-1024)).toThrowError(expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }));
  });
});

describe("formatByteSize", () => {
  it("整数 MB 格式化成 <n>MB", () => {
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5MB");
  });

  it("整数 KB 格式化成 <n>KB", () => {
    expect(formatByteSize(500 * 1024)).toBe("500KB");
  });

  it("不能整除时格式化成字节数", () => {
    expect(formatByteSize(1500)).toBe("1500B");
  });
});

describe("repoConfigSchema", () => {
  it("忽略未知字段", () => {
    const result = repoConfigSchema.safeParse({
      projectId: fixtureId("p", 1),
      sync: { include: ["docs/**"], 不认识的字段: 1 },
      不认识的顶层字段: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("不认识的顶层字段");
    if (result.success) {
      expect(result.data.sync).not.toHaveProperty("不认识的字段");
    }
  });

  it("sync.exclude 和 pull.auto 有默认值", () => {
    const result = repoConfigSchema.parse({ projectId: fixtureId("p", 1), sync: { include: [] } });
    expect(result.sync.exclude).toEqual([]);
    expect(result.pull.auto).toBe(true);
  });
});

describe("readRepoConfig / writeRepoConfig", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) await cleanupDir(dir);
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await makeTempDir();
    dirs.push(dir);
    return dir;
  }

  it("没有配置文件时返回 null", async () => {
    const root = await tempDir();
    expect(await readRepoConfig(root)).toBeNull();
  });

  it("读写往返一致", async () => {
    const root = await tempDir();
    const config: RepoConfig = {
      projectId: fixtureId("p", 1),
      sync: { include: ["docs/**", "*.md"], exclude: ["**/*.tmp"], maxFileSize: "10MB" },
      pull: { auto: false },
    };
    await writeRepoConfig(root, config);
    expect(await readRepoConfig(root)).toEqual(config);
  });

  it("写入的文件开头有两行注释，且不影响读回的内容", async () => {
    const root = await tempDir();
    const config: RepoConfig = {
      projectId: fixtureId("p", 2),
      sync: { include: ["docs/**"], exclude: [], maxFileSize: 1024 },
      pull: { auto: true },
    };
    await writeRepoConfig(root, config);

    const raw = await fs.readFile(path.join(root, ".kanban-hub", "config.yaml"), "utf8");
    const lines = raw.split("\n");
    expect(lines[0]?.startsWith("#")).toBe(true);
    expect(lines[1]?.startsWith("#")).toBe(true);

    expect(await readRepoConfig(root)).toEqual(config);
  });

  it("创建 .kanban-hub 目录", async () => {
    const root = await tempDir();
    const config: RepoConfig = {
      projectId: fixtureId("p", 3),
      sync: { include: [], exclude: [], maxFileSize: 1024 },
      pull: { auto: true },
    };
    await writeRepoConfig(root, config);
    const stat = await fs.stat(path.join(root, ".kanban-hub"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("配置文件损坏（不是合法 YAML）时抛用法错误", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".kanban-hub"), { recursive: true });
    await fs.writeFile(path.join(root, ".kanban-hub", "config.yaml"), "not: [valid: yaml", "utf8");
    await expect(readRepoConfig(root)).rejects.toMatchObject({ name: "CliError", exitCode: EXIT.USAGE });
  });

  it("配置文件内容不符合 schema 时抛用法错误", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".kanban-hub"), { recursive: true });
    await fs.writeFile(path.join(root, ".kanban-hub", "config.yaml"), "projectId: 太短了\n", "utf8");
    await expect(readRepoConfig(root)).rejects.toMatchObject({ name: "CliError", exitCode: EXIT.USAGE });
  });

  it("写入前按 schema 校验，maxFileSize 超限时拒绝写入", async () => {
    const root = await tempDir();
    const config = {
      projectId: fixtureId("p", 4),
      sync: { include: [], exclude: [], maxFileSize: "21MB" },
      pull: { auto: true },
    } as unknown as RepoConfig;
    await expect(writeRepoConfig(root, config)).rejects.toThrow();
    expect(await readRepoConfig(root)).toBeNull();
  });
});

describe("toSyncScope", () => {
  it("把 maxFileSize 换算成字节", () => {
    const config: RepoConfig = {
      projectId: fixtureId("p", 5),
      sync: { include: ["docs/**"], exclude: ["**/*.tmp"], maxFileSize: "5MB" },
      pull: { auto: true },
    };
    expect(toSyncScope(config)).toEqual({
      include: ["docs/**"],
      exclude: ["**/*.tmp"],
      maxFileSize: 5 * 1024 * 1024,
    });
  });
});

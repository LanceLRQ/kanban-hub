import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { measureStorageUsage } from "./usage";

let dir: string;

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 建一个指定大小的文件（内容长度即字节数），父目录不存在时一并创建 */
async function put(rel: string, size: number): Promise<void> {
  const target = path.join(dir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "x".repeat(size));
}

describe("measureStorageUsage", () => {
  it("按数据目录的布局分项：看板与事件、文档快照与清单、凭据、git、其他", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-usage-"));
    await put("projects/p1/project.yaml", 100);
    await put("projects/p1/board.yaml", 200);
    await put("projects/p1/events/2026-10.jsonl", 300);
    await put("projects/p1/manifests/m1.json", 50);
    await put("projects/p1/snapshots/m1/docs/a.md", 1000);
    await put("projects/p1/snapshots/m1/docs/deep/b.md", 2000);
    await put("auth/users.yaml", 40);
    await put(".git/objects/ab", 5000);
    await put(".gitignore", 60);
    await put(".staging/abc/meta.json", 10);

    const usage = await measureStorageUsage(dir);

    expect(usage.board).toEqual({ bytes: 600, files: 3 });
    expect(usage.docs).toEqual({ bytes: 3050, files: 3 });
    expect(usage.auth).toEqual({ bytes: 40, files: 1 });
    expect(usage.git).toEqual({ bytes: 5000, files: 1 });
    expect(usage.other).toEqual({ bytes: 70, files: 2 });
    expect(usage.projects).toEqual([{ projectId: "p1", board: { bytes: 600, files: 3 }, docs: { bytes: 3050, files: 3 } }]);
  });

  it("各项目小计按合计降序，同大小时按项目 ID，不把 git 与凭据算进任何项目", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-usage-"));
    await put("projects/pb/board.yaml", 100);
    await put("projects/pa/board.yaml", 300);
    await put("projects/pc/board.yaml", 300);
    await put("projects/pa/snapshots/m1/x.md", 5);
    await put("auth/users.yaml", 999);
    await put(".git/HEAD", 999);

    const usage = await measureStorageUsage(dir);

    expect(usage.projects.map((p) => p.projectId)).toEqual(["pa", "pc", "pb"]);
    expect(usage.projects.map((p) => p.board.bytes)).toEqual([300, 300, 100]);
    expect(usage.projects.map((p) => p.docs.bytes)).toEqual([5, 0, 0]);
  });

  it("空目录全是零，项目列表为空", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-usage-"));
    const usage = await measureStorageUsage(dir);
    expect(usage.board).toEqual({ bytes: 0, files: 0 });
    expect(usage.docs).toEqual({ bytes: 0, files: 0 });
    expect(usage.auth).toEqual({ bytes: 0, files: 0 });
    expect(usage.git).toEqual({ bytes: 0, files: 0 });
    expect(usage.other).toEqual({ bytes: 0, files: 0 });
    expect(usage.projects).toEqual([]);
  });

  it("目录不存在时返回全零而不是抛错", async () => {
    dir = path.join(os.tmpdir(), "kh-usage-不存在");
    const usage = await measureStorageUsage(dir);
    expect(usage.board).toEqual({ bytes: 0, files: 0 });
    expect(usage.projects).toEqual([]);
  });

  it("软链接不计入任何分项", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-usage-"));
    await put("projects/p1/board.yaml", 100);
    await fs.symlink("board.yaml", path.join(dir, "projects/p1/link.yaml"));
    await fs.symlink("projects/p1", path.join(dir, "projects/p1-link"));

    const usage = await measureStorageUsage(dir);

    expect(usage.board).toEqual({ bytes: 100, files: 1 });
    expect(usage.projects).toEqual([{ projectId: "p1", board: { bytes: 100, files: 1 }, docs: { bytes: 0, files: 0 } }]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { SyncManifestInput } from "@kanban-hub/core/api";
import type { Actor } from "@kanban-hub/core/schema";
import type { IncomingFile } from "@kanban-hub/core/sync";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { buildDocsView } from "./docs";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function incoming(p: string, content: string): IncomingFile {
  const bytes = Buffer.from(content);
  return { path: p, sha256: sha(content), size: bytes.length, mtime: 1_700_000_000_000, base: null };
}

const SCOPE = { include: ["docs/**", "*.md"], exclude: [], maxFileSize: 1024 * 1024 };
const GIT_STATE = {
  branch: "main",
  head: "a".repeat(40),
  headSubject: "初始",
  headAt: "2026-09-23T09:00:00.000Z",
  dirtyCount: 0,
  ahead: null,
  behind: null,
};

function manifestInput(files: IncomingFile[]): SyncManifestInput {
  return { files, git: GIT_STATE, skipped: [], scope: SCOPE };
}

async function machineActor(api: TestApi, name: string): Promise<Actor> {
  const { machine } = await api.pairMachine(name);
  const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
  return { userId: admin.id, machineId: machine.id, via: "cli", agent: null };
}

async function addMachine(api: TestApi, projectId: string, name: string): Promise<Actor> {
  const actor = await machineActor(api, name);
  await api.store.setLocation(projectId, actor.machineId!, { path: `/${name}` }, actor);
  return actor;
}

async function sync(api: TestApi, projectId: string, actor: Actor, contents: Record<string, string>): Promise<void> {
  const files = Object.entries(contents).map(([p, c]) => incoming(p, c));
  const begun = await api.store.beginSync(projectId, actor.machineId!, manifestInput(files));
  const byHash = new Map(Object.entries(contents).map(([, c]) => [sha(c), c]));
  for (const hash of begun.missing) await api.store.putSyncBlob(projectId, actor.machineId!, hash, Buffer.from(byHash.get(hash)!));
  await api.store.commitSync(projectId, actor.machineId!, begun.syncId, actor);
}

describe("buildDocsView", () => {
  it("项目不存在时返回 null", async () => {
    api = await setupTestApi();
    const view = await buildDocsView(api.services, "no-such-project", {}, new Date());
    expect(view).toBeNull();
  });

  it("没有机器同步过时给出 emptyReason，machines/tree/recent 为空、file 为 null", async () => {
    api = await setupTestApi();
    const owner = await machineActor(api, "owner");
    const { project } = await api.store.createProject({ name: "看板" }, owner);
    await api.store.setLocation(project.id, owner.machineId!, { path: "/repo" }, owner);

    const view = await buildDocsView(api.services, project.id, {}, new Date());
    expect(view).not.toBeNull();
    expect(view!.emptyReason).toBe("no-sync");
    expect(view!.machines).toEqual([]);
    expect(view!.tree).toEqual([]);
    expect(view!.recent).toEqual([]);
    expect(view!.file).toBeNull();
    expect(view!.rawToken).toBeNull();
  });

  it("默认选中最近同步的机器，?m 能切换；根目录 README.md 是默认文件", async () => {
    api = await setupTestApi();
    const owner = await machineActor(api, "owner");
    const { project } = await api.store.createProject({ name: "看板" }, owner);

    const mac = await addMachine(api, project.id, "mac");
    await sync(api, project.id, mac, { "README.md": "# 首页", "docs/a.md": "内容 A" });

    const mbp = await addMachine(api, project.id, "mbp");
    await sync(api, project.id, mbp, { "docs/b.md": "内容 B" });

    const view1 = await buildDocsView(api.services, project.id, {}, new Date());
    expect(view1!.emptyReason).toBeNull();
    expect(view1!.machines.find((m) => m.selected)?.id).toBe(mbp.machineId); // mbp 后同步，lastSyncAt 更新
    expect(view1!.file?.path).toBe("docs/b.md");
    expect(view1!.rawToken).not.toBeNull();

    const view2 = await buildDocsView(api.services, project.id, { machineId: mac.machineId! }, new Date());
    expect(view2!.machines.find((m) => m.selected)?.id).toBe(mac.machineId);
    expect(view2!.file?.path).toBe("README.md");
  });

  it("最近更新按 changedAt 倒序", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api, "solo");
    const { project } = await api.store.createProject({ name: "P" }, actor);
    await api.store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await sync(api, project.id, actor, { "a.md": "1" });
    await sync(api, project.id, actor, { "a.md": "1", "b.md": "2" });

    const view = await buildDocsView(api.services, project.id, {}, new Date());
    // b.md 是这次新增的，changedAt 是本次提交时间；a.md 内容没变，changedAt 沿用第一次同步时的值，排在后面
    expect(view!.recent.map((r) => r.path)).toEqual(["b.md", "a.md"]);
  });

  it("文件不在该机器快照里时，file 为不存在状态，不抛错", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api, "solo");
    const { project } = await api.store.createProject({ name: "P" }, actor);
    await api.store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await sync(api, project.id, actor, { "a.md": "1" });

    const view = await buildDocsView(api.services, project.id, { path: "missing.md" }, new Date());
    expect(view!.file).toMatchObject({ path: "missing.md", exists: false });
  });

  it("都没有 README 时退回第一个 .md 文件（按路径排序）", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api, "solo");
    const { project } = await api.store.createProject({ name: "P" }, actor);
    await api.store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await sync(api, project.id, actor, { "z.md": "z", "a.md": "a" });

    const view = await buildDocsView(api.services, project.id, {}, new Date());
    expect(view!.file?.path).toBe("a.md");
  });

  it("扩展名认不出、内容是文本时（如 LICENSE），嗅探后按其他文本显示", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api, "solo");
    const { project } = await api.store.createProject({ name: "P" }, actor);
    await api.store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await sync(api, project.id, actor, { LICENSE: "MIT License\n\nCopyright ...\n" });

    const view = await buildDocsView(api.services, project.id, { path: "LICENSE" }, new Date());
    expect(view!.file).toMatchObject({ path: "LICENSE", exists: true, kind: "text" });
    expect(view!.file?.content).toContain("MIT License");
  });

  it("扩展名认不出、内容是二进制时，仍然按 binary 显示，不读出内容", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api, "solo");
    const { project } = await api.store.createProject({ name: "P" }, actor);
    await api.store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await sync(api, project.id, actor, { compiled: "\0binary\0content" });

    const view = await buildDocsView(api.services, project.id, { path: "compiled" }, new Date());
    expect(view!.file).toMatchObject({ path: "compiled", exists: true, kind: "binary", content: null });
  });
});

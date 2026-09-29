import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { Actor, Board, Event, Project } from "@kanban-hub/core/schema";
import { normalizeBoardForCompare } from "@kanban-hub/core/test-fixtures";
import { transferDocSchema, type TransferDoc } from "@kanban-hub/core/transfer";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

async function machineActor(api: TestApi): Promise<{ token: string; actor: Actor }> {
  const { machine, token } = await api.pairMachine();
  return { token, actor: { userId: machine.userId, machineId: machine.id, via: "cli", agent: null } };
}

/** 一个有阶段、特性、杂项任务和历史日志的项目 */
async function seededProject(api: TestApi, actor: Actor, name = "看板"): Promise<Project> {
  const { project } = await api.store.createProject({ name }, actor);
  const doc: TransferDoc = {
    format: "kanban-hub/v1",
    project: { cycle: "iteration", health: "at_risk", focus: "迁移" },
    containers: [
      {
        kind: "phase",
        code: "P0",
        title: "工程骨架",
        targetVersion: "v1.0",
        tasks: [
          { code: "0.1", title: "初始化仓库", status: "done", startedAt: "2026-01-02T10:00:00+08:00", completedAt: "2026-01-05T18:00:00+08:00" },
          { code: "0.2", title: "挂起的任务", status: "suspended", suspendReason: "等上游" },
          { title: "取消的任务", status: "cancelled", group: "M2" },
        ],
      },
      {
        kind: "feature",
        title: "导出",
        manualStatus: "backlog",
        tasks: [
          {
            title: "Markdown",
            status: "in_progress",
            human: { kind: "decision", note: "选格式" },
            checklist: [{ text: "表格", done: true }, { text: "列表", done: false }],
            dueDate: "2026-10-01",
            note: "备注",
            docRefs: ["docs/a.md"],
          },
        ],
      },
      { kind: "misc", tasks: [{ title: "整理笔记" }] },
    ],
    events: [
      { ts: "2026-01-05T18:00:00+08:00", text: "完成工程骨架" },
      { ts: "2025-06-01T00:00:00Z", text: "很早以前" },
    ],
  };
  await api.store.applyImport(project.id, doc, actor, { dryRun: false });
  await api.store.appendLog(project.id, { text: "今天的日志" }, actor);
  return project;
}

function exportUrl(id: string, query: string): string {
  return `/api/v1/projects/${id}/export?${query}`;
}

describe("GET /api/v1/projects/:id/export", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("YAML：导入导出同一种格式，含全部容器、任务和按时间升序的全部日志（含内存窗口之外的）", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const project = await seededProject(api, actor);

    const res = await GET(api.request(exportUrl(project.id, "format=yaml"), { token }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBeNull();
    const doc = transferDocSchema.parse(parse(await res.text()));
    expect(doc.project).toEqual({ cycle: "iteration", health: "at_risk", focus: "迁移" });
    expect(doc.containers.map((c) => c.kind)).toEqual(["misc", "phase", "feature"]);
    expect(doc.events?.map((e) => e.text)).toEqual(["很早以前", "完成工程骨架", "今天的日志"]);
  });

  it("导出的 YAML 导回同一个项目：摘要全部为空", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const project = await seededProject(api, actor);
    const res = await GET(api.request(exportUrl(project.id, "format=yaml"), { token }), api.ctx({ id: project.id }));
    const doc = transferDocSchema.parse(parse(await res.text()));

    const summary = await api.store.applyImport(project.id, doc, actor, { dryRun: false });
    expect(summary).toEqual({
      dryRun: false,
      project: [],
      containers: { created: [], updated: [] },
      tasks: { created: [], updated: [], statusChanges: [] },
      events: { added: 0, duplicates: 3 },
    });
  });

  it("导出的 YAML 导进另一个新项目：两边看板等价", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const project = await seededProject(api, actor);
    const res = await GET(api.request(exportUrl(project.id, "format=yaml"), { token }), api.ctx({ id: project.id }));
    const doc = transferDocSchema.parse(parse(await res.text()));

    const { project: other } = await api.store.createProject({ name: "另一个" }, actor);
    await api.store.applyImport(other.id, doc, actor, { dryRun: false });
    expect(normalizeBoardForCompare(api.store.getBoard(other.id) as Board)).toEqual(
      normalizeBoardForCompare(api.store.getBoard(project.id) as Board),
    );
    expect(api.store.getProject(other.id)).toMatchObject({ cycle: "iteration", health: "at_risk", focus: "迁移" });
    const logs = await api.store.readProjectLogs(other.id);
    expect(logs.map((e: Event) => e.text)).toEqual(["很早以前", "完成工程骨架", "今天的日志"]);
  });

  it("Markdown：Content-Type 与主要内容", async () => {
    api = await setupTestApi();
    const { actor } = await machineActor(api);
    const project = await seededProject(api, actor, "迁移样例");

    const res = await GET(api.request(exportUrl(project.id, "format=md"), { cookie: api.sessionCookie() }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# 迁移样例");
    expect(text).toContain("迭代期");
    expect(text).toContain("P0 工程骨架");
    expect(text).toContain("~~取消的任务~~");
    expect(text).toContain("待你处理：选格式");
    expect(text).toContain("清单 1/2");
  });

  it("download=1：中文项目名给出 UTF-8 文件名与只含安全字符的 ASCII 兜底", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const { project } = await api.store.createProject({ name: "看板 v2" }, actor);

    const yamlRes = await GET(api.request(exportUrl(project.id, "format=yaml&download=1"), { token }), api.ctx({ id: project.id }));
    expect(yamlRes.status).toBe(200);
    const disposition = yamlRes.headers.get("content-disposition")!;
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("看板 v2-kanban.yaml")}`);
    expect(asciiFallback(disposition)).toBe("___v2-kanban.yaml");

    const mdRes = await GET(api.request(exportUrl(project.id, "format=md&download=1"), { token }), api.ctx({ id: project.id }));
    expect(mdRes.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("看板 v2-kanban.md")}`);
  });

  it("download=1：项目名含引号、换行、斜杠时响应照常构造，文件名不带出这些字符", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const { project } = await api.store.createProject({ name: `a"b\nc/d\\e'(f)*` }, actor);

    const res = await GET(api.request(exportUrl(project.id, "format=yaml&download=1"), { token }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition")!;
    expect(asciiFallback(disposition)).toMatch(/^[A-Za-z0-9._-]+$/);
    const encoded = /filename\*=UTF-8''(\S+)/.exec(disposition)![1]!;
    // RFC 5987 的 attr-char：字母数字与 !#$&+-.^_`|~，其余都要百分号编码
    expect(encoded).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(encoded)).toBe(`a"b\nc/d\\e'(f)*-kanban.yaml`);

    // 孤立的代理项也不能让构造响应头出错
    const { project: odd } = await api.store.createProject({ name: "x\uD800y" }, actor);
    const oddRes = await GET(api.request(exportUrl(odd.id, "format=md&download=1"), { token }), api.ctx({ id: odd.id }));
    expect(oddRes.status).toBe(200);
    expect(asciiFallback(oddRes.headers.get("content-disposition")!)).toBe("x_y-kanban.md");
  });

  it("format 缺失或不认识时返回 400", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const { project } = await api.store.createProject({ name: "看板" }, actor);
    for (const query of ["", "format=json"]) {
      const res = await GET(api.request(exportUrl(project.id, query), { token }), api.ctx({ id: project.id }));
      expect(res.status).toBe(400);
    }
  });

  it("项目不存在时返回 404，未登录时返回 401", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const { project } = await api.store.createProject({ name: "看板" }, actor);
    const missing = await GET(api.request(exportUrl("zzzzzzzzzz", "format=yaml"), { token }), api.ctx({ id: "zzzzzzzzzz" }));
    expect(missing.status).toBe(404);
    const anonymous = await GET(api.request(exportUrl(project.id, "format=yaml")), api.ctx({ id: project.id }));
    expect(anonymous.status).toBe(401);
  });

  it("历史日志在内存窗口之外的项目，导出也包含它们", async () => {
    api = await setupTestApi();
    const { token, actor } = await machineActor(api);
    const { project } = await api.store.createProject({ name: "看板" }, actor);
    const old: Event = {
      id: "old0000001",
      ts: "2024-03-01T00:00:00.000Z",
      projectId: project.id,
      actor,
      type: "log",
      target: null,
      change: null,
      text: "两年前的日志",
      imported: false,
    };
    const file = path.join(api.store.dataDirectory, "projects", project.id, "events", "2024-03.jsonl");
    await fs.writeFile(file, `${JSON.stringify(old)}\n`);

    const res = await GET(api.request(exportUrl(project.id, "format=yaml"), { token }), api.ctx({ id: project.id }));
    const doc = transferDocSchema.parse(parse(await res.text()));
    expect(doc.events).toEqual([{ ts: "2024-03-01T00:00:00.000Z", text: "两年前的日志" }]);
  });
});

/** Content-Disposition 里 ASCII 兜底的 filename="…" 的值 */
function asciiFallback(disposition: string): string {
  return /filename="([^"]*)"/.exec(disposition)![1]!;
}

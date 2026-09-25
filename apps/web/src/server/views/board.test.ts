import { afterEach, describe, expect, it } from "vitest";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { PATCH as patchProject } from "@/app/api/v1/projects/[id]/route";
import { PATCH as patchContainer } from "@/app/api/v1/projects/[id]/containers/[cid]/route";
import { PATCH as patchTask } from "@/app/api/v1/projects/[id]/tasks/[tid]/route";
import { buildBoardView } from "./board";

const NOW = new Date("2026-09-24T04:00:00.000Z");
const TZ = "Asia/Shanghai";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

function webActor(api: TestApi): Actor {
  const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
  return { userId: admin.id, machineId: null, via: "web", agent: null };
}

async function seed(api: TestApi) {
  const actor = webActor(api);
  const { project } = await api.store.createProject({ name: "kanban-hub" }, actor);
  const m2 = await api.store.createContainer(project.id, { kind: "phase", code: "M2", title: "API 与鉴权", order: 2, targetVersion: "v0.2" }, actor);
  const m1 = await api.store.createContainer(project.id, { kind: "phase", code: "M1", title: "工程骨架", order: 1 }, actor);
  const pool = await api.store.createContainer(project.id, { kind: "feature", title: "储备池", manualStatus: "backlog" }, actor);
  const done = await api.store.createTask(project.id, { containerId: m1.id, title: "骨架", status: "done" }, actor);
  const doing = await api.store.createTask(
    project.id,
    { containerId: m2.id, title: "字段命名", status: "in_progress", checklist: [{ text: "a", done: true }, { text: "b", done: false }] },
    actor,
  );
  const todo = await api.store.createTask(project.id, { containerId: m2.id, title: "SSE", dueDate: "2026-09-28" }, actor);
  return { project, m1, m2, pool, done, doing, todo };
}

describe("buildBoardView", () => {
  it("项目不存在时返回 null", async () => {
    api = await setupTestApi();
    expect(buildBoardView(api.services, "no-such-project", NOW, TZ)).toBeNull();
  });

  it("分区顺序：阶段按 order → 储备 → 杂项；已完成的容器默认折叠", async () => {
    api = await setupTestApi();
    const { project, m1, m2, pool } = await seed(api);
    const view = buildBoardView(api.services, project.id, NOW, TZ)!;

    expect(view.projectId).toBe(project.id);
    expect(view.sections.map((s) => s.container.id).slice(0, 3)).toEqual([m1.id, m2.id, pool.id]);
    expect(view.sections.at(-1)!.container.kind).toBe("misc");
    expect(view.sections[0]!.collapsed).toBe(true);
    expect(view.sections[0]!.status).toBe("done");
    expect(view.sections[0]!.completedDate).not.toBeNull();
    expect(view.sections[1]!).toMatchObject({ collapsed: false, status: "in_progress", taskCount: 2, cancelledCount: 0 });
    expect(view.sections[1]!.container).toMatchObject({ code: "M2", label: "M2", title: "API 与鉴权", targetVersion: "v0.2", version: m2.version });
    expect(view.sections[2]!.status).toBe("backlog");
  });

  it("任务带上最短唯一前缀的 ref、version、编辑所需字段、清单完成度和右侧信息", async () => {
    api = await setupTestApi();
    const { project, doing, todo, done } = await seed(api);
    const view = buildBoardView(api.services, project.id, NOW, TZ)!;
    const tasks = view.sections.flatMap((s) => s.tasks);
    const prefixes = shortIdPrefixes([done.id, doing.id, todo.id]);

    const row = tasks.find((x) => x.id === doing.id)!;
    expect(row.ref).toBe(`#${prefixes.get(doing.id)}`);
    expect(doing.id.startsWith(row.ref.slice(1))).toBe(true);
    expect(row).toMatchObject({
      version: doing.version,
      containerId: doing.containerId,
      title: "字段命名",
      status: "in_progress",
      suspendReason: null,
      human: null,
      group: null,
      code: null,
      note: "",
      docRefs: [],
      dueDate: null,
      checklist: [
        { text: "a", done: true },
        { text: "b", done: false },
      ],
      checklistProgress: { done: 1, total: 2 },
    });
    // 夹具的存储用真实时钟写 startedAt，这里按“此刻”构建才能断言“开始于今天”
    const live = buildBoardView(api.services, project.id, api.services.now(), TZ)!;
    expect(live.sections.flatMap((s) => s.tasks).find((x) => x.id === doing.id)!.meta.main?.kind).toBe("startedToday");

    const due = tasks.find((x) => x.id === todo.id)!;
    expect(due.meta.main).toEqual({ kind: "due", date: "9 月 28 日" });
  });

  it("任务更新后，视图里的 version 跟着变", async () => {
    api = await setupTestApi();
    const { project, todo } = await seed(api);
    const updated = await api.store.updateTask(project.id, todo.id, { title: "SSE 推送" }, webActor(api));
    const view = buildBoardView(api.services, project.id, NOW, TZ)!;
    const row = view.sections.flatMap((s) => s.tasks).find((x) => x.id === todo.id)!;
    expect(updated.version).toBeGreaterThan(todo.version);
    expect(row.version).toBe(updated.version);
    expect(row.title).toBe("SSE 推送");
  });

  it("“所属容器”下拉列出本项目全部容器，顺序与分区一致", async () => {
    api = await setupTestApi();
    const { project, m1, m2, pool } = await seed(api);
    const view = buildBoardView(api.services, project.id, NOW, TZ)!;
    expect(view.containerOptions.map((o) => o.id)).toEqual(view.sections.map((s) => s.container.id));
    expect(view.containerOptions.slice(0, 3)).toEqual([
      { id: m1.id, label: "M1", title: "工程骨架", kind: "phase" },
      { id: m2.id, label: "M2", title: "API 与鉴权", kind: "phase" },
      { id: pool.id, label: expect.any(String), title: "储备池", kind: "feature" },
    ]);
    expect(view.containerOptions.at(-1)).toMatchObject({ label: "misc", kind: "misc" });
  });
});

describe("网页写操作的版本冲突（路由层）", () => {
  it("任务：带着旧 version 保存返回 409，并带上 currentVersion", async () => {
    api = await setupTestApi();
    const { project, todo } = await seed(api);
    // 另一处（例如 kh）先改了一次
    const newer = await api.store.updateTask(project.id, todo.id, { title: "别处改过" }, webActor(api));

    const res = await patchTask(
      api.request(`/api/v1/projects/${project.id}/tasks/${todo.id}`, {
        method: "PATCH",
        json: { title: "网页上的草稿", version: todo.version },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: todo.id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: { currentVersion: number } } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.currentVersion).toBe(newer.version);
    expect(api.store.getBoard(project.id)!.tasks.find((x) => x.id === todo.id)!.title).toBe("别处改过");
  });

  it("任务：带着当前 version 保存成功，事件记为 via: web", async () => {
    api = await setupTestApi();
    const { project, todo } = await seed(api);
    const res = await patchTask(
      api.request(`/api/v1/projects/${project.id}/tasks/${todo.id}`, {
        method: "PATCH",
        json: { checklist: [{ text: "x", done: false }], version: todo.version },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: todo.id }),
    );
    expect(res.status).toBe(200);
    const events = await api.store.listEvents({ projectId: project.id, limit: 1 });
    expect(events[0]!.actor.via).toBe("web");
  });

  it("容器：带着旧 version 保存返回 409，并带上 currentVersion", async () => {
    api = await setupTestApi();
    const { project, m2 } = await seed(api);
    const newer = await api.store.updateContainer(project.id, m2.id, { title: "别处改过" }, webActor(api));
    const res = await patchContainer(
      api.request(`/api/v1/projects/${project.id}/containers/${m2.id}`, {
        method: "PATCH",
        json: { title: "草稿", version: m2.version },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, cid: m2.id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { currentVersion: number } } };
    expect(body.error.details.currentVersion).toBe(newer.version);
  });

  it("项目：带着旧 version 保存返回 409，并带上 currentVersion", async () => {
    api = await setupTestApi();
    const { project } = await seed(api);
    const newer = await api.store.updateProject(project.id, { focus: "别处改过" }, webActor(api));
    const res = await patchProject(
      api.request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        json: { focus: "草稿", version: project.version },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { currentVersion: number } } };
    expect(body.error.details.currentVersion).toBe(newer.version);
  });
});

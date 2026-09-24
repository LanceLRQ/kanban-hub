import { describe, expect, it } from "vitest";
import { KhError } from "./errors";
import {
  type MutationContext,
  createContainer,
  createLogEvent,
  createProject,
  createTask,
  transitionTask,
  updateContainer,
  updateProject,
  updateTask,
} from "./mutations";
import {
  T0,
  cliActor,
  fixtureId,
  makeBoard,
  makeContainer,
  makeProject,
  makeTask,
  sequentialIds,
  webActor,
} from "./test-fixtures";

const NOW = "2026-09-23T10:00:00.000Z";
const P = fixtureId("p", 1);

function ctx(actor = cliActor): MutationContext {
  return { now: NOW, actor, newId: sequentialIds("n") };
}

function thrown(fn: () => unknown): KhError {
  try {
    fn();
  } catch (e) {
    if (e instanceof KhError) return e;
    throw e;
  }
  throw new Error("预期抛出 KhError");
}

describe("transitionTask", () => {
  const blank = { status: "todo" as const, suspendReason: null, startedAt: null, completedAt: null };

  it("第一次进入进行中时记录开始时间", () => {
    expect(transitionTask(blank, "in_progress", NOW)).toEqual({
      status: "in_progress",
      suspendReason: null,
      startedAt: NOW,
      completedAt: null,
    });
  });

  it("重新打开不覆盖开始时间", () => {
    expect(transitionTask({ ...blank, status: "review", startedAt: T0 }, "in_progress", NOW).startedAt).toBe(T0);
  });

  it("进入已完成时记录完成时间；本来就是已完成时保持不变", () => {
    expect(transitionTask(blank, "done", NOW)).toEqual({ status: "done", suspendReason: null, startedAt: null, completedAt: NOW });
    expect(transitionTask({ ...blank, status: "done", completedAt: T0 }, "done", NOW).completedAt).toBe(T0);
  });

  it("离开已完成时清空完成时间", () => {
    expect(transitionTask({ ...blank, status: "done", completedAt: T0 }, "review", NOW).completedAt).toBeNull();
  });

  it("挂起时用新原因，没给就沿用原来的；离开挂起时清空", () => {
    expect(transitionTask(blank, "suspended", NOW, "等接口").suspendReason).toBe("等接口");
    const suspended = { ...blank, status: "suspended" as const, suspendReason: "等接口" };
    expect(transitionTask(suspended, "suspended", NOW).suspendReason).toBe("等接口");
    expect(transitionTask(suspended, "todo", NOW).suspendReason).toBeNull();
  });
});

describe("createProject", () => {
  it("填上默认值，自动建杂项容器，记一条 project.created", () => {
    const r = createProject({ name: " 看板 " }, ctx());
    expect(r.project).toMatchObject({
      id: "n000000001",
      version: 1,
      createdAt: NOW,
      name: "看板",
      description: "",
      cycle: "development",
      health: "on_track",
      focus: "",
      fingerprint: null,
      locations: [],
    });
    expect(r.board).toEqual({
      containers: [expect.objectContaining({ id: "n000000002", kind: "misc", code: null, title: "杂项", order: 0 })],
      tasks: [],
    });
    expect(r.events).toEqual([
      {
        id: "n000000003",
        ts: NOW,
        projectId: "n000000001",
        actor: cliActor,
        type: "project.created",
        target: null,
        change: null,
        text: "看板",
        imported: false,
      },
    ]);
  });

  it("名称为空时报 invalid，并指出字段", () => {
    const e = thrown(() => createProject({ name: "" }, ctx()));
    expect(e.code).toBe("invalid");
    expect((e.details as { issues: string[] }).issues[0]).toMatch(/^name：/);
  });
});

describe("updateProject", () => {
  it("修改焦点：版本加 1，记录变化", () => {
    const r = updateProject(makeProject(), { focus: "M1 存储" }, ctx());
    expect(r.project).toMatchObject({ version: 2, updatedAt: NOW, focus: "M1 存储" });
    expect(r.events).toMatchObject([{ type: "project.updated", change: { focus: { from: "", to: "M1 存储" } } }]);
  });

  it("值没有变化时原样返回，不产生事件", () => {
    const p = makeProject();
    const r = updateProject(p, { name: p.name, cycle: p.cycle }, ctx());
    expect(r.project).toBe(p);
    expect(r.events).toEqual([]);
  });

  it("网页带的版本号过期时报 conflict", () => {
    expect(thrown(() => updateProject(makeProject({ version: 3 }), { focus: "x" }, ctx(webActor), 2)).code).toBe("conflict");
  });

  it("拒绝未知字段", () => {
    expect(thrown(() => updateProject(makeProject(), { fingerprint: "x" } as never, ctx())).code).toBe("invalid");
  });
});

describe("createContainer", () => {
  it("排在已有容器之后，记一条 container.created", () => {
    const r = createContainer(makeBoard([makeContainer({ order: 5 })]), P, { kind: "feature", title: "搜索", code: "F1" }, ctx());
    expect(r.container).toMatchObject({ id: "n000000001", kind: "feature", code: "F1", order: 6, manualStatus: null });
    expect(r.board.containers).toHaveLength(3);
    expect(r.events).toMatchObject([{ type: "container.created", target: { containerId: "n000000001" }, text: "搜索" }]);
  });

  it("编号与已有容器重复时报 invalid，不区分大小写", () => {
    expect(thrown(() => createContainer(makeBoard(), P, { kind: "phase", title: "x", code: "m1" }, ctx())).code).toBe("invalid");
  });

  it("挂起却没写原因时报 invalid", () => {
    expect(
      thrown(() => createContainer(makeBoard(), P, { kind: "feature", title: "x", manualStatus: "suspended" }, ctx())).code,
    ).toBe("invalid");
  });
});

describe("updateContainer", () => {
  it("改回自动状态时一并清空原因", () => {
    const c = makeContainer({ manualStatus: "suspended", manualReason: "等设计" });
    const r = updateContainer(makeBoard([c]), P, c.id, { manualStatus: null }, ctx());
    expect(r.container).toMatchObject({ manualStatus: null, manualReason: null, version: 2 });
    expect(r.events[0]?.change).toEqual({
      manualStatus: { from: "suspended", to: null },
      manualReason: { from: "等设计", to: null },
    });
  });

  it("杂项容器不能手动设置状态", () => {
    expect(thrown(() => updateContainer(makeBoard(), P, fixtureId("c", 0), { manualStatus: "backlog" }, ctx())).code).toBe(
      "invalid",
    );
  });

  it("容器不存在时报 not_found", () => {
    expect(thrown(() => updateContainer(makeBoard(), P, fixtureId("c", 9), { title: "x" }, ctx())).code).toBe("not_found");
  });
});

describe("createTask", () => {
  it("填上默认值，排在同一容器的任务之后", () => {
    const board = makeBoard([makeContainer()], [makeTask({ order: 3 })]);
    const r = createTask(board, P, { containerId: fixtureId("c", 1), title: "写测试", code: "1.2" }, ctx());
    expect(r.task).toMatchObject({
      id: "n000000001",
      status: "todo",
      order: 4,
      note: "",
      docRefs: [],
      checklist: [],
      startedAt: null,
      completedAt: null,
    });
    expect(r.events).toMatchObject([
      { id: "n000000002", type: "task.created", target: { containerId: fixtureId("c", 1), taskId: "n000000001" }, text: "写测试" },
    ]);
  });

  it("直接建成进行中时记录开始时间", () => {
    const r = createTask(makeBoard(), P, { containerId: fixtureId("c", 1), title: "x", status: "in_progress" }, ctx());
    expect(r.task.startedAt).toBe(NOW);
  });

  it("容器不存在时报 not_found", () => {
    expect(thrown(() => createTask(makeBoard(), P, { containerId: fixtureId("c", 9), title: "x" }, ctx())).code).toBe(
      "not_found",
    );
  });

  it("同一容器里编号重复时报 invalid，不同容器可以重复", () => {
    const board = makeBoard([makeContainer()], [makeTask({ code: "1.1" })]);
    expect(thrown(() => createTask(board, P, { containerId: fixtureId("c", 1), title: "x", code: "1.1" }, ctx())).code).toBe(
      "invalid",
    );
    expect(createTask(board, P, { containerId: fixtureId("c", 0), title: "x", code: "1.1" }, ctx()).task.code).toBe("1.1");
  });

  it("不是挂起状态却写了挂起原因时报 invalid", () => {
    expect(
      thrown(() => createTask(makeBoard(), P, { containerId: fixtureId("c", 1), title: "x", suspendReason: "等" }, ctx())).code,
    ).toBe("invalid");
  });
});

describe("updateTask", () => {
  const T1 = fixtureId("t", 1);
  const boardWith = (task = makeTask()) =>
    makeBoard([makeContainer(), makeContainer({ id: fixtureId("c", 2), code: "M2", order: 2 })], [task]);

  it("开始任务：记录开始时间，产生 task.status_changed", () => {
    const r = updateTask(boardWith(), P, T1, { status: "in_progress" }, ctx());
    expect(r.task).toMatchObject({ status: "in_progress", startedAt: NOW, version: 2, updatedAt: NOW });
    expect(r.events).toMatchObject([
      {
        type: "task.status_changed",
        target: { containerId: fixtureId("c", 1), taskId: T1 },
        change: { status: { from: "todo", to: "in_progress" } },
      },
    ]);
  });

  it("从已完成改回待开始时清空完成时间，保留开始时间", () => {
    const r = updateTask(boardWith(makeTask({ status: "done", startedAt: T0, completedAt: T0 })), P, T1, { status: "todo" }, ctx());
    expect(r.task).toMatchObject({ status: "todo", startedAt: T0, completedAt: null });
  });

  it("挂起必须写原因；离开挂起时原因一并清空，并记入变化", () => {
    expect(thrown(() => updateTask(boardWith(), P, T1, { status: "suspended" }, ctx())).code).toBe("invalid");
    const suspended = makeTask({ status: "suspended", suspendReason: "等接口" });
    const r = updateTask(boardWith(suspended), P, T1, { status: "todo" }, ctx());
    expect(r.events[0]?.change).toEqual({
      status: { from: "suspended", to: "todo" },
      suspendReason: { from: "等接口", to: null },
    });
  });

  it("一次修改状态、待你处理和备注，按顺序产生三条事件", () => {
    const r = updateTask(boardWith(), P, T1, { status: "review", human: { kind: "verify", note: "请验收" }, note: "已提交" }, ctx());
    expect(r.events.map((e) => e.type)).toEqual(["task.status_changed", "task.human_changed", "task.updated"]);
    expect(r.events[2]?.change).toEqual({ note: { from: "", to: "已提交" } });
  });

  it("换到别的容器又没指定顺序时，排到目标容器末尾", () => {
    const r = updateTask(boardWith(), P, T1, { containerId: fixtureId("c", 2) }, ctx());
    expect(r.task).toMatchObject({ containerId: fixtureId("c", 2), order: 0 });
    expect(r.events).toMatchObject([
      {
        type: "task.updated",
        change: { containerId: { from: fixtureId("c", 1), to: fixtureId("c", 2) }, order: { from: 1, to: 0 } },
      },
    ]);
  });

  it("移到不存在的容器时报 not_found", () => {
    expect(thrown(() => updateTask(boardWith(), P, T1, { containerId: fixtureId("c", 9) }, ctx())).code).toBe("not_found");
  });

  it("没有变化时原样返回，不产生事件", () => {
    const board = boardWith();
    const r = updateTask(board, P, T1, { title: "任务" }, ctx());
    expect(r.task).toBe(board.tasks[0]);
    expect(r.events).toEqual([]);
  });

  it("网页带的版本号过期时报 conflict", () => {
    expect(thrown(() => updateTask(boardWith(), P, T1, { title: "x" }, ctx(webActor), 5)).code).toBe("conflict");
  });

  it("任务不存在时报 not_found", () => {
    expect(thrown(() => updateTask(boardWith(), P, fixtureId("t", 9), { title: "x" }, ctx())).code).toBe("not_found");
  });
});

describe("createLogEvent", () => {
  it("关联任务时补上任务所在的容器", () => {
    const e = createLogEvent(makeBoard([makeContainer()], [makeTask()]), P, { text: "完成一批", taskId: fixtureId("t", 1) }, ctx());
    expect(e).toMatchObject({
      type: "log",
      projectId: P,
      text: "完成一批",
      target: { containerId: fixtureId("c", 1), taskId: fixtureId("t", 1) },
    });
  });

  it("不关联时 target 为 null", () => {
    expect(createLogEvent(makeBoard(), P, { text: "日志" }, ctx()).target).toBeNull();
  });

  it("正文为空时报 invalid", () => {
    expect(thrown(() => createLogEvent(makeBoard(), P, { text: " " }, ctx())).code).toBe("invalid");
  });

  it("关联的任务不存在时报 not_found", () => {
    expect(thrown(() => createLogEvent(makeBoard(), P, { text: "x", taskId: fixtureId("t", 9) }, ctx())).code).toBe("not_found");
  });
});

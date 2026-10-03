import { describe, expect, it } from "vitest";
import { KhError } from "./errors";
import {
  type MutationContext,
  createContainer,
  createLogEvent,
  createProject,
  createTask,
  reorderContainers,
  reorderTasks,
  recordLocationSync,
  setLocation,
  transitionTask,
  updateContainer,
  updateProject,
  updateTask,
} from "./mutations";
import {
  MACHINE_ID,
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

describe("setLocation", () => {
  const M = MACHINE_ID;

  it("新登记会产出事件，from 为 null", () => {
    const r = setLocation(makeProject(), M, { path: "/repo" }, ctx());
    expect(r.project.locations).toEqual([{ machineId: M, path: "/repo", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }]);
    expect(r.project.version).toBe(2);
    expect(r.events).toMatchObject([
      { type: "project.updated", change: { location: { from: null, to: { machineId: M, path: "/repo", sync: null } } } },
    ]);
  });

  it("修改 path 会产出事件", () => {
    const project = makeProject({
      locations: [{ machineId: M, path: "/old", lastSyncAt: T0, sync: null, git: null, skippedFiles: [] }],
    });
    const r = setLocation(project, M, { path: "/new" }, ctx());
    expect(r.project.locations[0]).toMatchObject({ path: "/new", lastSyncAt: T0 });
    expect(r.events[0]?.change).toEqual({
      location: { from: { machineId: M, path: "/old", sync: null }, to: { machineId: M, path: "/new", sync: null } },
    });
  });

  it("内容相同时不产出事件，项目的版本不变", () => {
    const project = makeProject({
      locations: [{ machineId: M, path: "/repo", lastSyncAt: T0, sync: null, git: null, skippedFiles: [] }],
    });
    const r = setLocation(project, M, { path: "/repo" }, ctx());
    expect(r.project).toBe(project);
    expect(r.events).toEqual([]);
  });

  it("已有的 git、lastSyncAt、skippedFiles 被保留", () => {
    const git = { branch: "main", head: "a".repeat(40), headSubject: "x", headAt: T0, dirtyCount: 0, ahead: 0, behind: 0 };
    const project = makeProject({
      locations: [{ machineId: M, path: "/old", lastSyncAt: T0, sync: null, git, skippedFiles: [{ path: "a.bin", size: 10 }] }],
    });
    const r = setLocation(project, M, { path: "/new" }, ctx());
    expect(r.project.locations[0]).toMatchObject({ lastSyncAt: T0, git, skippedFiles: [{ path: "a.bin", size: 10 }] });
  });

  it("输入非法（空路径、未知字段）时报 invalid", () => {
    expect(thrown(() => setLocation(makeProject(), M, { path: "" }, ctx())).code).toBe("invalid");
    expect(thrown(() => setLocation(makeProject(), M, { path: "/x", extra: 1 } as never, ctx())).code).toBe("invalid");
  });
});

describe("recordLocationSync", () => {
  const M = MACHINE_ID;
  const git = { branch: "main", head: "a".repeat(40), headSubject: "x", headAt: T0, dirtyCount: 0, ahead: 0, behind: 0 };
  const sync = { include: ["docs/**"], exclude: [], maxFileSize: 1024 };

  it("更新 lastSyncAt、git、sync、skippedFiles，保留 path，version 加 1", () => {
    const project = makeProject({
      locations: [{ machineId: M, path: "/repo", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }],
    });
    const r = recordLocationSync(
      project,
      M,
      { lastSyncAt: NOW, git, sync, skippedFiles: [{ path: "big.bin", size: 999 }] },
      ctx(),
    );
    expect(r.project.locations).toEqual([{ machineId: M, path: "/repo", lastSyncAt: NOW, sync, git, skippedFiles: [{ path: "big.bin", size: 999 }] }]);
    expect(r.project.version).toBe(2);
  });

  it("不产生事件", () => {
    const project = makeProject({ locations: [{ machineId: M, path: "/repo", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }] });
    const r = recordLocationSync(project, M, { lastSyncAt: NOW, git: null, sync: null, skippedFiles: [] }, ctx());
    expect(r.events).toEqual([]);
  });

  it("位置不存在时抛 not_found", () => {
    const err = thrown(() => recordLocationSync(makeProject(), M, { lastSyncAt: NOW, git: null, sync: null, skippedFiles: [] }, ctx()));
    expect(err.code).toBe("not_found");
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

  it("挂起（原因 A）改成储备且不给原因：原因被清空（不只是改回自动才清空）", () => {
    const c = makeContainer({ manualStatus: "suspended", manualReason: "原因 A" });
    const r = updateContainer(makeBoard([c]), P, c.id, { manualStatus: "backlog" }, ctx());
    expect(r.container).toMatchObject({ manualStatus: "backlog", manualReason: null });
  });

  it("挂起改成挂起、只改原因：原因更新", () => {
    const c = makeContainer({ manualStatus: "suspended", manualReason: "原因 A" });
    const r = updateContainer(makeBoard([c]), P, c.id, { manualReason: "原因 B" }, ctx());
    expect(r.container).toMatchObject({ manualStatus: "suspended", manualReason: "原因 B" });
  });

  it("储备改成挂起且不给原因：报 invalid", () => {
    const c = makeContainer({ manualStatus: "backlog", manualReason: null });
    expect(thrown(() => updateContainer(makeBoard([c]), P, c.id, { manualStatus: "suspended" }, ctx())).code).toBe("invalid");
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

describe("reorderTasks", () => {
  const C = fixtureId("c", 1);
  const t = (n: number, over: Partial<ReturnType<typeof makeTask>> = {}) =>
    makeTask({ id: fixtureId("t", n), containerId: C, order: n, ...over });
  const board = () => makeBoard([makeContainer()], [t(1), t(2), t(3, { status: "done", completedAt: T0 }), t(4, { status: "cancelled" })]);
  const idsOf = (b: ReturnType<typeof board>, c = C) =>
    b.tasks.filter((x) => x.containerId === c).sort((a, z) => a.order - z.order).map((x) => x.id);
  const tid = (n: number) => fixtureId("t", n);

  it("部分列表：列出的排最前，其余保持相对顺序", () => {
    const r = reorderTasks(board(), P, C, { taskIds: [tid(3), tid(1)] }, ctx());
    expect(idsOf(r.board)).toEqual([tid(3), tid(1), tid(2), tid(4)]);
    expect(r.board.tasks.map((x) => x.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("完整列表严格按给定顺序", () => {
    const r = reorderTasks(board(), P, C, { taskIds: [tid(4), tid(3), tid(2), tid(1)] }, ctx());
    expect(idsOf(r.board)).toEqual([tid(4), tid(3), tid(2), tid(1)]);
  });

  it("order 重复或有空洞时按 order、createdAt、id 排出相对顺序并重新编号", () => {
    const b = makeBoard(
      [makeContainer()],
      [t(1, { order: 5 }), t(2, { order: 5, createdAt: "2026-08-01T00:00:00.000Z" }), t(3, { order: 9 })],
    );
    const r = reorderTasks(b, P, C, { taskIds: [tid(3)] }, ctx());
    expect(idsOf(r.board)).toEqual([tid(3), tid(2), tid(1)]);
    expect(r.board.tasks.map((x) => x.order).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("只有 order 变化的记录版本号加一，updatedAt 不变", () => {
    const r = reorderTasks(board(), P, C, { taskIds: [tid(2)] }, ctx());
    // 原 order 1,2,3,4 -> 2:0, 1:1, 3:2, 4:3
    const by = (n: number) => r.board.tasks.find((x) => x.id === tid(n))!;
    expect(by(2).version).toBe(2);
    expect(by(1).version).toBe(1);
    expect(by(3).version).toBe(2);
    expect(by(4).version).toBe(2);
    const r2 = reorderTasks(
      makeBoard([makeContainer()], [t(1, { order: 0 }), t(2, { order: 1 }), t(3, { order: 5 })]),
      P, C, { taskIds: [tid(2), tid(1)] }, ctx(),
    );
    const by2 = (n: number) => r2.board.tasks.find((x) => x.id === tid(n))!;
    expect(by2(3).version).toBe(2);
    expect(by2(3).order).toBe(2);
    for (const x of r.board.tasks) expect(x.updatedAt).toBe(T0);
  });

  it("未变化的记录版本不变", () => {
    const b = makeBoard([makeContainer()], [t(1, { order: 0 }), t(2, { order: 1 }), t(3, { order: 2 })]);
    const r = reorderTasks(b, P, C, { taskIds: [tid(2), tid(1)] }, ctx());
    expect(r.board.tasks.find((x) => x.id === tid(3))!.version).toBe(1);
  });

  it("顺序不变：返回原看板，没有事件", () => {
    const b = makeBoard([makeContainer()], [t(1, { order: 0 }), t(2, { order: 1 })]);
    const r = reorderTasks(b, P, C, { taskIds: [tid(1)] }, ctx());
    expect(r.board).toBe(b);
    expect(r.events).toEqual([]);
  });

  it("order 有空洞或重复但相对顺序不变：原看板、无事件", () => {
    const b = makeBoard([makeContainer()], [t(1, { order: 3 }), t(2, { order: 3 }), t(3, { order: 9 })]);
    const r = reorderTasks(b, P, C, { taskIds: [tid(1), tid(2)] }, ctx());
    expect(r.board).toBe(b);
    expect(r.events).toEqual([]);
  });

  it("只记一条事件，形状正确", () => {
    const r = reorderTasks(board(), P, C, { taskIds: [tid(3)] }, ctx(webActor));
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type).toBe("board.reordered");
    expect(e.projectId).toBe(P);
    expect(e.actor).toEqual(webActor);
    expect(e.target).toEqual({ containerId: C });
    expect(e.change).toEqual({
      taskOrder: { from: [tid(1), tid(2), tid(3), tid(4)], to: [tid(3), tid(1), tid(2), tid(4)] },
    });
  });

  it("只影响该容器的任务", () => {
    const C2 = fixtureId("c", 2);
    const b = makeBoard(
      [makeContainer(), makeContainer({ id: C2, code: "M2", order: 2 })],
      [t(1), t(2), makeTask({ id: tid(9), containerId: C2, order: 7 })],
    );
    const r = reorderTasks(b, P, C, { taskIds: [tid(2)] }, ctx());
    const other = r.board.tasks.find((x) => x.id === tid(9))!;
    expect(other.order).toBe(7);
    expect(other.version).toBe(1);
  });

  it("ID 重复、任务属于别的容器报 invalid；不存在的任务或容器报 not_found", () => {
    const C2 = fixtureId("c", 2);
    const b = makeBoard(
      [makeContainer(), makeContainer({ id: C2, code: "M2", order: 2 })],
      [t(1), makeTask({ id: tid(9), containerId: C2 })],
    );
    expect(thrown(() => reorderTasks(b, P, C, { taskIds: [tid(1), tid(1)] }, ctx())).code).toBe("invalid");
    expect(thrown(() => reorderTasks(b, P, C, { taskIds: [tid(9)] }, ctx())).code).toBe("invalid");
    expect(thrown(() => reorderTasks(b, P, C, { taskIds: [tid(8)] }, ctx())).code).toBe("not_found");
    expect(thrown(() => reorderTasks(b, P, fixtureId("c", 8), { taskIds: [tid(1)] }, ctx())).code).toBe("not_found");
    expect(thrown(() => reorderTasks(b, P, C, { taskIds: [] }, ctx())).code).toBe("invalid");
  });
});

describe("reorderContainers", () => {
  const cid = (n: number) => fixtureId("c", n);
  const board = () =>
    makeBoard([
      makeContainer({ id: cid(1), code: "M1", order: 1 }),
      makeContainer({ id: cid(2), code: "M2", order: 2 }),
      makeContainer({ id: cid(3), code: "M3", order: 3 }),
    ]);
  const idsOf = (b: ReturnType<typeof board>) =>
    b.containers.filter((c) => c.kind !== "misc").sort((a, z) => a.order - z.order).map((c) => c.id);

  it("部分列表与完整列表", () => {
    expect(idsOf(reorderContainers(board(), P, { containerIds: [cid(3)] }, ctx()).board)).toEqual([cid(3), cid(1), cid(2)]);
    expect(idsOf(reorderContainers(board(), P, { containerIds: [cid(3), cid(2), cid(1)] }, ctx()).board)).toEqual([
      cid(3), cid(2), cid(1),
    ]);
  });

  it("杂项容器不动，编号 0..n-1，updatedAt 不变，版本只在变化时加一", () => {
    const r = reorderContainers(board(), P, { containerIds: [cid(2)] }, ctx());
    const by = (id: string) => r.board.containers.find((c) => c.id === id)!;
    expect(by(cid(2)).order).toBe(0);
    expect(by(cid(1)).order).toBe(1);
    expect(by(cid(3)).order).toBe(2);
    expect(by(cid(3)).version).toBe(2);
    expect(by(fixtureId("c", 0))).toEqual(makeBoard().containers[0]);
    for (const c of r.board.containers) expect(c.updatedAt).toBe(T0);
  });

  it("未变化的容器版本不变", () => {
    const b = makeBoard([
      makeContainer({ id: cid(1), code: "M1", order: 0 }),
      makeContainer({ id: cid(2), code: "M2", order: 1 }),
      makeContainer({ id: cid(3), code: "M3", order: 2 }),
    ]);
    const r = reorderContainers(b, P, { containerIds: [cid(2), cid(1)] }, ctx());
    expect(r.board.containers.find((c) => c.id === cid(3))!.version).toBe(1);
  });

  it("顺序不变：原看板、无事件", () => {
    const b = makeBoard([
      makeContainer({ id: cid(1), code: "M1", order: 0 }),
      makeContainer({ id: cid(2), code: "M2", order: 1 }),
    ]);
    const r = reorderContainers(b, P, { containerIds: [cid(1), cid(2)] }, ctx());
    expect(r.board).toBe(b);
    expect(r.events).toEqual([]);
  });

  it("order 有空洞或重复但相对顺序不变：原看板、无事件", () => {
    const b = makeBoard([
      makeContainer({ id: cid(1), code: "M1", order: 4 }),
      makeContainer({ id: cid(2), code: "M2", order: 4 }),
      makeContainer({ id: cid(3), code: "M3", order: 9 }),
    ]);
    const r = reorderContainers(b, P, { containerIds: [cid(1)] }, ctx());
    expect(r.board).toBe(b);
    expect(r.events).toEqual([]);
  });

  it("事件形状", () => {
    const r = reorderContainers(board(), P, { containerIds: [cid(3)] }, ctx());
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type).toBe("board.reordered");
    expect(e.target).toBeNull();
    expect(e.change).toEqual({ containerOrder: { from: [cid(1), cid(2), cid(3)], to: [cid(3), cid(1), cid(2)] } });
  });

  it("重复报 invalid、含杂项报 invalid、不存在报 not_found", () => {
    expect(thrown(() => reorderContainers(board(), P, { containerIds: [cid(1), cid(1)] }, ctx())).code).toBe("invalid");
    expect(thrown(() => reorderContainers(board(), P, { containerIds: [cid(0)] }, ctx())).code).toBe("invalid");
    expect(thrown(() => reorderContainers(board(), P, { containerIds: [cid(8)] }, ctx())).code).toBe("not_found");
  });
});

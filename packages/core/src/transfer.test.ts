import { describe, expect, it } from "vitest";
import { KhError } from "./errors";
import type { MutationContext } from "./mutations";
import type { TaskStatus } from "./schema";
import {
  T0,
  cliActor,
  fixtureId,
  makeBoard,
  makeContainer,
  makeEvent,
  makeMisc,
  makeProject,
  makeTask,
  normalizeBoardForCompare,
  sequentialIds,
} from "./test-fixtures";
import {
  TRANSFER_FORMAT,
  buildExportDoc,
  importAppliedChange,
  importLogKey,
  planImport,
  readImportCounts,
  renderBoardMarkdown,
  transferDocSchema,
  type TransferDoc,
} from "./transfer";

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  if (result.success) return [];
  return result.error!.issues.map((i) => i.path.join("."));
}

function ctxAt(now: string, actor = cliActor): MutationContext {
  return { now, actor, newId: sequentialIds("n") };
}

const MIN_DOC: TransferDoc = { format: TRANSFER_FORMAT, containers: [] };

describe("transferDocSchema", () => {
  it("最小文件（只有 format 和空的 containers）通过", () => {
    expect(transferDocSchema.safeParse(MIN_DOC).success).toBe(true);
  });

  it("拒绝未知字段", () => {
    const r = transferDocSchema.safeParse({ ...MIN_DOC, extra: 1 });
    expect(r.success).toBe(false);
  });

  it("format 不对时报错", () => {
    expect(transferDocSchema.safeParse({ format: "other", containers: [] }).success).toBe(false);
  });

  it("杂项容器多于一个时报错", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "misc" }, { kind: "misc" }],
    });
    expect(r.success).toBe(false);
  });

  it("时间不带时区时报对应路径", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [],
      events: [{ ts: "2026-09-01T00:00:00", text: "x" }],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toContain("events.0.ts");
  });

  it("容器编号写成数字时报对应路径，信息里有加引号的提示", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: 1.1, title: "阶段" }],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toBe("containers.0.code");
    expect(r.error!.issues[0]!.message).toContain("加引号");
  });

  it("任务标题写成布尔值时报对应路径", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", title: "阶段", tasks: [{ title: true }] }],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toBe("containers.0.tasks.0.title");
  });

  it("targetVersion、分组写成数字时报对应路径", () => {
    const r1 = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", title: "阶段", targetVersion: 1.0 }],
    });
    expect(issuePaths(r1)[0]).toBe("containers.0.targetVersion");

    const r2 = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", title: "阶段", tasks: [{ title: "t", group: 10 }] }],
    });
    expect(issuePaths(r2)[0]).toBe("containers.0.tasks.0.group");
  });

  it("任务挂起没有原因时报错", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", title: "阶段", tasks: [{ title: "t", status: "suspended" }] }],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toContain("suspendReason");
  });

  it("任务非已完成却有完成时间时报错", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [
        { kind: "phase", title: "阶段", tasks: [{ title: "t", status: "todo", completedAt: "2026-09-01T00:00:00Z" }] },
      ],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toContain("completedAt");
  });

  it("容器挂起没有原因时报错", () => {
    const r = transferDocSchema.safeParse({
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", title: "阶段", manualStatus: "suspended" }],
    });
    expect(r.success).toBe(false);
    expect(issuePaths(r)[0]).toContain("manualReason");
  });
});

describe("importLogKey", () => {
  it("时间规范成 UTC 后与正文一起构成去重键", () => {
    const a = importLogKey("2026-09-01T10:00:00+08:00", "完成");
    const b = importLogKey("2026-09-01T02:00:00.000Z", "完成");
    expect(a).toBe(b);
  });

  it("正文不同则键不同", () => {
    expect(importLogKey(T0, "完成 A")).not.toBe(importLogKey(T0, "完成 B"));
  });
});

describe("planImport：匹配与新建", () => {
  it("按编号匹配容器与任务（不分大小写），只更新有变化的字段", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "工程骨架" });
    const task = makeTask({ id: fixtureId("t", 1), containerId: container.id, code: "0.1", title: "初始化仓库", status: "todo" });
    const board = makeBoard([container], [task]);
    const project = makeProject();
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "p0", tasks: [{ code: "0.1", status: "done" }] }],
    };
    const plan = planImport({ project, board }, doc, new Set(), ctxAt("2026-09-05T00:00:00.000Z"));
    expect(plan.board).not.toBeNull();
    const updatedTask = plan.board!.tasks.find((t) => t.id === task.id)!;
    expect(updatedTask.status).toBe("done");
    expect(updatedTask.title).toBe("初始化仓库");
    expect(plan.summary.tasks.statusChanges).toEqual([{ container: "P0", title: "初始化仓库", from: "todo", to: "done" }]);
    expect(plan.summary.containers.created).toEqual([]);
    expect(plan.summary.containers.updated).toEqual([]);
  });

  it("code 为空时按标题匹配", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: null, title: "工程骨架" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", title: "工程骨架", targetVersion: "v1" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board!.containers.find((c) => c.id === container.id)!.targetVersion).toBe("v1");
  });

  it("misc 容器直接对应项目的杂项容器", () => {
    const board = makeBoard([], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "misc", targetVersion: "v9" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    const misc = plan.board!.containers.find((c) => c.kind === "misc")!;
    expect(misc.targetVersion).toBe("v9");
    expect(misc.id).toBe(makeMisc().id);
  });

  it("已有条目重名时对应最靠前的那个", () => {
    const c1 = makeContainer({ id: fixtureId("c", 1), code: null, title: "重复" });
    const c2 = makeContainer({ id: fixtureId("c", 2), code: null, title: "重复" });
    const board = makeBoard([c1, c2], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", title: "重复", targetVersion: "v1" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board!.containers.find((c) => c.id === c1.id)!.targetVersion).toBe("v1");
    expect(plan.board!.containers.find((c) => c.id === c2.id)!.targetVersion).toBeNull();
  });

  it("文件内重复的匹配键报错", () => {
    const board = makeBoard([], []);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "P0", title: "a" }, { kind: "phase", code: "p0", title: "b" }],
    };
    expect(() => planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0))).toThrow(KhError);
  });

  it("兜底：文件给了编号、已有条目没有编号且标题相同，匹配上并补上编号", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: null, title: "工程骨架" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", title: "工程骨架" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    const updated = plan.board!.containers.find((c) => c.id === container.id)!;
    expect(updated.code).toBe("P0");
  });

  it("已有条目有别的编号时不兜底，新建", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P1", title: "工程骨架" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", title: "工程骨架" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.summary.containers.created).toEqual([{ label: "P0" }]);
    expect(plan.board!.containers.find((c) => c.id === container.id)!.code).toBe("P1");
  });

  it("换了容器的任务在新容器新建，旧容器的任务保持不动", () => {
    const c1 = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一" });
    const c2 = makeContainer({ id: fixtureId("c", 2), code: "P1", title: "阶段二" });
    const task = makeTask({ id: fixtureId("t", 1), containerId: c1.id, code: "0.1", title: "任务" });
    const board = makeBoard([c1, c2], [task]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [
        { kind: "phase", code: "P0" },
        { kind: "phase", code: "P1", tasks: [{ code: "0.1", title: "任务" }] },
      ],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    const oldTask = plan.board!.tasks.find((t) => t.id === task.id)!;
    expect(oldTask.containerId).toBe(c1.id);
    expect(plan.summary.tasks.created).toEqual([{ container: "P1", title: "任务" }]);
  });

  it("新建容器与任务排在末尾，历史日期规范成 UTC，新建的任务通过 taskSchema", () => {
    const board = makeBoard([], []);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [
        {
          kind: "phase",
          code: "P0",
          title: "新阶段",
          tasks: [{ code: "0.1", title: "新任务", status: "done", completedAt: "2026-09-01T18:00:00+08:00" }],
        },
      ],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-05T00:00:00.000Z"));
    const container = plan.board!.containers.find((c) => c.code === "P0")!;
    expect(container.order).toBeGreaterThanOrEqual(1);
    const task = plan.board!.tasks.find((t) => t.code === "0.1")!;
    expect(task.completedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(task.status).toBe("done");
  });
});

describe("planImport：更新", () => {
  it("只更新文件里写了的字段", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "原标题", targetVersion: "v1" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", title: "新标题" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    const updated = plan.board!.containers.find((c) => c.id === container.id)!;
    expect(updated.title).toBe("新标题");
    expect(updated.targetVersion).toBe("v1");
  });

  it("写成 null 清空可空字段", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", targetVersion: "v1" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", targetVersion: null }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board!.containers.find((c) => c.id === container.id)!.targetVersion).toBeNull();
  });

  it("状态变化推算日期；文件里的日期覆盖推算值", () => {
    const task = makeTask({ id: fixtureId("t", 1), code: "0.1", status: "todo" });
    const board = makeBoard([makeContainer()], [task]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "M1", tasks: [{ code: "0.1", status: "done", completedAt: "2026-09-01T00:00:00Z" }] }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-05T00:00:00.000Z"));
    const updated = plan.board!.tasks.find((t) => t.id === task.id)!;
    expect(updated.status).toBe("done");
    expect(updated.completedAt).toBe("2026-09-01T00:00:00.000Z");
    // todo 直接跳到 done（没有经过 in_progress）时，transitionTask 不会推算出开始时间
    expect(updated.startedAt).toBeNull();
  });

  it("只写了日期没改状态：直接用文件里的日期", () => {
    const task = makeTask({ id: fixtureId("t", 1), code: "0.1", status: "in_progress", startedAt: T0 });
    const board = makeBoard([makeContainer()], [task]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "M1", tasks: [{ code: "0.1", startedAt: "2026-09-02T00:00:00Z" }] }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-05T00:00:00.000Z"));
    expect(plan.board!.tasks.find((t) => t.id === task.id)!.startedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("同一时刻换一种时区写法不算变化", () => {
    const task = makeTask({ id: fixtureId("t", 1), code: "0.1", status: "in_progress", startedAt: "2026-09-01T02:00:00.000Z" });
    const board = makeBoard([makeContainer()], [task]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "M1", tasks: [{ code: "0.1", startedAt: "2026-09-01T10:00:00+08:00" }] }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board).toBeNull();
    expect(plan.summary.tasks.updated).toEqual([]);
  });

  it("没有实际变化时不算更新，version 不加 1", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", title: "阶段" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board).toBeNull();
    expect(plan.summary.containers.updated).toEqual([]);
  });

  it("有实际变化时 version 加 1", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段", version: 3 });
    const board = makeBoard([container], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", title: "新阶段" }] };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0));
    expect(plan.board!.containers.find((c) => c.id === container.id)!.version).toBe(4);
  });
});

describe("planImport：只改状态", () => {
  const cases: [TaskStatus, TaskStatus][] = [
    ["in_progress", "review"],
    ["todo", "cancelled"],
    ["in_progress", "todo"],
  ];
  for (const [from, to] of cases) {
    it(`${from} → ${to}：写入看板、生成新版本、import.applied 计入更新的任务`, () => {
      const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段" });
      const task = makeTask({
        id: fixtureId("t", 1),
        containerId: container.id,
        code: "0.1",
        title: "任务",
        status: from,
        startedAt: from === "in_progress" ? T0 : null,
      });
      const board = makeBoard([container], [task]);
      const project = makeProject();
      const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [{ kind: "phase", code: "P0", tasks: [{ code: "0.1", status: to }] }] };
      const plan = planImport({ project, board }, doc, new Set(), ctxAt("2026-09-10T00:00:00.000Z"));
      expect(plan.summary.tasks.statusChanges).toEqual([{ container: "P0", title: "任务", from, to }]);
      expect(plan.board).not.toBeNull();
      const next = plan.board!.tasks.find((t) => t.id === task.id)!;
      expect(next.status).toBe(to);
      expect(next.version).toBe(task.version + 1);
      expect(plan.project).toBeNull();
      expect(plan.events).toHaveLength(1);
      expect(readImportCounts(plan.events[0]!)!.tasksUpdated).toBe(1);

      // 导入之后再导入同一份文件：没有变化
      const again = planImport({ project, board: plan.board! }, doc, new Set(), ctxAt("2026-09-11T00:00:00.000Z"));
      expect(again.board).toBeNull();
      expect(again.events).toEqual([]);
      expect(again.summary.tasks.statusChanges).toEqual([]);
    });
  }

  it("同一任务既改状态又改其他字段时，import.applied 只计一次", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段" });
    const task = makeTask({ id: fixtureId("t", 1), containerId: container.id, code: "0.1", title: "任务", status: "in_progress", startedAt: T0 });
    const board = makeBoard([container], [task]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "P0", tasks: [{ code: "0.1", status: "review", note: "新备注" }] }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-10T00:00:00.000Z"));
    expect(readImportCounts(plan.events[0]!)!.tasksUpdated).toBe(1);
  });
});

describe("planImport：历史日志与 import.applied", () => {
  it("新的历史日志会去重（与已有日志、文件内、不同时区写法）", () => {
    const board = makeBoard([], []);
    const existingKey = importLogKey("2026-09-01T00:00:00.000Z", "已有日志");
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [],
      events: [
        { ts: "2026-09-01T00:00:00.000Z", text: "已有日志" },
        { ts: "2026-09-02T08:00:00+08:00", text: "新日志" },
        { ts: "2026-09-02T00:00:00.000Z", text: "新日志" },
      ],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set([existingKey]), ctxAt("2026-09-10T00:00:00.000Z"));
    expect(plan.summary.events).toEqual({ added: 1, duplicates: 2 });
  });

  it("历史日志时间晚于导入时间 5 分钟以上报错", () => {
    const board = makeBoard([], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, containers: [], events: [{ ts: "2026-09-10T00:06:00.000Z", text: "太晚了" }] };
    try {
      planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-10T00:00:00.000Z"));
      throw new Error("预期抛出错误");
    } catch (e) {
      expect(e).toBeInstanceOf(KhError);
      const issues = ((e as KhError).details as { issues: string[] }).issues;
      expect(issues[0]).toMatch(/^events\[0\]\.ts：/);
    }
  });

  it("import.applied 有变化时一条、排第一条、计数正确；历史日志标记 imported: true", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段" });
    const board = makeBoard([container], []);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "P0", title: "新阶段" }],
      events: [{ ts: "2026-09-01T00:00:00.000Z", text: "新日志" }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set(), ctxAt("2026-09-10T00:00:00.000Z"));
    expect(plan.events[0]!.type).toBe("import.applied");
    expect(plan.events[0]!.imported).toBe(false);
    const counts = readImportCounts(plan.events[0]!);
    expect(counts).toEqual({ projectFields: [], containersCreated: 0, containersUpdated: 1, tasksCreated: 0, tasksUpdated: 0, logsAdded: 1 });
    expect(plan.events[1]!.type).toBe("log");
    expect(plan.events[1]!.imported).toBe(true);
  });

  it("完全重复导入时 events 为空、project 和 board 都为 null", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段" });
    const board = makeBoard([container], []);
    const existingKey = importLogKey(T0, "已导入过");
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [{ kind: "phase", code: "P0", title: "阶段" }],
      events: [{ ts: T0, text: "已导入过" }],
    };
    const plan = planImport({ project: makeProject(), board }, doc, new Set([existingKey]), ctxAt("2026-09-10T00:00:00.000Z"));
    expect(plan.events).toEqual([]);
    expect(plan.project).toBeNull();
    expect(plan.board).toBeNull();
  });

  it("项目字段变化会计入 summary 与 import.applied", () => {
    const project = makeProject({ cycle: "development", focus: "旧焦点" });
    const board = makeBoard([], []);
    const doc: TransferDoc = { format: TRANSFER_FORMAT, project: { cycle: "iteration", focus: "新焦点" }, containers: [] };
    const plan = planImport({ project, board }, doc, new Set(), ctxAt(T0));
    expect(plan.project!.cycle).toBe("iteration");
    expect(plan.project!.focus).toBe("新焦点");
    expect(plan.summary.project).toEqual([
      { field: "cycle", from: "development", to: "iteration" },
      { field: "focus", from: "旧焦点", to: "新焦点" },
    ]);
    const counts = readImportCounts(plan.events[0]!)!;
    expect(counts.projectFields).toEqual(["cycle", "focus"]);
  });
});

describe("importAppliedChange / readImportCounts", () => {
  it("互为逆运算", () => {
    const counts = { projectFields: ["cycle"], containersCreated: 1, containersUpdated: 2, tasksCreated: 3, tasksUpdated: 4, logsAdded: 5 };
    const change = importAppliedChange(counts);
    const event = { id: "e", ts: T0, projectId: "p", actor: cliActor, type: "import.applied" as const, target: null, change, text: null, imported: false };
    expect(readImportCounts(event)).toEqual(counts);
  });

  it("事件类型不对或形状不对时返回 null", () => {
    const logEvent = { id: "e", ts: T0, projectId: "p", actor: cliActor, type: "log" as const, target: null, change: null, text: "x", imported: false };
    expect(readImportCounts(logEvent)).toBeNull();
  });
});

describe("往返：导出再导入", () => {
  it("buildExportDoc 的结果导回同一个看板，没有任何变化", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一", order: 1 });
    const task = makeTask({ id: fixtureId("t", 1), containerId: container.id, code: "0.1", title: "任务", order: 1, status: "done", startedAt: T0, completedAt: T0 });
    const board = makeBoard([container], [task]);
    const project = makeProject();
    const logs = [
      { id: fixtureId("e", 1), ts: T0, projectId: project.id, actor: cliActor, type: "log" as const, target: null, change: null, text: "日志", imported: false },
    ];
    const doc = buildExportDoc(project, board, logs);
    const plan = planImport({ project, board }, doc, new Set([importLogKey(T0, "日志")]), ctxAt("2026-10-01T00:00:00.000Z"));
    expect(plan.project).toBeNull();
    expect(plan.board).toBeNull();
    expect(plan.events).toEqual([]);
  });

  it("导入一个新建项目的空看板，得到等价看板（order 不连续也等价）", () => {
    const c1 = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一", order: 1 });
    const c2 = makeContainer({ id: fixtureId("c", 2), code: "P1", title: "阶段二", order: 3 });
    const t1 = makeTask({ id: fixtureId("t", 1), containerId: c1.id, code: "0.1", title: "任务一", order: 1 });
    const t2 = makeTask({ id: fixtureId("t", 2), containerId: c1.id, code: "0.7", title: "任务二", order: 7 });
    const board = makeBoard([c1, c2], [t1, t2]);
    const project = makeProject();
    const doc = buildExportDoc(project, board, []);

    const newProject = makeProject({ id: fixtureId("p", 2) });
    const newBoard = makeBoard([], []);
    const plan = planImport({ project: newProject, board: newBoard }, doc, new Set(), ctxAt("2026-10-01T00:00:00.000Z"));
    expect(normalizeBoardForCompare(plan.board!)).toEqual(normalizeBoardForCompare(board));
  });
});

describe("renderBoardMarkdown", () => {
  it("包含标题、周期、健康度、进度、焦点、导出时间", () => {
    const project = makeProject({ name: "示例项目", cycle: "development", health: "on_track", focus: "完成 M6" });
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一" });
    const task = makeTask({ id: fixtureId("t", 1), containerId: container.id, code: "0.1", title: "任务", status: "cancelled" });
    const board = makeBoard([container], [task]);
    const md = renderBoardMarkdown(project, board, { now: new Date("2026-10-01T00:00:00.000Z"), timeZone: "UTC" });
    expect(md).toContain("示例项目");
    expect(md).toContain("开发期");
    expect(md).toContain("正常");
    expect(md).toContain("完成 M6");
    expect(md).toContain("进度：0/0");
    expect(md).toContain("P0");
    expect(md).toContain("~~");
  });

  it("项目进度与 kh status 算法相同：已取消的不计，杂项容器不计", () => {
    const project = makeProject({ name: "示例项目" });
    const phase = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一" });
    const misc = makeMisc();
    const tasks = [
      makeTask({ id: fixtureId("t", 1), containerId: phase.id, title: "完成的", status: "done", completedAt: T0 }),
      makeTask({ id: fixtureId("t", 2), containerId: phase.id, title: "进行中", status: "in_progress", startedAt: T0 }),
      makeTask({ id: fixtureId("t", 3), containerId: phase.id, title: "取消的", status: "cancelled" }),
      makeTask({ id: fixtureId("t", 4), containerId: misc.id, title: "杂项完成", status: "done", completedAt: T0 }),
    ];
    const md = renderBoardMarkdown(project, makeBoard([phase], tasks), { now: new Date("2026-10-01T00:00:00.000Z"), timeZone: "UTC" });
    expect(md.split("\n")[2]).toContain("进度：1/2");
  });

  it("备注与待你处理说明里的换行替换成空格，不把列表拆开", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "P0", title: "阶段一" });
    const task = makeTask({
      id: fixtureId("t", 1),
      containerId: container.id,
      title: "任务",
      note: "第一行\n第二行",
      human: { kind: "decision", note: "请确认\r\n再继续" },
    });
    const md = renderBoardMarkdown(makeProject(), makeBoard([container], [task]), { now: new Date("2026-10-01T00:00:00.000Z"), timeZone: "UTC" });
    const line = md.split("\n").find((l) => l.startsWith("- "))!;
    expect(line).toContain("第一行 第二行");
    expect(line).toContain("请确认 再继续");
  });
});

describe("planImport：编号冲突按文件位置报错", () => {
  function issuesOf(fn: () => unknown): string[] {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(KhError);
      return ((e as KhError).details as { issues: string[] }).issues;
    }
    throw new Error("预期抛出错误");
  }

  it("容器：先按标题匹配走了已有编号，再新建同编号的容器", () => {
    const board = makeBoard([makeContainer({ id: fixtureId("c", 1), code: "P0", title: "X" })], []);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [
        { kind: "phase", title: "X" },
        { kind: "phase", code: "P0", title: "Y" },
      ],
    };
    const issues = issuesOf(() => planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0)));
    expect(issues[0]).toMatch(/^containers\[1\]\.code：/);
  });

  it("容器：兜底补编号撞上其他已有容器的编号", () => {
    const board = makeBoard(
      [
        makeContainer({ id: fixtureId("c", 1), code: null, title: "X", order: 1 }),
        makeContainer({ id: fixtureId("c", 2), code: "P0", title: "Z", order: 2 }),
      ],
      [],
    );
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [
        { kind: "phase", title: "Z" },
        { kind: "phase", code: "p0", title: "X" },
      ],
    };
    const issues = issuesOf(() => planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0)));
    expect(issues[0]).toMatch(/^containers\[1\]\.code：/);
  });

  it("任务：同一容器内新建同编号的任务", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, code: "0.1", title: "A" })]);
    const doc: TransferDoc = {
      format: TRANSFER_FORMAT,
      containers: [
        {
          kind: "phase",
          code: "M1",
          tasks: [{ title: "A" }, { title: "B" }, { code: "0.1", title: "C" }],
        },
      ],
    };
    const issues = issuesOf(() => planImport({ project: makeProject(), board }, doc, new Set(), ctxAt(T0)));
    expect(issues[0]).toMatch(/^containers\[0\]\.tasks\[2\]\.code：/);
  });
});

describe("renderBoardMarkdown：时区", () => {
  it("同一时刻在不同时区显示的日期不同", () => {
    const project = makeProject();
    const board = makeBoard([], []);
    const now = new Date("2026-10-01T16:30:00.000Z");
    const utc = renderBoardMarkdown(project, board, { now, timeZone: "UTC" });
    const sh = renderBoardMarkdown(project, board, { now, timeZone: "Asia/Shanghai" });
    expect(utc).toContain("2026/10/01");
    expect(sh).toContain("2026/10/02");
    expect(utc).not.toEqual(sh);
  });
});

describe("重排事件与导出", () => {
  it("导出只带日志事件，board.reordered 事件被忽略", () => {
    const reordered = makeEvent({
      type: "board.reordered",
      text: null,
      target: { containerId: fixtureId("c", 1) },
      change: { taskOrder: { from: [], to: [] } },
    });
    const doc = buildExportDoc(makeProject(), makeBoard(), [reordered, makeEvent({ id: fixtureId("e", 2), text: "留下" })]);
    expect(doc.events).toEqual([{ ts: T0, text: "留下" }]);
  });
});

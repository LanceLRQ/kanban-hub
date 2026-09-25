import { describe, expect, it } from "vitest";
import {
  boardSchema,
  containerCreateInput,
  containerSchema,
  eventSchema,
  isRepoRelativePath,
  locationInput,
  projectCreateInput,
  syncScopeSchema,
  taskPatchInput,
  taskSchema,
  timestampSchema,
} from "./schema";
import { SYNC_MAX_FILE_SIZE_LIMIT } from "./sync";
import { cliActor, fixtureId, makeBoard, makeContainer, makeEvent, makeMisc, makeTask } from "./test-fixtures";

/** 校验失败时各个问题的字段路径，用点连接 */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((i) => i.path.map(String).join("."));
}

describe("时间", () => {
  it("接受带时区的时间，拒绝不带时区的", () => {
    expect(timestampSchema.safeParse("2026-09-23T10:00:00+08:00").success).toBe(true);
    expect(timestampSchema.safeParse("2026-09-23T02:00:00.000Z").success).toBe(true);
    expect(timestampSchema.safeParse("2026-09-23T10:00:00").success).toBe(false);
  });
});

describe("仓库内的相对路径", () => {
  it.each(["docs/a.md", "CLAUDE.local.md", "docs/_internal/设计 草稿.md"])("接受 %s", (p) => {
    expect(isRepoRelativePath(p)).toBe(true);
  });

  it.each(["/etc/passwd", "../x.md", "docs/../x.md", "a//b", "./a", "a\\b", "C:/x", ""])("拒绝 %s", (p) => {
    expect(isRepoRelativePath(p)).toBe(false);
  });
});

describe("任务", () => {
  it("合法任务通过校验", () => {
    expect(taskSchema.safeParse(makeTask()).success).toBe(true);
  });

  it("挂起时必须有原因，错误挂在 suspendReason 上", () => {
    expect(issuePaths(taskSchema.safeParse(makeTask({ status: "suspended" })))).toEqual(["suspendReason"]);
  });

  it("不是挂起状态时不能有挂起原因", () => {
    expect(issuePaths(taskSchema.safeParse(makeTask({ suspendReason: "等接口" })))).toEqual(["suspendReason"]);
  });

  it("不是已完成状态时不能有完成时间", () => {
    expect(issuePaths(taskSchema.safeParse(makeTask({ completedAt: "2026-09-02T00:00:00.000Z" })))).toEqual([
      "completedAt",
    ]);
  });

  it.each(["2/3", "#1", "a b"])("编号不能是 %s", (code) => {
    expect(issuePaths(taskSchema.safeParse(makeTask({ code })))).toEqual(["code"]);
  });

  it("校验提示是中文", () => {
    const r = taskSchema.safeParse(makeTask({ title: "" }));
    expect(r.error?.issues[0]?.message).toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("容器", () => {
  it("挂起时必须有原因", () => {
    expect(issuePaths(containerSchema.safeParse(makeContainer({ manualStatus: "suspended" })))).toEqual([
      "manualReason",
    ]);
  });

  it("没有手动状态时不能有原因", () => {
    expect(issuePaths(containerSchema.safeParse(makeContainer({ manualReason: "x" })))).toEqual(["manualReason"]);
  });

  it("杂项容器不能手动设置状态", () => {
    expect(issuePaths(containerSchema.safeParse(makeMisc({ manualStatus: "backlog" })))).toEqual(["manualStatus"]);
  });

  it("编号 misc 留给杂项容器，不区分大小写", () => {
    expect(issuePaths(containerSchema.safeParse(makeContainer({ code: "MISC" })))).toEqual(["code"]);
  });
});

describe("看板", () => {
  it("合法看板通过校验", () => {
    expect(boardSchema.safeParse(makeBoard([makeContainer()], [makeTask()])).success).toBe(true);
  });

  it("必须有且只有一个杂项容器", () => {
    expect(issuePaths(boardSchema.safeParse({ containers: [makeContainer()], tasks: [] }))).toEqual(["containers"]);
    expect(
      issuePaths(boardSchema.safeParse({ containers: [makeMisc(), makeMisc({ id: fixtureId("c", 9) })], tasks: [] })),
    ).toEqual(["containers"]);
  });

  it("任务引用不存在的容器时指出位置", () => {
    const board = makeBoard([makeContainer()], [makeTask({ containerId: fixtureId("c", 9) })]);
    expect(issuePaths(boardSchema.safeParse(board))).toEqual(["tasks.0.containerId"]);
  });

  it("ID 重复时指出位置", () => {
    expect(issuePaths(boardSchema.safeParse(makeBoard([makeContainer()], [makeTask(), makeTask()])))).toEqual([
      "tasks.1.id",
    ]);
  });
});

describe("事件", () => {
  it("合法事件通过校验", () => {
    expect(eventSchema.safeParse(makeEvent()).success).toBe(true);
  });

  it("来自命令行的操作者必须带机器 ID", () => {
    expect(issuePaths(eventSchema.safeParse(makeEvent({ actor: { ...cliActor, machineId: null } })))).toEqual([
      "actor.machineId",
    ]);
  });
});

describe("变更输入", () => {
  it("新建项目只需要名称", () => {
    expect(projectCreateInput.safeParse({ name: "看板" }).success).toBe(true);
  });

  it("新建容器不能是杂项", () => {
    expect(containerCreateInput.safeParse({ kind: "misc", title: "x" }).success).toBe(false);
  });

  it("修改任务时拒绝未知字段", () => {
    expect(taskPatchInput.safeParse({ stauts: "done" }).success).toBe(false);
  });

  it("修改任务的字段都可以省略，写 null 表示清空", () => {
    expect(taskPatchInput.safeParse({ human: null, dueDate: null }).success).toBe(true);
  });

  it("登记位置只需要路径，sync 可以省略或为 null", () => {
    expect(locationInput.safeParse({ path: "/repo" }).success).toBe(true);
    expect(locationInput.safeParse({ path: "/repo", sync: null }).success).toBe(true);
  });

  it("登记位置：路径为空时拒绝", () => {
    expect(locationInput.safeParse({ path: "" }).success).toBe(false);
  });

  it("登记位置：拒绝未知字段", () => {
    expect(locationInput.safeParse({ path: "/repo", machineId: "m1" }).success).toBe(false);
  });
});

describe("同步范围", () => {
  it("接受不超过硬上限的 maxFileSize", () => {
    expect(
      syncScopeSchema.safeParse({ include: ["docs/**"], exclude: [], maxFileSize: SYNC_MAX_FILE_SIZE_LIMIT }).success,
    ).toBe(true);
  });

  it("拒绝超过硬上限（20MB）的 maxFileSize", () => {
    expect(
      syncScopeSchema.safeParse({ include: ["docs/**"], exclude: [], maxFileSize: SYNC_MAX_FILE_SIZE_LIMIT + 1 })
        .success,
    ).toBe(false);
  });
});

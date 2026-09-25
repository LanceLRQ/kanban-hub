import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { fixtureId, makeBoard, makeContainer, makeEvent, makeTask } from "@kanban-hub/core/test-fixtures";
import enumsMessages from "../../messages/zh-CN/enums.json";
import eventsMessages from "../../messages/zh-CN/events.json";
import { describeEvent, EVENT_GROUPS, eventGroupOf, sortEventsForDisplay, type EnumLabelGroup } from "./events";

/** 用真实的 events.json 渲染成字符串来断言 describeEvent 的输出；key/values 都是运行期算出来的，没有编译期字面量可用 */
type LooseTranslator = (key: string, values?: Record<string, string | number>) => string;
const tEvents = createTranslator({ locale: "zh-CN", messages: eventsMessages }) as unknown as LooseTranslator;
/** enumLabel 同样用真实的 enums.json 构造：枚举中文名只来自 enums 命名空间 */
const tEnums = createTranslator({ locale: "zh-CN", messages: enumsMessages }) as unknown as LooseTranslator;

function enumLabel(group: EnumLabelGroup, value: string): string {
  return tEnums(`${group}.${value}`);
}

function describeAndRender(event: Parameters<typeof describeEvent>[0], ctx: Parameters<typeof describeEvent>[1]): string {
  const { key, values } = describeEvent(event, ctx);
  return tEvents(key, values);
}

const container = makeContainer({ id: fixtureId("c", 1), code: "M1", title: "阶段一" });
const task = makeTask({ id: fixtureId("t", 1), containerId: container.id, title: "写文档" });
const board = makeBoard([container], [task]);
const ctx = { board, projectName: "看板中枢", enumLabel };

describe("describeEvent：12 种事件类型各一个用例", () => {
  it("project.created", () => {
    const event = makeEvent({ type: "project.created", target: null, change: null, text: null });
    expect(describeAndRender(event, ctx)).toBe("创建了项目 看板中枢");
  });

  it("project.updated", () => {
    const event = makeEvent({
      type: "project.updated",
      target: null,
      change: { cycle: { from: "development", to: "iteration" } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toBe("将周期改为迭代期");
  });

  it("container.created", () => {
    const event = makeEvent({ type: "container.created", target: { containerId: container.id }, change: null, text: null });
    expect(describeAndRender(event, ctx)).toBe("新建了容器 M1 阶段一");
  });

  it("container.updated", () => {
    const event = makeEvent({
      type: "container.updated",
      target: { containerId: container.id },
      change: { manualStatus: { from: null, to: "suspended" } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toBe("将 M1 阶段一 的状态改为挂起");
  });

  it("task.created", () => {
    const event = makeEvent({ type: "task.created", target: { taskId: task.id }, change: null, text: null });
    const shortRef = describeEvent(event, ctx).values.task;
    expect(describeAndRender(event, ctx)).toBe(`新建了任务 ${shortRef}`);
    expect(String(shortRef)).toContain("写文档");
  });

  it("task.updated", () => {
    const event = makeEvent({
      type: "task.updated",
      target: { taskId: task.id },
      change: { title: { from: "写文档", to: "写设计文档" } },
      text: null,
    });
    const rendered = describeAndRender(event, ctx);
    expect(rendered).toContain("改名为 写设计文档");
  });

  it("task.status_changed", () => {
    const event = makeEvent({
      type: "task.status_changed",
      target: { taskId: task.id },
      change: { status: { from: "todo", to: "in_progress" } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toContain("状态改为进行中");
  });

  it("task.human_changed（设置）", () => {
    const event = makeEvent({
      type: "task.human_changed",
      target: { taskId: task.id },
      change: { human: { from: null, to: { kind: "verify", note: "确认一下" } } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toContain("标记为待验证：确认一下");
  });

  it("task.human_changed（清除）", () => {
    const event = makeEvent({
      type: "task.human_changed",
      target: { taskId: task.id },
      change: { human: { from: { kind: "verify", note: "确认一下" }, to: null } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toContain("清除了");
  });

  it("log", () => {
    const event = makeEvent({ type: "log", target: null, change: null, text: "今天做了很多事" });
    expect(describeAndRender(event, ctx)).toBe("记了一条日志：今天做了很多事");
  });

  it("docs.synced", () => {
    const event = makeEvent({ type: "docs.synced", target: null, change: null, text: null });
    expect(describeAndRender(event, ctx)).toBe("同步了文档");
  });

  it("docs.pulled", () => {
    const event = makeEvent({ type: "docs.pulled", target: null, change: null, text: null });
    expect(describeAndRender(event, ctx)).toBe("拉取了文档");
  });

  it("import.applied", () => {
    const event = makeEvent({ type: "import.applied", target: null, change: null, text: null });
    expect(describeAndRender(event, ctx)).toBe("应用了一次导入");
  });
});

describe("describeEvent：container.updated / task.updated 的其余专门分支", () => {
  it("container.updated 的 targetVersion", () => {
    const event = makeEvent({
      type: "container.updated",
      target: { containerId: container.id },
      change: { targetVersion: { from: null, to: "v1.0" } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toBe("将 M1 阶段一 的目标版本改为 v1.0");
  });

  it("container.updated 的 targetDate", () => {
    const event = makeEvent({
      type: "container.updated",
      target: { containerId: container.id },
      change: { targetDate: { from: null, to: "2026-10-01" } },
      text: null,
    });
    expect(describeAndRender(event, ctx)).toBe("将 M1 阶段一 的目标日期改为 2026-10-01");
  });

  it("task.updated 的 group", () => {
    const event = makeEvent({
      type: "task.updated",
      target: { taskId: task.id },
      change: { group: { from: null, to: "后端" } },
      text: null,
    });
    const shortRef = describeEvent(event, ctx).values.task;
    expect(describeAndRender(event, ctx)).toBe(`将 ${shortRef} 的分组改为 后端`);
  });

  it("task.updated 的 dueDate", () => {
    const event = makeEvent({
      type: "task.updated",
      target: { taskId: task.id },
      change: { dueDate: { from: null, to: "2026-10-01" } },
      text: null,
    });
    const shortRef = describeEvent(event, ctx).values.task;
    expect(describeAndRender(event, ctx)).toBe(`将 ${shortRef} 的截止日期改为 2026-10-01`);
  });

  it("task.updated 的 note", () => {
    const event = makeEvent({
      type: "task.updated",
      target: { taskId: task.id },
      change: { note: { from: "", to: "备注内容" } },
      text: null,
    });
    const shortRef = describeEvent(event, ctx).values.task;
    expect(describeAndRender(event, ctx)).toBe(`修改了 ${shortRef} 的备注`);
  });
});

describe("describeEvent：兜底", () => {
  it("任务在看板里找不到时，用 ID 前缀兜底，不抛错", () => {
    const event = makeEvent({ type: "task.created", target: { taskId: "zzzzzzzzzz" }, change: null, text: null });
    const description = describeEvent(event, ctx);
    expect(description.values.task).toBe("#zzzz");
    expect(() => tEvents(description.key, description.values)).not.toThrow();
  });

  it("容器在看板里找不到时，用 ID 前缀兜底，不抛错", () => {
    const event = makeEvent({ type: "container.created", target: { containerId: "zzzzzzzzzz" }, change: null, text: null });
    const description = describeEvent(event, ctx);
    expect(description.values.container).toBe("zzzz");
  });

  it("常见字段之外的其余字段用通用描述“修改了 X”", () => {
    const event = makeEvent({
      type: "task.updated",
      target: { taskId: task.id },
      change: { assigneeUserId: { from: null, to: "u0000000002" } },
      text: null,
    });
    const description = describeEvent(event, ctx);
    expect(description.key).toBe("task.updated.generic");
    expect(description.values.field).toBe("assigneeUserId");
  });
});

describe("sortEventsForDisplay", () => {
  it("按 (ts, 次级顺序, id) 整体倒序：同一时刻 created → updated → status_changed → human_changed → 其他", () => {
    const ts = "2026-09-24T10:00:00.000Z";
    const humanChanged = makeEvent({ id: fixtureId("e", 1), ts, type: "task.human_changed" });
    const statusChanged = makeEvent({ id: fixtureId("e", 2), ts, type: "task.status_changed" });
    const updated = makeEvent({ id: fixtureId("e", 3), ts, type: "task.updated" });
    const created = makeEvent({ id: fixtureId("e", 4), ts, type: "task.created" });
    const other = makeEvent({ id: fixtureId("e", 5), ts, type: "log" });
    const earlier = makeEvent({ id: fixtureId("e", 6), ts: "2026-09-24T09:00:00.000Z", type: "log" });

    const sorted = sortEventsForDisplay([earlier, humanChanged, other, statusChanged, updated, created]);
    expect(sorted.map((e) => e.type)).toEqual([
      "task.created",
      "task.updated",
      "task.status_changed",
      "task.human_changed",
      "log",
      "log",
    ]);
    expect(sorted.at(-1)).toBe(earlier);
  });
});

describe("EVENT_GROUPS / eventGroupOf", () => {
  it("覆盖全部 12 种事件类型，且分组和「细节」表格一致", () => {
    expect(EVENT_GROUPS).toEqual({
      task: ["task.created", "task.updated", "task.status_changed", "task.human_changed"],
      container: ["container.created", "container.updated"],
      project: ["project.created", "project.updated"],
      log: ["log"],
      docs: ["docs.synced", "docs.pulled"],
      import: ["import.applied"],
    });
  });

  it("eventGroupOf 按类型返回所在分组", () => {
    expect(eventGroupOf("task.status_changed")).toBe("task");
    expect(eventGroupOf("container.updated")).toBe("container");
    expect(eventGroupOf("project.created")).toBe("project");
    expect(eventGroupOf("log")).toBe("log");
    expect(eventGroupOf("docs.pulled")).toBe("docs");
    expect(eventGroupOf("import.applied")).toBe("import");
  });
});

import { describe, expect, it } from "vitest";
import { CYCLES, HEALTHS, HUMAN_KINDS, MANUAL_STATUSES, TASK_STATUSES } from "@kanban-hub/core/schema";
import { CYCLE_LABELS, HEALTH_LABELS, HUMAN_KIND_LABELS, MANUAL_STATUS_LABELS, TASK_STATUS_LABELS } from "./labels";

describe("枚举中文名", () => {
  it("周期：每个取值都有中文名，且覆盖 core 的全部取值", () => {
    expect(Object.keys(CYCLE_LABELS).sort()).toEqual([...CYCLES].sort());
    expect(CYCLE_LABELS.design).toBe("设计期");
    expect(CYCLE_LABELS.development).toBe("开发期");
    expect(CYCLE_LABELS.iteration).toBe("迭代期");
    expect(CYCLE_LABELS.maintenance).toBe("维护期");
    expect(CYCLE_LABELS.archived).toBe("归档");
  });

  it("健康度：每个取值都有中文名，且覆盖 core 的全部取值", () => {
    expect(Object.keys(HEALTH_LABELS).sort()).toEqual([...HEALTHS].sort());
    expect(HEALTH_LABELS.on_track).toBe("正常");
    expect(HEALTH_LABELS.at_risk).toBe("有风险");
    expect(HEALTH_LABELS.blocked).toBe("卡住");
  });

  it("任务状态：每个取值都有中文名，且覆盖 core 的全部取值", () => {
    expect(Object.keys(TASK_STATUS_LABELS).sort()).toEqual([...TASK_STATUSES].sort());
    expect(TASK_STATUS_LABELS.todo).toBe("待开始");
    expect(TASK_STATUS_LABELS.in_progress).toBe("进行中");
    expect(TASK_STATUS_LABELS.review).toBe("复核中");
    expect(TASK_STATUS_LABELS.done).toBe("已完成");
    expect(TASK_STATUS_LABELS.suspended).toBe("挂起");
    expect(TASK_STATUS_LABELS.cancelled).toBe("已取消");
  });

  it("待你处理：每个取值都有中文名，且覆盖 core 的全部取值", () => {
    expect(Object.keys(HUMAN_KIND_LABELS).sort()).toEqual([...HUMAN_KINDS].sort());
    expect(HUMAN_KIND_LABELS.decision).toBe("待决策");
    expect(HUMAN_KIND_LABELS.verify).toBe("待验证");
    expect(HUMAN_KIND_LABELS.action).toBe("待操作");
  });

  it("容器手动状态：每个取值都有中文名，且覆盖 core 的全部取值", () => {
    expect(Object.keys(MANUAL_STATUS_LABELS).sort()).toEqual([...MANUAL_STATUSES].sort());
    expect(MANUAL_STATUS_LABELS.backlog).toBe("储备");
    expect(MANUAL_STATUS_LABELS.suspended).toBe("挂起");
    expect(MANUAL_STATUS_LABELS.cancelled).toBe("已取消");
  });
});

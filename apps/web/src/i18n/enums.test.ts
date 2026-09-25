import { describe, expect, it } from "vitest";
import {
  CONTAINER_KINDS,
  CYCLES,
  EVENT_TYPES,
  HEALTHS,
  HUMAN_KINDS,
  MACHINE_OSES,
  MANUAL_STATUSES,
  TASK_STATUSES,
} from "@kanban-hub/core/schema";
import { CJK_FONTS, MONO_FONTS, THEMES } from "@/lib/preferences";
import enums from "../../messages/zh-CN/enums.json";

// enums 命名空间要覆盖 core 里每个枚举的全部取值：断言从 core 的枚举常量生成，
// 而不是手写一份清单，防止 core 加新取值后语言包漏更新却不报错。

describe("enums 命名空间覆盖 core 的所有枚举取值", () => {
  it.each(CYCLES)("cycle.%s 有中文文案", (value) => {
    expect(enums.cycle).toHaveProperty(value);
    const label = (enums.cycle as Record<string, string>)[value];
    expect(typeof label).toBe("string");
    expect(label?.length).toBeGreaterThan(0);
  });

  it.each(HEALTHS)("health.%s 有中文文案", (value) => {
    expect(enums.health).toHaveProperty(value);
  });

  it.each(TASK_STATUSES)("taskStatus.%s 有中文文案", (value) => {
    expect(enums.taskStatus).toHaveProperty(value);
  });

  it.each(HUMAN_KINDS)("humanKind.%s 有中文文案", (value) => {
    expect(enums.humanKind).toHaveProperty(value);
  });

  it.each(MANUAL_STATUSES)("manualStatus.%s 有中文文案", (value) => {
    expect(enums.manualStatus).toHaveProperty(value);
  });

  it.each(CONTAINER_KINDS)("containerKind.%s 有中文文案", (value) => {
    expect(enums.containerKind).toHaveProperty(value);
  });

  it.each(EVENT_TYPES)("eventType.%s 有中文文案", (value) => {
    expect(enums.eventType).toHaveProperty(value);
  });

  it.each(MACHINE_OSES)("machineOs.%s 有中文文案", (value) => {
    expect(enums.machineOs).toHaveProperty(value);
  });

  it("containerStatus 覆盖推算出的三态：待开始、进行中、已完成", () => {
    expect(enums.containerStatus).toHaveProperty("todo");
    expect(enums.containerStatus).toHaveProperty("in_progress");
    expect(enums.containerStatus).toHaveProperty("done");
  });

  it("eventTypeGroup 覆盖六个事件类型分组", () => {
    for (const group of ["task", "container", "project", "log", "docs", "import"]) {
      expect(enums.eventTypeGroup).toHaveProperty(group);
    }
  });

  it.each(THEMES)("theme.%s 有中文文案", (value) => {
    expect(enums.theme).toHaveProperty(value);
  });

  it.each(MONO_FONTS)("monoFont.%s 有中文文案", (value) => {
    expect(enums.monoFont).toHaveProperty(value);
  });

  it.each(CJK_FONTS)("cjkFont.%s 有中文文案", (value) => {
    expect(enums.cjkFont).toHaveProperty(value);
  });
});

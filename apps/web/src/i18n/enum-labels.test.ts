import { describe, expect, it } from "vitest";
import {
  CONTAINER_KIND_LABELS,
  CONTAINER_STATUS_LABELS,
  CYCLE_LABELS,
  HEALTH_LABELS,
  HUMAN_KIND_LABELS,
  MANUAL_STATUS_LABELS,
  TASK_STATUS_LABELS,
} from "@kanban-hub/core/labels";
import enums from "../../messages/zh-CN/enums.json";

// 网页从 enums.json 取枚举文案，kh 与导出从 core 的 labels 取；两边必须逐项一致，
// 否则同一个取值在网页和命令行里会显示成不同的中文名
describe("enums.json 与 core 的枚举中文名一致", () => {
  const groups: [name: string, json: Record<string, string>, core: Record<string, string>][] = [
    ["cycle", enums.cycle, CYCLE_LABELS],
    ["health", enums.health, HEALTH_LABELS],
    ["taskStatus", enums.taskStatus, TASK_STATUS_LABELS],
    ["humanKind", enums.humanKind, HUMAN_KIND_LABELS],
    ["manualStatus", enums.manualStatus, MANUAL_STATUS_LABELS],
    ["containerKind", enums.containerKind, CONTAINER_KIND_LABELS],
  ];

  it.each(groups)("%s 逐项相同", (_name, json, core) => {
    expect(json).toEqual(core);
  });

  // 网页的 containerStatus 只有推算出的三态（手动状态走 manualStatus），逐项与 core 比较
  it("containerStatus 的每一项与 core 相同", () => {
    for (const [value, label] of Object.entries(enums.containerStatus)) {
      expect(label).toBe(CONTAINER_STATUS_LABELS[value as keyof typeof CONTAINER_STATUS_LABELS]);
    }
  });
});

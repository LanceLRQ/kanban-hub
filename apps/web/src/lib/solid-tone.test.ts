import { describe, expect, it } from "vitest";
import { HEALTHS, HUMAN_KINDS, TASK_STATUSES } from "@kanban-hub/core/schema";
import { HEALTH_TONE, HUMAN_TONE, statusTone } from "./solid-tone";

describe("实心标签的语义色", () => {
  it("每种健康度、待你处理都指向同名的语义色 token", () => {
    for (const h of HEALTHS) expect(HEALTH_TONE[h]).toBe(`kh-solid [--solid-tone:var(--health-${h.replaceAll("_", "-")})]`);
    for (const k of HUMAN_KINDS) expect(HUMAN_TONE[k]).toBe(`kh-solid [--solid-tone:var(--human-${k})]`);
  });

  it("进行中、待验收、已完成、挂起是实心；其余状态不做实心", () => {
    expect(statusTone("in_progress")).toBe("kh-solid [--solid-tone:var(--task-in-progress)]");
    expect(statusTone("review")).toBe("kh-solid [--solid-tone:var(--task-review)]");
    expect(statusTone("done")).toBe("kh-solid [--solid-tone:var(--task-done)]");
    expect(statusTone("suspended")).toBe("kh-solid [--solid-tone:var(--task-suspended)]");
    const solid = new Set(["in_progress", "review", "done", "suspended"]);
    for (const s of [...TASK_STATUSES, "backlog"] as const) {
      if (!solid.has(s)) expect(statusTone(s)).toBeNull();
    }
  });
});

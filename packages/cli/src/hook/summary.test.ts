import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@kanban-hub/core/schema";
import type { PullResult } from "../sync/pull";
import type { StatusView, StatusViewContainer, StatusViewTask } from "../status/view";
import { HOOK_LIMITS } from "./exit";
import { RULE_LINES, renderSessionSummary, type SessionSummaryInput } from "./summary";

function task(n: number, status: TaskStatus, overrides: Partial<StatusViewTask> = {}): StatusViewTask {
  return {
    id: `t${String(n).padStart(9, "0")}`,
    ref: `#t${String(n).padStart(3, "0")}`,
    code: String(n),
    title: `条目 ${n}`,
    status,
    suspendReason: null,
    human: null,
    group: null,
    note: "",
    dueDate: null,
    docRefs: [],
    checklist: { done: 0, total: 0 },
    ...overrides,
  };
}

function container(code: string, tasks: StatusViewTask[]): StatusViewContainer {
  return {
    id: `c${code.padStart(9, "0")}`,
    code,
    refLabel: code,
    kind: "phase",
    title: `阶段 ${code}`,
    status: "in_progress",
    progress: { done: 0, total: tasks.length },
    openCount: tasks.length,
    targetVersion: null,
    targetDate: null,
    manualReason: null,
    doneAt: null,
    tasks,
  };
}

function view(containers: StatusViewContainer[], inbox: StatusView["inbox"] = []): StatusView {
  return {
    project: {
      id: "p000000001",
      name: "示例项目",
      cycle: "development",
      health: "on_track",
      focus: "完成 hook",
      stale: false,
      idleDays: 0,
      lastEventAt: null,
      progress: { done: 3, total: 10 },
    },
    location: null,
    containers,
    inbox,
  };
}

function emptyPull(overrides: Partial<PullResult> = {}): PullResult {
  return {
    created: [],
    overwritten: [],
    merged: [],
    conflicts: [],
    stale: [],
    skippedTracked: [],
    skippedUnsafe: [],
    skippedChanged: [],
    timedOut: false,
    fromMachineIds: [],
    ...overrides,
  };
}

function render(overrides: Partial<SessionSummaryInput> = {}): string {
  return renderSessionSummary({
    view: view([container("P1", [task(1, "in_progress"), task(2, "review"), task(3, "todo"), task(4, "done")])]),
    pull: { kind: "off" },
    conflicts: [],
    ...overrides,
  });
}

describe("renderSessionSummary", () => {
  it("第一行是项目名、周期、健康度、进度，第二行是焦点", () => {
    const lines = render().split("\n");
    expect(lines[0]).toContain("示例项目");
    expect(lines[0]).toContain("开发期");
    expect(lines[0]).toContain("正常");
    expect(lines[0]).toContain("3/10");
    expect(lines[1]).toBe("焦点：完成 hook");
  });

  it("只列进行中和复核中的任务，带短 ID 与“容器/任务”编号；待开始、已完成不列", () => {
    const text = render();
    expect(text).toContain("#t001 P1/1 条目 1");
    expect(text).toContain("#t002 P1/2 条目 2");
    expect(text).not.toContain("条目 3");
    expect(text).not.toContain("条目 4");
  });

  it("列出待你处理的事项，结尾有不超过 3 行的上报规则、指向 kanban-hub skill", () => {
    const text = render({
      view: view(
        [container("P1", [task(1, "in_progress")])],
        [{ ref: "#t001", taskTitle: "条目 1", kind: "decision", note: "选方案", container: "P1" }],
      ),
    });
    expect(text).toContain("待你处理");
    expect(text).toContain("#t001 条目 1（待决策：选方案）");
    const lines = text.trimEnd().split("\n");
    const ruleStart = lines.findIndex((l) => l.startsWith("上报规则"));
    expect(ruleStart).toBeGreaterThan(0);
    expect(lines.length - ruleStart).toBeLessThanOrEqual(3);
    expect(lines.at(-1)).toContain("kanban-hub skill");
  });

  it("大看板：不超过 40 行、4000 字符，各段超出上限时写“另有 N 项”", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => task(i + 1, "in_progress", { human: { kind: "action", note: "处理" } }));
    const inbox = tasks.slice(0, 20).map((t) => ({ ref: t.ref, taskTitle: t.title, kind: "action" as const, note: "处理", container: "P1" }));
    const conflicts = Array.from({ length: 20 }, (_, i) => ({ path: `notes/c${i}.md`, machineName: "机器B" }));
    const text = renderSessionSummary({
      view: view([container("P1", tasks)], inbox),
      pull: { kind: "done", result: emptyPull({ created: ["a"], timedOut: true }) },
      conflicts,
    });
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(HOOK_LIMITS.summaryMaxLines);
    expect(text.length).toBeLessThanOrEqual(HOOK_LIMITS.summaryMaxChars);
    expect(text).toContain("另有 38 项，执行 kh status 查看");
    expect(text).toContain("另有 12 项，执行 kh status 查看");
    expect(text).toContain("另有 12 项，执行 kh conflicts 查看");
    // 规则提示没有被截掉
    expect(lines.at(-1)).toContain("kanban-hub skill");
  });

  it("超长标题也不会让全文超过 4000 字符", () => {
    const long = "很长".repeat(500);
    const tasks = Array.from({ length: 12 }, (_, i) => task(i + 1, "in_progress", { title: long }));
    const text = render({ view: view([container("P1", tasks)]) });
    expect(text.length).toBeLessThanOrEqual(HOOK_LIMITS.summaryMaxChars);
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(HOOK_LIMITS.summaryMaxLines);
  });

  describe("自动拉取", () => {
    it("pull.auto 关闭、其他机器都还没有同步过、没有变化：都不写拉取这一行", () => {
      for (const pull of [
        { kind: "off" },
        { kind: "none" },
        { kind: "done", result: emptyPull({ stale: ["x"], skippedTracked: ["y"] }) },
      ] as SessionSummaryInput["pull"][]) {
        expect(render({ pull })).not.toContain("自动拉取");
      }
    });

    it("有变化时只列不为 0 的项", () => {
      const text = render({ pull: { kind: "done", result: emptyPull({ created: ["a"], overwritten: ["b", "c"], conflicts: ["d"] }) } });
      expect(text).toContain("自动拉取：新建 1、覆盖 2、冲突 1\n");
    });

    it("截止时间到了：加一行超时提示，指向 kh pull", () => {
      const text = render({ pull: { kind: "done", result: emptyPull({ timedOut: true }) } });
      expect(text).toContain("自动拉取超时，已停止；稍后执行 kh pull");
    });

    it("同步锁被占用", () => {
      expect(render({ pull: { kind: "busy" } })).toContain("另一个同步或拉取正在进行，本次没有自动拉取");
    });

    it("其他失败：写出原因（只取第一行），已完成的部分照常计入", () => {
      const text = render({ pull: { kind: "failed", message: "快照文件不存在\n第二行", partial: emptyPull({ created: ["a"] }) } });
      expect(text).toContain("自动拉取：新建 1\n");
      expect(text).toContain("自动拉取失败：快照文件不存在；稍后执行 kh pull");
      expect(text).not.toContain("第二行");
    });
  });

  it("有未解决的冲突：列出路径、对方机器名、kh conflicts show，并提示先处理冲突", () => {
    const text = render({ conflicts: [{ path: "notes/a b.md", machineName: "机器B" }] });
    expect(text).toContain("先处理冲突再开始任务");
    expect(text).toContain("notes/a b.md");
    expect(text).toContain("机器B");
    expect(text).toContain("kh conflicts show 'notes/a b.md'");
  });

  it("上报规则的每一行都完整输出，没有被单行上限截断", () => {
    const text = render();
    for (const line of RULE_LINES) {
      expect(line.endsWith("…")).toBe(false);
      expect(text).toContain(`${line}\n`);
    }
  });

  it("没有冲突时不提冲突", () => {
    expect(render()).not.toContain("冲突");
  });
});

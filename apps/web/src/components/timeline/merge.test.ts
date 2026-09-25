import { describe, expect, it } from "vitest";
import type { TimelineDay, TimelineItem } from "@/server/views/timeline";
import { mergeTimelineDays } from "./merge";

function item(id: string, text: string): TimelineItem {
  return {
    id,
    time: "10:00",
    group: "log",
    description: { key: "log", values: { text } },
    projectId: "p1",
    projectName: "kanban-hub",
    actor: { primary: "Lance", secondary: null },
  };
}

function day(key: string, items: TimelineItem[]): TimelineDay {
  return { key, heading: key, items };
}

describe("mergeTimelineDays", () => {
  it("追加更早的一页（incomingFirst=false）：新的一天排到已有天数之后，按天 key 整体倒序排列", () => {
    const prev = [day("2026-09-24", [item("a", "A")])];
    const incoming = [day("2026-09-23", [item("b", "B")])];

    const merged = mergeTimelineDays(prev, incoming, false);

    expect(merged.map((d) => d.key)).toEqual(["2026-09-24", "2026-09-23"]);
  });

  it("追加更早的一页：同一天已有的事件保留在前，新事件接在后面，按 ID 去重", () => {
    const prev = [day("2026-09-24", [item("a", "A")])];
    const incoming = [day("2026-09-24", [item("a", "A"), item("b", "B")])];

    const merged = mergeTimelineDays(prev, incoming, false);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("SSE 刷新合并最新一页（incomingFirst=true）：新事件排到已知事件之前，按 ID 去重", () => {
    const prev = [day("2026-09-24", [item("a", "A")])];
    const incoming = [day("2026-09-24", [item("b", "B"), item("a", "A")])];

    const merged = mergeTimelineDays(prev, incoming, true);

    expect(merged[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("刷新时已加载更多的天数（不在新首页范围内）原样保留", () => {
    const prev = [day("2026-09-24", [item("a", "A")]), day("2026-09-20", [item("z", "Z")])];
    const incoming = [day("2026-09-24", [item("a", "A"), item("b", "B")])];

    const merged = mergeTimelineDays(prev, incoming, true);

    expect(merged.map((d) => d.key)).toEqual(["2026-09-24", "2026-09-20"]);
    expect(merged[1]!.items.map((i) => i.id)).toEqual(["z"]);
  });

  it("空的已有状态直接采用新页", () => {
    const incoming = [day("2026-09-24", [item("a", "A")])];
    expect(mergeTimelineDays([], incoming, true)).toEqual(incoming);
  });
});

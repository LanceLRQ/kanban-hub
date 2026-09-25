import { describe, expect, it } from "vitest";
import type { TimelineDay, TimelineItem, TimelinePage } from "@/server/views/timeline";
import { mergeTimelineDays, reconcileRefresh, type TimelineRefreshState } from "./merge";

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

function day(key: string, items: TimelineItem[], heading = key): TimelineDay {
  return { key, heading, items };
}

const EMPTY_FILTER_OPTIONS = { projects: [], groups: [], actors: [] };

function page(days: TimelineDay[], nextCursor: TimelinePage["nextCursor"] = null): TimelinePage {
  return { days, nextCursor, filterOptions: EMPTY_FILTER_OPTIONS };
}

function cursor(id: string) {
  return { ts: "2026-09-24T00:00:00.000Z", id };
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

  it("SSE 刷新时，同一天的标题以刷新结果为准（例如跨过午夜后不再显示旧的“今天”）", () => {
    const prev = [day("2026-09-24", [item("a", "A")], "今天 · 09-24")];
    const incoming = [day("2026-09-24", [item("a", "A")], "昨天 · 09-24")];

    const merged = mergeTimelineDays(prev, incoming, true);

    expect(merged[0]!.heading).toBe("昨天 · 09-24");
  });

  it("SSE 刷新时，已知事件的内容以刷新结果为准（例如任务改名后的描述）", () => {
    const prev = [day("2026-09-24", [item("a", "旧标题")])];
    const incoming = [day("2026-09-24", [item("a", "新标题")])];

    const merged = mergeTimelineDays(prev, incoming, true);

    expect(merged[0]!.items).toEqual([item("a", "新标题")]);
  });
});

describe("reconcileRefresh", () => {
  function state(partial: Partial<TimelineRefreshState>): TimelineRefreshState {
    return { days: [], cursor: null, loadedMore: false, ...partial };
  }

  it("没有“加载更多”过：合并新首页，游标换成新首页的游标", () => {
    const prev = state({ days: [day("2026-09-24", [item("a", "A")])], cursor: cursor("e0000000001"), loadedMore: false });
    const incoming = page([day("2026-09-24", [item("a", "A"), item("b", "B")])], cursor("e0000000002"));

    const result = reconcileRefresh(prev, incoming);

    expect(result.loadedMore).toBe(false);
    expect(result.cursor).toEqual(cursor("e0000000002"));
    expect(result.days[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("已经“加载更多”过：合并新首页，但游标保持不变，避免“加载更多”重新取到已加载的页", () => {
    const prev = state({ days: [day("2026-09-24", [item("a", "A")])], cursor: cursor("e0000000001"), loadedMore: true });
    const incoming = page([day("2026-09-24", [item("a", "A"), item("b", "B")])], null);

    const result = reconcileRefresh(prev, incoming);

    expect(result.loadedMore).toBe(true);
    expect(result.cursor).toEqual(cursor("e0000000001"));
    expect(result.days[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("已加载内容非空，且新首页与已加载事件完全不重叠（出现断层）：整体替换为新页，重置游标和加载更多状态", () => {
    const prev = state({ days: [day("2026-09-20", [item("z", "Z")])], cursor: null, loadedMore: true });
    const incoming = page([day("2026-09-24", [item("a", "A")])], cursor("e0000000002"));

    const result = reconcileRefresh(prev, incoming);

    expect(result).toEqual({ days: incoming.days, cursor: cursor("e0000000002"), loadedMore: false });
  });
});

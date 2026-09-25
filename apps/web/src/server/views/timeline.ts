/**
 * 时间线视图：跨项目 `/timeline` 与项目内 `/p/[id]/timeline` 共用同一个构建函数。
 * 按天分组、三组筛选（项目、事件类型分组、操作者）、分页游标；事件描述与操作者的显示
 * 复用 lib/events.ts、lib/actor.ts 的纯函数。枚举中文名（事件描述里用到的）和分组名、
 * “网页”操作者名这些文案，都由调用方（next-intl）注入，见 TimelineLabels。
 */
import { decodeEventCursor } from "@kanban-hub/core/api";
import { idSchema } from "@kanban-hub/core/ids";
import type { Board, Event } from "@kanban-hub/core/schema";
import { actorLabel, type ActorLabel } from "@/lib/actor";
import { describeEvent, EVENT_GROUPS, eventGroupOf, sortEventsForDisplay, type EnumLabelFn, type EventDescription, type EventGroup } from "@/lib/events";
import { dayKey, formatDayHeading, formatTime, serverTimeZone } from "@/lib/time";
import type { Services } from "@/server/services";
import type { EventCursor } from "@/server/store/store";

/** 每页事件数 */
export const TIMELINE_PAGE_SIZE = 50;

export interface TimelineFilters {
  projectId?: string;
  /** 事件类型分组（EVENT_GROUPS 的键），换成类型列表交给 store 按类型筛选 */
  group?: EventGroup;
  /** "web" 或某台机器的 ID */
  actor?: string;
}

export interface TimelineLabels {
  /** describeEvent 用到的枚举中文名，见 lib/events.ts 的 EnumLabelFn */
  enumLabel: EnumLabelFn;
  /** 字段被清空时的占位文案（events.json 的 common.none），透传给 describeEvent */
  noneLabel: string;
  /** 类型筛选分组的中文名（enums.json 的 eventTypeGroup） */
  groupLabel: (group: EventGroup) => string;
  /** 操作者筛选里“网页”一项的中文名 */
  webActorLabel: string;
}

export interface TimelineItem {
  id: string;
  time: string;
  /** 类型筛选分组，供列表渲染分组标签用（任务/容器/项目/日志/文档/导入） */
  group: EventGroup;
  description: EventDescription;
  projectId: string;
  projectName: string;
  actor: ActorLabel;
}

export interface TimelineDay {
  /** YYYY-MM-DD，按服务端时区 */
  key: string;
  heading: string;
  items: TimelineItem[];
}

export interface TimelineFilterOption {
  value: string;
  label: string;
}

export interface TimelineFilterOptions {
  /** 全部项目，归档的排在最后 */
  projects: TimelineFilterOption[];
  /** EVENT_GROUPS 的六个分组 */
  groups: TimelineFilterOption[];
  /** "web" 一项，加上全部机器（包括已吊销的） */
  actors: TimelineFilterOption[];
}

export interface TimelinePage {
  days: TimelineDay[];
  nextCursor: EventCursor | null;
  filterOptions: TimelineFilterOptions;
}

function typesOf(group: EventGroup | undefined): Event["type"][] | undefined {
  return group ? [...EVENT_GROUPS[group]] : undefined;
}

/**
 * 构建一页时间线。`cursor` 省略时取最新一页。
 *
 * 分页游标必须取自 store 自身的排序（(ts, id) 降序）截断处，不能用下面按事件类型重排后的
 * 顺序去算：重排（sortEventsForDisplay）只用来决定同一页内、同一时刻多条事件的显示顺序，
 * 用它算游标会在“同一时刻多条事件”恰好跨页时漏掉或重复事件。
 */
export async function buildTimelinePage(
  services: Services,
  filters: TimelineFilters,
  cursor: EventCursor | undefined,
  now: Date,
  labels: TimelineLabels,
): Promise<TimelinePage> {
  const fetched = await services.store.listEvents({
    projectId: filters.projectId,
    actor: filters.actor,
    types: typesOf(filters.group),
    before: cursor,
    limit: TIMELINE_PAGE_SIZE + 1,
  });
  const hasMore = fetched.length > TIMELINE_PAGE_SIZE;
  const pageEventsRaw = (hasMore ? fetched.slice(0, TIMELINE_PAGE_SIZE) : fetched) as unknown as Event[];
  const last = pageEventsRaw.at(-1);
  const nextCursor: EventCursor | null = hasMore && last ? { ts: last.ts, id: last.id } : null;

  const tz = serverTimeZone();
  const days: TimelineDay[] = [];
  const byKey = new Map<string, TimelineDay>();
  for (const event of sortEventsForDisplay(pageEventsRaw)) {
    const key = dayKey(event.ts, tz);
    let day = byKey.get(key);
    if (!day) {
      day = { key, heading: formatDayHeading(event.ts, tz, now), items: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.items.push(buildItem(services, event, tz, labels));
  }

  return { days, nextCursor, filterOptions: buildFilterOptions(services, labels) };
}

function buildItem(services: Services, event: Event, tz: string, labels: TimelineLabels): TimelineItem {
  const project = services.store.getProject(event.projectId);
  const board = services.store.getBoard(event.projectId);
  // store 返回的是 DeepReadonly 快照；describeEvent 按可写类型声明参数，这里只读它、不修改，
  // 用类型断言桥接结构性只读数组带来的赋值不兼容（与 project-header.ts 的做法一致）
  const boardForDescribe = (board as unknown as Pick<Board, "containers" | "tasks">) ?? { containers: [], tasks: [] };
  const projectName = project?.name ?? event.projectId;
  const description = describeEvent(event, { board: boardForDescribe, projectName, enumLabel: labels.enumLabel, noneLabel: labels.noneLabel });
  const actor = actorLabel(event.actor, {
    userName: (id) => services.store.auth.getUser(id)?.name ?? id,
    machineName: (id) => services.store.auth.getMachine(id)?.name ?? id,
  });

  return {
    id: event.id,
    time: formatTime(event.ts, tz),
    group: eventGroupOf(event.type),
    description,
    projectId: event.projectId,
    projectName,
    actor,
  };
}

function buildFilterOptions(services: Services, labels: TimelineLabels): TimelineFilterOptions {
  const projects = [...services.store.listProjects()]
    .map((p) => ({ id: p.id, name: p.name, archived: p.cycle === "archived" }))
    .sort((a, b) => Number(a.archived) - Number(b.archived))
    .map(({ id, name }) => ({ value: id, label: name }));

  const groups = (Object.keys(EVENT_GROUPS) as EventGroup[]).map((group) => ({ value: group, label: labels.groupLabel(group) }));

  const actors: TimelineFilterOption[] = [
    { value: "web", label: labels.webActorLabel },
    ...services.store.auth.listMachines().map((m) => ({ value: m.id, label: m.name })),
  ];

  return { projects, groups, actors };
}

// ---------- 查询参数解析：project / type / actor，都放在 URL 查询参数里 ----------

const GROUP_KEYS = new Set(Object.keys(EVENT_GROUPS) as EventGroup[]);

/**
 * 单个字段的校验：不合法、或引用不存在的项目/机器时返回 `undefined`（不区分“缺省”和“不合法”，
 * 两种情况调用方都当作没有这个筛选处理）。`parseTimelineFilters`（URL 查询参数，宽松：忽略
 * 不合法值）和 `validateTimelineFilters`（Server Action 的入参，严格：只要提供了就必须合法，
 * 否则整体拒绝）共用这三个函数，保证判断标准只有一处。
 */
function normalizeGroup(value: unknown): EventGroup | undefined {
  return typeof value === "string" && GROUP_KEYS.has(value as EventGroup) ? (value as EventGroup) : undefined;
}

function normalizeProjectId(services: Services, value: unknown): string | undefined {
  if (typeof value !== "string" || !idSchema.safeParse(value).success) return undefined;
  return services.store.getProject(value) ? value : undefined;
}

function normalizeActor(services: Services, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "web") return "web";
  if (!idSchema.safeParse(value).success) return undefined;
  return services.store.auth.getMachine(value) ? value : undefined;
}

export interface TimelineFilterContext {
  /** 项目内时间线固定本项目时传入；跨项目时间线省略，从查询参数里取 */
  fixedProjectId?: string;
}

/**
 * 解析 `/timeline`、`/p/[id]/timeline` 的查询参数（project、type、actor）。
 * 参数缺省、不合法、或引用不存在的项目/机器时一律忽略，不报错——这是给
 * 真实页面导航用的宽松策略，一个过期的书签链接不应该让页面出错，只是筛选条件被清空。
 */
export function parseTimelineFilters(
  services: Services,
  searchParams: Record<string, string | string[] | undefined>,
  ctx: TimelineFilterContext = {},
): TimelineFilters {
  const get = (key: string): unknown => {
    const value = searchParams[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    projectId: ctx.fixedProjectId ?? normalizeProjectId(services, get("project")),
    group: normalizeGroup(get("type")),
    actor: normalizeActor(services, get("actor")),
  };
}

/**
 * 校验“加载更多” Server Action 收到的 `filters`：这是一次不受 TypeScript 类型约束的 RPC
 * 调用，客户端（或绕过 UI 直接发请求的调用方）可以传任意形状的值，所以这里对 `raw` 本身的
 * 类型也不做任何假设。策略比 `parseTimelineFilters` 严格：只要某个字段被提供了但不合法
 * （类型不对、不是 `EVENT_GROUPS` 的键、引用的项目/机器不存在），就整体判定失败并返回
 * `null`，调用方据此拒绝这次请求（不能像页面导航那样“忽略掉就当没传”，那样会把一次弱校验
 * 伪装成正常的“无筛选”请求）。字段完全没提供（`undefined`）则视为没有这个筛选，合法。
 */
export function validateTimelineFilters(services: Services, raw: unknown): TimelineFilters | null {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const result: TimelineFilters = {};

  if (candidate.projectId !== undefined) {
    const projectId = normalizeProjectId(services, candidate.projectId);
    if (projectId === undefined) return null;
    result.projectId = projectId;
  }
  if (candidate.group !== undefined) {
    const group = normalizeGroup(candidate.group);
    if (group === undefined) return null;
    result.group = group;
  }
  if (candidate.actor !== undefined) {
    const actor = normalizeActor(services, candidate.actor);
    if (actor === undefined) return null;
    result.actor = actor;
  }
  return result;
}

/**
 * 校验“加载更多”收到的分页游标：必须是 `encodeEventCursor` 编码出的字符串，格式或字段不对
 * （`ts` 不是合法时间戳、`id` 不是合法 ID）时返回 `null`，不向调用方抛出 `decodeEventCursor`
 * 的 `KhError`。分页游标没有“忽略掉当作没传”的合理退路（那样等于从头重新加载，语义上不是
 * “加载更多”），所以不合法就直接判定失败。
 */
export function parseTimelineCursor(raw: unknown): EventCursor | null {
  if (typeof raw !== "string") return null;
  try {
    return decodeEventCursor(raw);
  } catch {
    return null;
  }
}

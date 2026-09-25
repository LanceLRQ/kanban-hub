/**
 * 总览页的数据视图：跨项目“待你处理”收件箱 + 项目卡片。
 *
 * 事件描述、操作者显示都复用 lib/events.ts、lib/actor.ts 的纯函数；enumLabel 由调用方注入
 * （页面用 next-intl 的 getTranslations("enums") 构造，测试用 createTranslator 加载真实
 * messages/zh-CN/enums.json），本文件不直接依赖 next-intl。
 */
import { isStale, projectProgress, type Progress } from "@kanban-hub/core/derive";
import type { Board, Cycle, Event, Health, HumanKind, Project, Task } from "@kanban-hub/core/schema";
import { actorLabel, type ActorLabel } from "@/lib/actor";
import { type EnumLabelFn, type EventDescription, describeEvent } from "@/lib/events";
import { locationSummary, primaryLocation, type LocationSummary } from "@/lib/location";
import { taskShortRef } from "@/lib/refs";
import { serverTimeZone } from "@/lib/time";
import type { Services } from "@/server/services";
import type { Store } from "@/server/store/store";

const DAY_MS = 86_400_000;

/** 收件箱三组固定的顺序 */
const INBOX_KINDS: readonly HumanKind[] = ["decision", "verify", "action"];

export interface OverviewInboxItem {
  projectId: string;
  projectName: string;
  taskId: string;
  ref: string;
  text: string;
  updatedAt: string;
}

export interface OverviewInboxGroup {
  kind: HumanKind;
  items: OverviewInboxItem[];
}

export interface ProjectCardLastEvent {
  description: EventDescription;
  actor: ActorLabel;
  ts: string;
}

export interface ProjectCardView {
  id: string;
  name: string;
  cycle: Cycle;
  health: Health;
  focus: string;
  progress: Progress;
  lastEvent: ProjectCardLastEvent | null;
  location: LocationSummary | null;
  stale: { days: number } | null;
}

export interface OverviewView {
  inbox: OverviewInboxGroup[];
  projects: ProjectCardView[];
  timeZone: string;
}

/**
 * 收件箱条目的正文：human.note 非空时用它，否则退回任务标题。正常情况下 human.note 不可能是
 * 空串（humanFlagSchema 要求 min(1)），这里只是防御性兜底，见测试。
 */
export function inboxItemText(task: Pick<Task, "human" | "title">): string {
  const note = task.human?.note.trim() ?? "";
  return note !== "" ? task.human!.note : task.title;
}

/** 收件箱只收 human 不为空、且状态不是已完成或已取消的任务 */
function isInboxTask(task: Pick<Task, "human" | "status">): boolean {
  return task.human !== null && task.status !== "done" && task.status !== "cancelled";
}

/** 项目的收件箱条目，附带各自的 human.kind，供调用方按组归类 */
function collectInboxItems(project: Pick<Project, "id" | "name">, board: Pick<Board, "tasks">): { kind: HumanKind; item: OverviewInboxItem }[] {
  const result: { kind: HumanKind; item: OverviewInboxItem }[] = [];
  for (const task of board.tasks) {
    if (!isInboxTask(task)) continue;
    result.push({
      kind: task.human!.kind,
      item: {
        projectId: project.id,
        projectName: project.name,
        taskId: task.id,
        ref: taskShortRef(board as unknown as Board, task.id),
        text: inboxItemText(task),
        updatedAt: task.updatedAt,
      },
    });
  }
  return result;
}

export interface LastEventContext {
  board: Pick<Board, "containers" | "tasks">;
  projectName: string;
  enumLabel: EnumLabelFn;
  /** 字段被清空时的占位文案（events.json 的 common.none），透传给 describeEvent */
  noneLabel: string;
  userName: (id: string) => string;
  machineName: (id: string) => string;
}

/** 项目卡片的“最近活动”：传入 undefined（没有任何事件）时为 null，供单独测试这一分支 */
export function resolveLastEvent(event: Event | undefined, ctx: LastEventContext): ProjectCardLastEvent | null {
  if (!event) return null;
  return {
    description: describeEvent(event as unknown as Event, {
      board: ctx.board as unknown as Board,
      projectName: ctx.projectName,
      enumLabel: ctx.enumLabel,
      noneLabel: ctx.noneLabel,
    }),
    actor: actorLabel(event.actor, { userName: ctx.userName, machineName: ctx.machineName }),
    ts: event.ts,
  };
}

function nameOf(store: Store, kind: "user" | "machine", id: string): string {
  if (kind === "user") return store.auth.getUser(id)?.name ?? id;
  return store.auth.getMachine(id)?.name ?? id;
}

export async function buildOverview(services: Services, now: Date, enumLabel: EnumLabelFn, noneLabel: string): Promise<OverviewView> {
  const { store } = services;
  const projects = store.listProjects();

  const inboxByKind = new Map<HumanKind, OverviewInboxItem[]>(INBOX_KINDS.map((kind) => [kind, []]));
  const rows: { card: ProjectCardView; lastEventAt: string | null }[] = [];

  for (const project of projects) {
    const board = store.getBoard(project.id);
    if (!board) continue;

    for (const { kind, item } of collectInboxItems(project, board as unknown as Board)) {
      inboxByKind.get(kind)!.push(item);
    }

    const lastEventAt = store.getLastEventAt(project.id);
    const [latest] = await store.listEvents({ projectId: project.id, limit: 1 });

    const lastEvent = resolveLastEvent(latest as unknown as Event | undefined, {
      board: board as unknown as Board,
      projectName: project.name,
      enumLabel,
      noneLabel,
      userName: (id) => nameOf(store, "user", id),
      machineName: (id) => nameOf(store, "machine", id),
    });

    const stale = isStale(project, lastEventAt, now, services.staleDays);
    const idleDays = Math.floor((now.getTime() - Date.parse(lastEventAt ?? project.createdAt)) / DAY_MS);

    const loc = primaryLocation(project as unknown as Project);
    const location = loc ? locationSummary(loc, nameOf(store, "machine", loc.machineId), now) : null;

    rows.push({
      card: {
        id: project.id,
        name: project.name,
        cycle: project.cycle,
        health: project.health,
        focus: project.focus,
        progress: projectProgress(board as unknown as Board),
        lastEvent,
        location,
        stale: stale ? { days: idleDays } : null,
      },
      lastEventAt,
    });
  }

  for (const group of inboxByKind.values()) group.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  rows.sort((a, b) => compareRows(a, b));

  return {
    inbox: INBOX_KINDS.map((kind) => ({ kind, items: inboxByKind.get(kind)! })),
    projects: rows.map((r) => r.card),
    timeZone: serverTimeZone(),
  };
}

/** 排序：未归档按最近事件时间倒序（没有事件的排在同组最后）；归档的整体排在最后 */
function compareRows(a: { card: ProjectCardView; lastEventAt: string | null }, b: { card: ProjectCardView; lastEventAt: string | null }): number {
  const archivedA = a.card.cycle === "archived";
  const archivedB = b.card.cycle === "archived";
  if (archivedA !== archivedB) return archivedA ? 1 : -1;
  if (a.lastEventAt === null && b.lastEventAt === null) return 0;
  if (a.lastEventAt === null) return 1;
  if (b.lastEventAt === null) return -1;
  return Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt);
}

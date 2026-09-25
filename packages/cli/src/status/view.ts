/**
 * 构建 kh status 的视图：一个不做 IO、不读 CliContext 的纯函数，只依赖项目详情、
 * 本机 machineId 和当前时间。M6 的会话摘要会直接复用 buildStatusView，
 * 所以这里不能掺进任何文件读写或网络调用（见任务简报“行为要点”）。
 */
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import { checklistProgress, progressOf, summarizeContainer } from "@kanban-hub/core/derive";
import type { ContainerStatus, Progress } from "@kanban-hub/core/derive";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import type { Container, ContainerKind, Cycle, Health, HumanFlag, TaskStatus } from "@kanban-hub/core/schema";

const DAY_MS = 86_400_000;

export interface StatusViewTask {
  id: string;
  /** "#短ID"：整个看板范围内的最短唯一前缀 */
  ref: string;
  code: string | null;
  title: string;
  status: TaskStatus;
  suspendReason: string | null;
  human: HumanFlag | null;
  group: string | null;
  note: string;
  dueDate: string | null;
  docRefs: string[];
  checklist: Progress;
}

export interface StatusViewContainer {
  id: string;
  code: string | null;
  kind: ContainerKind;
  title: string;
  /** 用 core 的 summarizeContainer 推算；杂项容器为 null */
  status: ContainerStatus | null;
  progress: Progress;
  /** 未完成（既不是已完成也不是已取消）的任务数，来自 summarizeContainer；杂项容器只显示这一项（规格 5.4） */
  openCount: number;
  targetVersion: string | null;
  targetDate: string | null;
  manualReason: string | null;
  /** 容器完成日期，来自 summarizeContainer 的 completedAt */
  doneAt: string | null;
  tasks: StatusViewTask[];
}

export interface StatusViewInboxItem {
  ref: string;
  taskTitle: string;
  kind: HumanFlag["kind"];
  note: string;
  /** 所属容器的显示标签：优先用编号，杂项容器固定是 "misc"，否则退回标题 */
  container: string;
}

export interface StatusViewLocation {
  path: string;
  lastSyncAt: string | null;
}

export interface StatusViewProject {
  id: string;
  name: string;
  cycle: Cycle;
  health: Health;
  focus: string;
  stale: boolean;
  /**
   * 距最近一条事件（没有事件时用项目创建时间）的整天数，向下取整，非负。
   * 字段名特意不叫 staleDays：这只是“闲置了多少天”的事实，不是 KH_STALE_DAYS 阈值本身，
   * 两者容易混淆（第 1 轮修复 Ruling 10）。
   */
  idleDays: number;
  lastEventAt: string | null;
  progress: Progress;
}

export interface StatusView {
  project: StatusViewProject;
  /** 本机（machineId）登记的位置；没有登记时为 null */
  location: StatusViewLocation | null;
  /** 按 order 排序，杂项容器固定放在最后 */
  containers: StatusViewContainer[];
  /** 全部带“待你处理”标记的任务，按容器顺序、容器内按任务顺序收集 */
  inbox: StatusViewInboxItem[];
}

export interface BuildStatusViewOptions {
  machineId: string;
  now: Date;
}

/** 容器在“待你处理”里的显示标签：有编号用编号，杂项固定 misc，否则退回标题 */
function containerLabel(container: Container): string {
  if (container.code !== null) return container.code;
  return container.kind === "misc" ? "misc" : container.title;
}

/** 杂项容器固定排最后，其余按 order 升序（misc 的 order 是 0，不能直接按 order 排） */
function sortContainers(containers: readonly Container[]): Container[] {
  const misc: Container[] = [];
  const rest: Container[] = [];
  for (const c of containers) (c.kind === "misc" ? misc : rest).push(c);
  rest.sort((a, b) => a.order - b.order);
  return [...rest, ...misc];
}

export function buildStatusView(detail: ProjectDetailResponse, opts: BuildStatusViewOptions): StatusView {
  const { project, board, lastEventAt, stale } = detail;
  const refPrefixes = shortIdPrefixes(board.tasks.map((t) => t.id));
  const refOf = (taskId: string): string => `#${refPrefixes.get(taskId) ?? taskId}`;

  const sortedContainers = sortContainers(board.containers);

  const containers: StatusViewContainer[] = sortedContainers.map((container) => {
    const summary = summarizeContainer(container, board.tasks);
    const tasks = board.tasks
      .filter((t) => t.containerId === container.id)
      .sort((a, b) => a.order - b.order)
      .map(
        (task): StatusViewTask => ({
          id: task.id,
          ref: refOf(task.id),
          code: task.code,
          title: task.title,
          status: task.status,
          suspendReason: task.suspendReason,
          human: task.human,
          group: task.group,
          note: task.note,
          dueDate: task.dueDate,
          docRefs: task.docRefs,
          checklist: checklistProgress(task.checklist),
        }),
      );
    return {
      id: container.id,
      code: container.code,
      kind: container.kind,
      title: container.title,
      status: summary.status,
      progress: summary.progress,
      openCount: summary.openCount,
      targetVersion: container.targetVersion,
      targetDate: container.targetDate,
      manualReason: container.manualReason,
      doneAt: summary.completedAt,
      tasks,
    };
  });

  const inbox: StatusViewInboxItem[] = [];
  for (const container of sortedContainers) {
    const label = containerLabel(container);
    const own = board.tasks.filter((t) => t.containerId === container.id).sort((a, b) => a.order - b.order);
    for (const task of own) {
      if (task.human === null) continue;
      inbox.push({ ref: refOf(task.id), taskTitle: task.title, kind: task.human.kind, note: task.human.note, container: label });
    }
  }

  const referenceTime = lastEventAt ?? project.createdAt;
  const idleDays = Math.max(0, Math.floor((opts.now.getTime() - Date.parse(referenceTime)) / DAY_MS));

  const location = project.locations.find((l) => l.machineId === opts.machineId);

  // 项目整体进度不计杂项容器里的任务（Ruling 11）：杂项是随手记的东西，不是计划内的工作量
  const miscContainerId = board.containers.find((c) => c.kind === "misc")?.id;
  const trackedTasks = board.tasks.filter((t) => t.containerId !== miscContainerId);

  return {
    project: {
      id: project.id,
      name: project.name,
      cycle: project.cycle,
      health: project.health,
      focus: project.focus,
      stale,
      idleDays,
      lastEventAt,
      progress: progressOf(trackedTasks),
    },
    location: location ? { path: location.path, lastSyncAt: location.lastSyncAt } : null,
    containers,
    inbox,
  };
}

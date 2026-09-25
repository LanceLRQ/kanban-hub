import { checklistProgress, type ContainerStatus, type Progress } from "@kanban-hub/core/derive";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import type { Board, ChecklistItem, ContainerKind, HumanFlag, ManualStatus, TaskStatus } from "@kanban-hub/core/schema";
import type { Services } from "@/server/services";
import { boardSections, taskMeta, type TaskMeta } from "@/lib/board";
import { containerRefLabel } from "@/lib/refs";
import { formatDate, formatPlainDate, serverTimeZone } from "@/lib/time";

/** 看板上的一个任务：行内显示用的信息 + 侧栏编辑所需的全部字段 + 并发控制用的 version */
export interface BoardTaskView {
  id: string;
  /** # 加整个看板范围内能互相区分的最短 ID 前缀 */
  ref: string;
  version: number;
  containerId: string;
  code: string | null;
  title: string;
  status: TaskStatus;
  suspendReason: string | null;
  human: HumanFlag | null;
  group: string | null;
  note: string;
  docRefs: string[];
  checklist: ChecklistItem[];
  dueDate: string | null;
  checklistProgress: Progress;
  meta: TaskMeta;
}

export interface BoardContainerView {
  id: string;
  kind: ContainerKind;
  code: string | null;
  /** 编号；杂项固定为 misc；都没有时用最短 ID 前缀 */
  label: string;
  title: string;
  targetVersion: string | null;
  targetDate: string | null;
  /** 目标日期的显示文字（纯日期，不做时区换算） */
  targetDateLabel: string | null;
  manualStatus: ManualStatus | null;
  manualReason: string | null;
  version: number;
}

export interface BoardSectionView {
  container: BoardContainerView;
  /** 显示状态：推算状态或手动状态；杂项为 null */
  status: ContainerStatus | null;
  collapsed: boolean;
  /** 任务数，不计已取消 */
  taskCount: number;
  doneCount: number;
  /** 未完成（既不是已完成也不是已取消）的任务数 */
  openCount: number;
  cancelledCount: number;
  /** 容器已完成时的完成日期（服务端时区） */
  completedDate: string | null;
  tasks: BoardTaskView[];
}

export interface ContainerOption {
  id: string;
  label: string;
  title: string;
  kind: ContainerKind;
}

export interface BoardView {
  projectId: string;
  sections: BoardSectionView[];
  /** “所属容器”下拉：本项目全部容器，顺序与分区一致 */
  containerOptions: ContainerOption[];
}

/** 项目不存在时返回 null。日期按 tz 格式化，默认用服务端时区 */
export function buildBoardView(services: Services, projectId: string, now: Date, tz: string = serverTimeZone()): BoardView | null {
  if (!services.store.getProject(projectId)) return null;
  const stored = services.store.getBoard(projectId);
  if (!stored) return null;

  // store 返回的是 DeepReadonly 快照；这里只读它、不修改，用类型断言桥接只读数组带来的赋值不兼容
  const board = stored as unknown as Board;
  const prefixes = shortIdPrefixes(board.tasks.map((t) => t.id));

  const sections = boardSections(board).map(({ container, summary, collapsed, tasks, cancelledCount }): BoardSectionView => ({
    container: {
      id: container.id,
      kind: container.kind,
      code: container.code,
      label: containerRefLabel(container, board.containers),
      title: container.title,
      targetVersion: container.targetVersion,
      targetDate: container.targetDate,
      targetDateLabel: container.targetDate !== null ? formatPlainDate(container.targetDate, tz, now) : null,
      manualStatus: container.manualStatus,
      manualReason: container.manualReason,
      version: container.version,
    },
    status: summary.status,
    collapsed,
    taskCount: summary.progress.total,
    doneCount: summary.progress.done,
    openCount: summary.openCount,
    cancelledCount,
    completedDate: summary.completedAt !== null ? formatDate(summary.completedAt, tz, now) : null,
    tasks: tasks.map((task) => ({
      id: task.id,
      ref: `#${prefixes.get(task.id) ?? task.id}`,
      version: task.version,
      containerId: task.containerId,
      code: task.code,
      title: task.title,
      status: task.status,
      suspendReason: task.suspendReason,
      human: task.human ? { ...task.human } : null,
      group: task.group,
      note: task.note,
      docRefs: [...task.docRefs],
      checklist: task.checklist.map((item) => ({ ...item })),
      dueDate: task.dueDate,
      checklistProgress: checklistProgress(task.checklist),
      meta: taskMeta(task, now, tz),
    })),
  }));

  return {
    projectId,
    sections,
    containerOptions: sections.map(({ container }) => ({ id: container.id, label: container.label, title: container.title, kind: container.kind })),
  };
}

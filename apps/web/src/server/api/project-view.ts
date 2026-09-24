import { KhError } from "@kanban-hub/core/errors";
import type { Board, DeepReadonly, Project } from "@kanban-hub/core/schema";
import type { Store } from "../store/store";

/** 项目列表和详情接口共用：项目本体外加最近一次事件时间，停滞判定用（规格 11 节） */
export interface ProjectView {
  project: DeepReadonly<Project>;
  lastEventAt: string | null;
}

export function toProjectView(store: Store, project: DeepReadonly<Project>): ProjectView {
  return { project, lastEventAt: store.getLastEventAt(project.id) };
}

/** 项目不存在时抛 not_found，交给 apiRoute 外壳映射成 404；不要在路由里自己拼 404 响应 */
export function requireProject(store: Store, id: string): DeepReadonly<Project> {
  const project = store.getProject(id);
  if (!project) throw new KhError("not_found", `项目 ${id} 不存在`);
  return project;
}

/** 与 requireProject 成对使用：project 和 board 存在同一个 key 下，project 存在时 board 一定存在 */
export function requireBoard(store: Store, id: string): DeepReadonly<Board> {
  const board = store.getBoard(id);
  if (!board) throw new KhError("not_found", `项目 ${id} 不存在`);
  return board;
}

import type { Cycle, Health, Project } from "@kanban-hub/core/schema";
import type { Services } from "@/server/services";
import { locationSummary, primaryLocation, type LocationSummary } from "@/lib/location";

/** 项目页头部要用到的字段：基本信息、主位置摘要、并发控制用的 version */
export interface ProjectHeaderView {
  id: string;
  name: string;
  cycle: Cycle;
  health: Health;
  focus: string;
  version: number;
  location: LocationSummary | null;
}

/** 项目不存在时返回 null，调用方（页面）据此调用 `notFound()` */
export function buildProjectHeader(services: Services, projectId: string, now: Date): ProjectHeaderView | null {
  const project = services.store.getProject(projectId);
  if (!project) return null;

  // store 返回的是 DeepReadonly 快照；lib/location 的纯函数按可写的 Project 类型声明参数，
  // 这里只读它、不修改，用类型断言桥接结构性只读数组带来的赋值不兼容
  const loc = primaryLocation(project as unknown as Project);
  const location = loc ? locationSummary(loc, machineName(services, loc.machineId), now) : null;

  return {
    id: project.id,
    name: project.name,
    cycle: project.cycle,
    health: project.health,
    focus: project.focus,
    version: project.version,
    location,
  };
}

function machineName(services: Services, machineId: string): string {
  return services.store.auth.getMachine(machineId)?.name ?? machineId;
}

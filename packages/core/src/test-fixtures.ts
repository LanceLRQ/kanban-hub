import type { Actor, Board, Container, Event, Project, Task } from "./schema";

/** 测试里的固定时间 */
export const T0 = "2026-09-01T00:00:00.000Z";

/** 按前缀生成确定的 10 位 ID，例如 fixtureId("t", 1) → "t000000001" */
export function fixtureId(prefix: string, n: number): string {
  return prefix + String(n).padStart(10 - prefix.length, "0");
}

/** 递增的 ID 生成器，给变更函数的 newId 用 */
export function sequentialIds(prefix = "n"): () => string {
  let n = 0;
  return () => fixtureId(prefix, ++n);
}

export const USER_ID = fixtureId("u", 1);
export const MACHINE_ID = fixtureId("m", 1);
export const cliActor: Actor = { userId: USER_ID, machineId: MACHINE_ID, via: "cli", agent: "claude-code" };
export const webActor: Actor = { userId: USER_ID, machineId: null, via: "web", agent: null };

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: fixtureId("p", 1),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    name: "示例项目",
    description: "",
    cycle: "development",
    health: "on_track",
    focus: "",
    fingerprint: null,
    locations: [],
    ...overrides,
  };
}

export function makeContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: fixtureId("c", 1),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    kind: "phase",
    code: "M1",
    title: "阶段一",
    order: 1,
    targetVersion: null,
    targetDate: null,
    manualStatus: null,
    manualReason: null,
    ...overrides,
  };
}

/** 杂项容器，ID 固定为 c000000000 */
export function makeMisc(overrides: Partial<Container> = {}): Container {
  return makeContainer({ id: fixtureId("c", 0), kind: "misc", code: null, title: "杂项", order: 0, ...overrides });
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: fixtureId("t", 1),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    containerId: fixtureId("c", 1),
    code: null,
    title: "任务",
    order: 1,
    status: "todo",
    suspendReason: null,
    human: null,
    group: null,
    assigneeUserId: null,
    note: "",
    docRefs: [],
    checklist: [],
    dueDate: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** 看板：自动带上杂项容器，containers 里不用再放 */
export function makeBoard(containers: Container[] = [makeContainer()], tasks: Task[] = []): Board {
  return { containers: [makeMisc(), ...containers], tasks };
}

export function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: fixtureId("e", 1),
    ts: T0,
    projectId: fixtureId("p", 1),
    actor: cliActor,
    type: "log",
    target: null,
    change: null,
    text: "日志",
    imported: false,
    ...overrides,
  };
}

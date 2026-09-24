import type { Machine, MachineOs } from "@kanban-hub/core/schema";

/** 机器的对外视图：去掉 tokenHash，机器列表、吊销、/me 三个接口共用 */
export interface MachineView {
  id: string;
  name: string;
  os: MachineOs;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function toMachineView(machine: Machine): MachineView {
  return {
    id: machine.id,
    name: machine.name,
    os: machine.os,
    lastSeenAt: machine.lastSeenAt,
    revokedAt: machine.revokedAt,
    createdAt: machine.createdAt,
  };
}

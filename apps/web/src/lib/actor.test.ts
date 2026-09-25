import { describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { actorLabel } from "./actor";

const ctx = {
  userName: (id: string) => `用户-${id}`,
  machineName: (id: string) => `机器-${id}`,
};

describe("actorLabel", () => {
  it("网页操作显示用户名，没有次要信息", () => {
    const actor: Actor = { userId: "u0000000001", machineId: null, via: "web", agent: null };
    expect(actorLabel(actor, ctx)).toEqual({ primary: "用户-u0000000001", secondary: null });
  });

  it("命令行操作有 agent 时，主要信息是 agent 名，次要信息是机器名", () => {
    const actor: Actor = { userId: "u0000000001", machineId: "m0000000001", via: "cli", agent: "claude-code" };
    expect(actorLabel(actor, ctx)).toEqual({ primary: "claude-code", secondary: "机器-m0000000001" });
  });

  it("命令行操作没有 agent 时，只显示机器名", () => {
    const actor: Actor = { userId: "u0000000001", machineId: "m0000000001", via: "cli", agent: null };
    expect(actorLabel(actor, ctx)).toEqual({ primary: "机器-m0000000001", secondary: null });
  });
});

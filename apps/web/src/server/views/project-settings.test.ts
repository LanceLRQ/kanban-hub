import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor } from "@kanban-hub/core/schema";
import { projectSchema } from "@kanban-hub/core/schema";
import { DEFAULT_STALE_DAYS } from "@kanban-hub/core/derive";
import { readYamlFile, writeYamlFile } from "@/server/store/fsio";
import { Store } from "@/server/store/store";
import { PairingRegistry } from "@/server/auth/pairing";
import { FailureLimiter } from "@/server/auth/rate-limit";
import { LastSeenTracker } from "@/server/auth/authenticate";
import type { Services } from "@/server/services";
import { buildProjectSettingsView } from "./project-settings";

const NOW = new Date("2026-09-25T10:00:00.000Z");

let dir: string;
let opened: Store[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-project-settings-test-"));
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function open(): Promise<Store> {
  const store = await Store.open({ dataDir: dir, now: () => NOW, commitDebounceMs: 60_000, log: () => {} });
  opened.push(store);
  return store;
}

function servicesFor(store: Store): Services {
  const now = () => NOW;
  return {
    store,
    pairing: new PairingRegistry({ now }),
    limiter: new FailureLimiter({ now }),
    seen: new LastSeenTracker({ now, log: () => {} }),
    publicUrl: null,
    staleDays: DEFAULT_STALE_DAYS,
    now,
    log: () => {},
  };
}

let tokenSeq = 0;

async function cliActor(store: Store, machineName = "mac"): Promise<Actor> {
  const user =
    store.auth.listUsers()[0] ?? (await store.auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" }));
  const machine = await store.auth.createMachine({
    name: machineName,
    userId: user.id,
    os: "darwin",
    tokenHash: (++tokenSeq).toString(16).padStart(64, "0"),
  });
  return { userId: user.id, machineId: machine.id, via: "cli", agent: null };
}

/** 直接改写磁盘上的 project.yaml，注入公开写接口目前还不能设置的字段（lastSyncAt、git、skippedFiles、同步范围） */
async function patchProjectFile(projectId: string, patch: (raw: unknown) => unknown): Promise<void> {
  const file = path.join(dir, "projects", projectId, "project.yaml");
  const raw = await readYamlFile(file, projectSchema);
  await writeYamlFile(file, patch(raw));
}

describe("buildProjectSettingsView", () => {
  it("项目不存在时返回 null", async () => {
    const store = await open();
    expect(buildProjectSettingsView(servicesFor(store), "no-such-project", NOW)).toBeNull();
  });

  it("没有登记任何位置时，locations 为空数组", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);

    const view = buildProjectSettingsView(servicesFor(store), project.id, NOW);
    expect(view?.locations).toEqual([]);
  });

  it("多个位置：缺失 git 信息、从未同步、有跳过的文件，各自独立展示", async () => {
    const storeA = await open();
    const actor = await cliActor(storeA, "mac-mini");
    const linux = await cliActor(storeA, "linux-box");
    const { project } = await storeA.createProject({ name: "看板" }, actor);
    await storeA.setLocation(project.id, actor.machineId!, { path: "/repo1" }, actor);
    await storeA.setLocation(project.id, linux.machineId!, { path: "/repo2" }, linux);
    await storeA.close();

    await patchProjectFile(project.id, (raw) => {
      const p = raw as { locations: unknown[] };
      return {
        ...p,
        locations: [
          {
            machineId: actor.machineId,
            path: "/repo1",
            lastSyncAt: "2026-09-25T09:46:00.000Z",
            sync: { include: ["docs/**"], exclude: ["**/*.png"], maxFileSize: 1_000_000 },
            git: {
              branch: "feat/m2-api",
              head: "a".repeat(40),
              headSubject: "feat: 加接口",
              headAt: "2026-09-24T01:00:00.000Z",
              dirtyCount: 0,
              ahead: 2,
              behind: 0,
            },
            skippedFiles: [{ path: "big.bin", size: 20_000_000 }],
          },
          {
            machineId: linux.machineId,
            path: "/repo2",
            lastSyncAt: null,
            sync: null,
            git: null,
            skippedFiles: [],
          },
        ],
      };
    });

    const storeB = await open();
    const view = buildProjectSettingsView(servicesFor(storeB), project.id, NOW);

    expect(view?.locations).toHaveLength(2);
    const loc1 = view!.locations[0]!;
    const loc2 = view!.locations[1]!;

    expect(loc1).toMatchObject({
      machineId: actor.machineId,
      machineName: "mac-mini",
      path: "/repo1",
      sync: { include: ["docs/**"], exclude: ["**/*.png"], maxFileSize: 1_000_000 },
      branch: "feat/m2-api",
      ahead: 2,
      behind: 0,
      dirtyCount: 0,
    });
    expect(loc1.syncedAt).not.toBeNull();
    expect(loc1.headAt).not.toBeNull();
    expect(loc1.skippedFiles).toEqual([{ path: "big.bin", size: 20_000_000 }]);

    expect(loc2).toMatchObject({
      machineId: linux.machineId,
      machineName: "linux-box",
      path: "/repo2",
      sync: null,
      syncedAt: null,
      branch: null,
      ahead: null,
      behind: null,
      dirtyCount: null,
      headAt: null,
      skippedFiles: [],
    });
  });

  it("机器已吊销时，位置里仍显示机器名", async () => {
    const store = await open();
    const actor = await cliActor(store, "old-mac");
    const { project } = await store.createProject({ name: "看板" }, actor);
    await store.setLocation(project.id, actor.machineId!, { path: "/repo" }, actor);
    await store.auth.updateMachine(actor.machineId!, { revokedAt: NOW.toISOString() });

    const view = buildProjectSettingsView(servicesFor(store), project.id, NOW);
    expect(view?.locations[0]).toMatchObject({ machineId: actor.machineId, machineName: "old-mac" });
  });
});

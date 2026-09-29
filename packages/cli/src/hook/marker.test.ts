import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkerIfAbsent, gcMarkers, markReminded, readMarker, type SessionMarker } from "./marker";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-marker-"));
  dirs.push(dir);
  return dir;
}

function sampleMarker(overrides: Partial<SessionMarker> = {}): SessionMarker {
  return {
    sessionId: "s1",
    projectId: "p000000001",
    root: "/repo",
    worktree: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    head: "abc123",
    dirty: null,
    reminded: false,
    ...overrides,
  };
}

describe("readMarker / createMarkerIfAbsent", () => {
  it("不存在时 readMarker 返回 null", async () => {
    const home = await tempDir();
    expect(await readMarker(home, "s1")).toBeNull();
  });

  it("创建后能读到同样的内容", async () => {
    const home = await tempDir();
    const marker = sampleMarker();
    await createMarkerIfAbsent(home, marker);
    expect(await readMarker(home, "s1")).toEqual(marker);
  });

  it("已存在时不覆盖", async () => {
    const home = await tempDir();
    await createMarkerIfAbsent(home, sampleMarker({ head: "first" }));
    await createMarkerIfAbsent(home, sampleMarker({ head: "second" }));
    expect((await readMarker(home, "s1"))?.head).toBe("first");
  });

  it("文件损坏（不是合法 JSON）时当作不存在", async () => {
    const home = await tempDir();
    const dir = path.join(home, "cache", "sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1.json"), "不是 json");
    expect(await readMarker(home, "s1")).toBeNull();
  });

  it("文件内容不符合 schema 时当作不存在", async () => {
    const home = await tempDir();
    const dir = path.join(home, "cache", "sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1.json"), JSON.stringify({ sessionId: "s1" }));
    expect(await readMarker(home, "s1")).toBeNull();
  });
});

describe("markReminded", () => {
  it("把已有标记的 reminded 改为 true", async () => {
    const home = await tempDir();
    await createMarkerIfAbsent(home, sampleMarker({ reminded: false }));
    await markReminded(home, "s1");
    expect((await readMarker(home, "s1"))?.reminded).toBe(true);
  });

  it("标记不存在时什么都不做，不抛错", async () => {
    const home = await tempDir();
    await expect(markReminded(home, "no-such-session")).resolves.toBeUndefined();
    expect(await readMarker(home, "no-such-session")).toBeNull();
  });
});

describe("gcMarkers", () => {
  it("超过 7 天的标记被清理，未超过的保留", async () => {
    const home = await tempDir();
    const now = new Date("2026-01-10T00:00:00.000Z");
    await createMarkerIfAbsent(home, sampleMarker({ sessionId: "old", startedAt: "2026-01-01T00:00:00.000Z" }));
    await createMarkerIfAbsent(home, sampleMarker({ sessionId: "recent", startedAt: "2026-01-09T00:00:00.000Z" }));

    await gcMarkers(home, now);

    expect(await readMarker(home, "old")).toBeNull();
    expect(await readMarker(home, "recent")).not.toBeNull();
  });

  it("损坏的标记文件当作过期，一并清理", async () => {
    const home = await tempDir();
    const dir = path.join(home, "cache", "sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "broken.json"), "不是 json");

    await gcMarkers(home, new Date("2026-01-01T00:00:00.000Z"));

    await expect(fs.access(path.join(dir, "broken.json"))).rejects.toThrow();
  });

  it("目录不存在时不抛错", async () => {
    const home = await tempDir();
    await expect(gcMarkers(home, new Date())).resolves.toBeUndefined();
  });
});

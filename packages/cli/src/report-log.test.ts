import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLastReport, recordReport } from "./report-log";

describe("report-log", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "kh-report-log-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("没有记录过时返回 null", async () => {
    expect(await readLastReport(home, "proj0000aa")).toBeNull();
  });

  it("写入后能读回同一个时间", async () => {
    const now = new Date("2026-09-25T08:00:00.000Z");
    await recordReport(home, "proj0000aa", now);
    const readBack = await readLastReport(home, "proj0000aa");
    expect(readBack?.toISOString()).toBe(now.toISOString());
  });

  it("多个项目互不影响", async () => {
    await recordReport(home, "proj0000aa", new Date("2026-09-25T08:00:00.000Z"));
    await recordReport(home, "proj0000bb", new Date("2026-09-26T08:00:00.000Z"));

    expect((await readLastReport(home, "proj0000aa"))?.toISOString()).toBe("2026-09-25T08:00:00.000Z");
    expect((await readLastReport(home, "proj0000bb"))?.toISOString()).toBe("2026-09-26T08:00:00.000Z");
  });

  it("目录不存在时自动创建", async () => {
    const nestedHome = path.join(home, "not-yet-created");
    await recordReport(nestedHome, "proj0000aa", new Date("2026-09-25T08:00:00.000Z"));
    const readBack = await readLastReport(nestedHome, "proj0000aa");
    expect(readBack).not.toBeNull();
  });

  it("再次写入会覆盖旧记录", async () => {
    await recordReport(home, "proj0000aa", new Date("2026-09-25T08:00:00.000Z"));
    await recordReport(home, "proj0000aa", new Date("2026-09-26T09:00:00.000Z"));
    expect((await readLastReport(home, "proj0000aa"))?.toISOString()).toBe("2026-09-26T09:00:00.000Z");
  });
});

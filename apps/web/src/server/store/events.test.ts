import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixtureId, makeEvent } from "@kanban-hub/core/test-fixtures";
import { EventLog, monthOf, recentMonths } from "./events";

const P = fixtureId("p", 1);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-events-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("monthOf", () => {
  it("按 UTC 取月份", () => {
    expect(monthOf("2026-09-30T23:30:00-02:00")).toBe("2026-10");
    expect(monthOf("2026-09-01T00:00:00.000Z")).toBe("2026-09");
  });
});

describe("recentMonths", () => {
  it("包括当前月，从早到晚", () => {
    expect(recentMonths(new Date("2026-09-23T10:00:00.000Z"), 3)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("可以跨年", () => {
    expect(recentMonths(new Date("2026-01-15T00:00:00.000Z"), 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("EventLog", () => {
  it("按事件时间追加到对应月份的文件，返回相对路径", async () => {
    const log = new EventLog(dir);
    const e = makeEvent({ ts: "2026-09-23T10:00:00.000Z" });
    expect(await log.append(e)).toBe(`projects/${P}/events/2026-09.jsonl`);
    expect(await log.readMonth(P, "2026-09")).toEqual([e]);
  });

  it("listMonths 从早到晚列出，忽略其他文件", async () => {
    const log = new EventLog(dir);
    await log.append(makeEvent({ ts: "2026-09-01T00:00:00.000Z" }));
    await log.append(makeEvent({ id: fixtureId("e", 2), ts: "2026-07-01T00:00:00.000Z" }));
    await fs.writeFile(path.join(dir, "projects", P, "events", "notes.txt"), "x");
    expect(await log.listMonths(P)).toEqual(["2026-07", "2026-09"]);
  });

  it("项目还没有事件时返回空", async () => {
    const log = new EventLog(dir);
    expect(await log.listMonths(fixtureId("p", 9))).toEqual([]);
    expect(await log.readMonth(fixtureId("p", 9), "2026-09")).toEqual([]);
  });

  it("末尾有写到一半的残行时，读取时截掉，之后可以正常追加", async () => {
    const log = new EventLog(dir);
    const e1 = makeEvent();
    const rel = await log.append(e1);
    await fs.appendFile(path.join(dir, rel), '{"id":"brok');
    expect(await log.readMonth(P, "2026-09")).toEqual([e1]);
    const e2 = makeEvent({ id: fixtureId("e", 2) });
    await log.append(e2);
    expect(await log.readMonth(P, "2026-09")).toEqual([e1, e2]);
  });

  it("中间有损坏的行时抛出 DataFileError，指出行号", async () => {
    const log = new EventLog(dir);
    const rel = await log.append(makeEvent());
    await fs.appendFile(path.join(dir, rel), "oops\n");
    await log.append(makeEvent({ id: fixtureId("e", 2) }));
    await expect(log.readMonth(P, "2026-09")).rejects.toMatchObject({ name: "DataFileError", line: 2 });
  });

  it("append 前如果文件末尾是写到一半的残行，会先修复再追加（不经过 readMonth）", async () => {
    const log = new EventLog(dir);
    const e1 = makeEvent();
    const rel = await log.append(e1);
    await fs.appendFile(path.join(dir, rel), '{"id":"ab');
    const e2 = makeEvent({ id: fixtureId("e", 2) });
    await log.append(e2);
    expect(await log.readMonth(P, "2026-09")).toEqual([e1, e2]);
  });

  it("append 前如果末行完整但缺换行，会先补上换行再追加", async () => {
    const log = new EventLog(dir);
    const e1 = makeEvent();
    const rel = await log.append(e1);
    const raw = await fs.readFile(path.join(dir, rel), "utf8");
    await fs.writeFile(path.join(dir, rel), raw.replace(/\n$/, ""));
    const e2 = makeEvent({ id: fixtureId("e", 2) });
    await log.append(e2);
    expect(await log.readMonth(P, "2026-09")).toEqual([e1, e2]);
  });
});

describe("路径穿越防护", () => {
  it("readMonth 与 listMonths 的 projectId 不合法时以 invalid 拒绝", async () => {
    const log = new EventLog(dir);
    await expect(log.readMonth("../x", "2020-01")).rejects.toMatchObject({ name: "KhError", code: "invalid" });
    await expect(log.listMonths("../x")).rejects.toMatchObject({ name: "KhError", code: "invalid" });
  });
});

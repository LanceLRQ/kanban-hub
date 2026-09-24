import { describe, expect, it } from "vitest";
import { WriteQueue } from "./queue";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WriteQueue", () => {
  it("按提交顺序依次执行，前一个结束后才开始下一个", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name} 开始`);
      await delay(ms);
      log.push(`${name} 结束`);
      return name;
    };
    const results = await Promise.all([q.run(job("a", 20)), q.run(job("b", 0)), q.run(job("c", 5))]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a 开始", "a 结束", "b 开始", "b 结束", "c 开始", "c 结束"]);
  });

  it("某个任务失败只影响它自己，后面的照常执行", async () => {
    const q = new WriteQueue();
    const failed = q.run(async () => {
      throw new Error("写入失败");
    });
    const next = q.run(async () => "ok");
    await expect(failed).rejects.toThrow("写入失败");
    await expect(next).resolves.toBe("ok");
  });

  it("size 是排队中和执行中的任务数，idle 等全部结束", async () => {
    const q = new WriteQueue();
    void q.run(() => delay(10));
    void q.run(() => delay(10));
    expect(q.size).toBe(2);
    await q.idle();
    expect(q.size).toBe(0);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeContext } from "../repo/test-helpers";
import { diff3Text, diffNoIndex, mergeText } from "./merge";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

let tmpRoot: string;

beforeEach(async () => {
  // 把系统临时目录指到一个专用目录，便于断言合并用的临时文件用完即删
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-merge-test-")));
  vi.stubEnv("TMPDIR", tmpRoot);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const ctx = () => fakeContext();

describe("mergeText", () => {
  it("两边改动不重叠：自动合并，结果包含两边的改动", async () => {
    const base = enc("a\nb\nc\nd\ne\n");
    const local = enc("A\nb\nc\nd\ne\n");
    const remote = enc("a\nb\nc\nd\nE\n");
    const result = await mergeText(ctx(), local, base, remote);
    expect(result.clean).toBe(true);
    if (result.clean) expect(dec(result.merged)).toBe("A\nb\nc\nd\nE\n");
  });

  it("同一行两边改法不同：不能自动合并", async () => {
    const base = enc("a\nb\nc\n");
    const local = enc("a\nLOCAL\nc\n");
    const remote = enc("a\nREMOTE\nc\n");
    const result = await mergeText(ctx(), local, base, remote);
    expect(result.clean).toBe(false);
  });

  it("两边对同一行做了相同改动，另一处只有一边改了：自动合并，相同改动只出现一次", async () => {
    const base = enc("a\nb\nc\nd\ne\n");
    const local = enc("a\nSAME\nc\nd\ne\n");
    const remote = enc("a\nSAME\nc\nd\nE\n");
    const result = await mergeText(ctx(), local, base, remote);
    expect(result.clean).toBe(true);
    if (result.clean) expect(dec(result.merged)).toBe("a\nSAME\nc\nd\nE\n");
  });

  it("两边做了完全相同的改动：自动合并，结果就是这份改动", async () => {
    const base = enc("a\nb\nc\n");
    const same = enc("a\nSAME\nc\n");
    const result = await mergeText(ctx(), same, base, same);
    expect(result.clean).toBe(true);
    if (result.clean) expect(dec(result.merged)).toBe("a\nSAME\nc\n");
  });

  it("按字节处理：UTF-8 中文与 CRLF 原样保留", async () => {
    const base = enc("第一行\r\n第二行\r\n第三行\r\n第四行\r\n");
    const local = enc("第一行改\r\n第二行\r\n第三行\r\n第四行\r\n");
    const remote = enc("第一行\r\n第二行\r\n第三行\r\n第四行改\r\n");
    const result = await mergeText(ctx(), local, base, remote);
    expect(result.clean).toBe(true);
    if (result.clean) expect(dec(result.merged)).toBe("第一行改\r\n第二行\r\n第三行\r\n第四行改\r\n");
  });

  it("临时文件用完即删", async () => {
    await mergeText(ctx(), enc("a\n"), enc("b\n"), enc("c\n"));
    expect(await fs.readdir(tmpRoot)).toEqual([]);
  });
});

describe("diff3Text", () => {
  it("输出带四种标记和三个标签", async () => {
    const out = dec(
      await diff3Text(ctx(), enc("a\nLOCAL\nc\n"), enc("a\nb\nc\n"), enc("a\nREMOTE\nc\n"), {
        local: "本机",
        base: "共同基准",
        remote: "机器A",
      }),
    );
    expect(out).toContain("<<<<<<< 本机");
    expect(out).toContain("||||||| 共同基准");
    expect(out).toContain("=======");
    expect(out).toContain(">>>>>>> 机器A");
    expect(out).toContain("LOCAL");
    expect(out).toContain("REMOTE");
    expect(await fs.readdir(tmpRoot)).toEqual([]);
  });
});

describe("diffNoIndex", () => {
  it("有差异（git 退出码 1）不算失败，输出 git diff 格式", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "d-"));
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await fs.writeFile(a, "one\n");
    await fs.writeFile(b, "two\n");
    const out = dec(await diffNoIndex(ctx(), a, b));
    expect(out).toContain("diff --git");
    expect(out).toContain("-one");
    expect(out).toContain("+two");
  });

  it("二进制文件：输出 Binary files … differ", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "d-"));
    const a = path.join(dir, "a.bin");
    const b = path.join(dir, "b.bin");
    await fs.writeFile(a, Buffer.from([0, 1, 2]));
    await fs.writeFile(b, Buffer.from([0, 1, 3]));
    const out = dec(await diffNoIndex(ctx(), a, b));
    expect(out).toContain("diff --git");
    expect(out).toMatch(/Binary files .* differ/);
  });

  it("没有差异：输出为空", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "d-"));
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await fs.writeFile(a, "same\n");
    await fs.writeFile(b, "same\n");
    expect(dec(await diffNoIndex(ctx(), a, b))).toBe("");
  });
});

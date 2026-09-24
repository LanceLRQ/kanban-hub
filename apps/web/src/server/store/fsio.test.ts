import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  DataFileError,
  appendJsonLine,
  parseYamlText,
  readJsonLines,
  readYamlFile,
  repairJsonLinesTail,
  writeFileAtomic,
  writeYamlFile,
} from "./fsio";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kh-fsio-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

const docSchema = z.object({ name: z.string(), items: z.array(z.object({ n: z.number() })) });
const lineSchema = z.object({ n: z.number() });

describe("writeFileAtomic", () => {
  it("自动建目录并写入，不留临时文件", async () => {
    const file = path.join(tmp, "a", "b.yaml");
    await writeFileAtomic(file, "x: 1\n");
    expect(await fs.readFile(file, "utf8")).toBe("x: 1\n");
    expect(await fs.readdir(path.join(tmp, "a"))).toEqual(["b.yaml"]);
  });

  it("覆盖已有文件", async () => {
    const file = path.join(tmp, "f.txt");
    await writeFileAtomic(file, "old");
    await writeFileAtomic(file, "new");
    expect(await fs.readFile(file, "utf8")).toBe("new");
  });

  it("写入失败时删掉临时文件并抛出错误", async () => {
    const target = path.join(tmp, "dir");
    await fs.mkdir(target);
    await expect(writeFileAtomic(target, "x")).rejects.toThrow();
    expect(await fs.readdir(tmp)).toEqual(["dir"]);
  });

  it.skipIf(process.platform === "win32")("可以指定文件权限", async () => {
    const file = path.join(tmp, "secret");
    await writeFileAtomic(file, "s", { mode: 0o600 });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("YAML", () => {
  it("写入后能原样读回，中文不转义，长字符串不折行", async () => {
    const file = path.join(tmp, "doc.yaml");
    const value = { name: "很长的中文名称 ".repeat(20).trim(), items: [{ n: 1 }] };
    await writeYamlFile(file, value);
    expect((await fs.readFile(file, "utf8")).split("\n")[0]).toBe(`name: ${value.name}`);
    expect(await readYamlFile(file, docSchema)).toEqual(value);
  });

  it("文件不存在时返回 null", async () => {
    expect(await readYamlFile(path.join(tmp, "missing.yaml"), docSchema)).toBeNull();
  });

  it("格式错误时指出行号", () => {
    const err = thrown(() => parseYamlText("f.yaml", "name: a\nitems: [1, 2\nx: 1\n", docSchema));
    expect(err).toBeInstanceOf(DataFileError);
    expect((err as DataFileError).line).toBe(3);
    expect((err as DataFileError).reason).toMatch(/^YAML 格式错误/);
  });

  it("校验错误时指出字段路径和所在的行", () => {
    const err = thrown(() => parseYamlText("f.yaml", "name: a\nitems:\n  - n: 1\n  - n: x\n", docSchema));
    expect((err as DataFileError).line).toBe(4);
    expect((err as DataFileError).reason).toContain("items[1].n");
    expect((err as DataFileError).message).toContain("f.yaml 第 4 行");
  });

  it("缺少字段时指向它所在的上一层", () => {
    const err = thrown(() => parseYamlText("f.yaml", "name: a\nitems:\n  - n: 1\n  - {}\n", docSchema));
    expect((err as DataFileError).line).toBe(4);
  });

  it("空文件报错，但没有行号", () => {
    const err = thrown(() => parseYamlText("f.yaml", "", docSchema));
    expect(err).toBeInstanceOf(DataFileError);
    expect((err as DataFileError).line).toBeNull();
  });
});

describe("JSONL", () => {
  it("逐行追加并读回", async () => {
    const file = path.join(tmp, "e", "2026-09.jsonl");
    await appendJsonLine(file, { n: 1 });
    await appendJsonLine(file, { n: 2 });
    expect(await readJsonLines(file, lineSchema)).toEqual({
      items: [{ n: 1 }, { n: 2 }],
      tail: "clean",
      validBytes: 16,
    });
  });

  it("文件不存在时返回空列表", async () => {
    expect((await readJsonLines(path.join(tmp, "none.jsonl"), lineSchema)).items).toEqual([]);
  });

  it("跳过空行", async () => {
    const file = path.join(tmp, "f.jsonl");
    await fs.writeFile(file, '{"n":1}\n\n{"n":2}\n');
    expect((await readJsonLines(file, lineSchema)).items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("中间某行损坏时指出行号", async () => {
    const file = path.join(tmp, "f.jsonl");
    await fs.writeFile(file, '{"n":1}\nnot json\n{"n":2}\n');
    await expect(readJsonLines(file, lineSchema)).rejects.toMatchObject({ line: 2 });
  });

  it("最后一行完整但缺换行时照常读取，修复时补上换行", async () => {
    const file = path.join(tmp, "f.jsonl");
    await fs.writeFile(file, '{"n":1}\n{"n":2}');
    const result = await readJsonLines(file, lineSchema);
    expect(result.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(result.tail).toBe("unterminated");
    await repairJsonLinesTail(file, result);
    expect(await fs.readFile(file, "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("最后一行是完整的 JSON 但校验不通过时报错，不当作残行截掉", async () => {
    const file = path.join(tmp, "f.jsonl");
    await fs.writeFile(file, '{"n":1}\n{"n":"x"}');
    await expect(readJsonLines(file, lineSchema)).rejects.toMatchObject({ line: 2 });
  });

  it("最后一行写到一半时跳过它，修复时截掉，之后可以正常追加", async () => {
    const file = path.join(tmp, "f.jsonl");
    await fs.writeFile(file, '{"n":1}\n{"n":');
    const result = await readJsonLines(file, lineSchema);
    expect(result.items).toEqual([{ n: 1 }]);
    expect(result.tail).toBe("partial");
    await repairJsonLinesTail(file, result);
    await appendJsonLine(file, { n: 3 });
    expect(await fs.readFile(file, "utf8")).toBe('{"n":1}\n{"n":3}\n');
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KH_VERSION } from "@kanban-hub/core";
import { buildCli } from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);

describe("kh 打包产物", () => {
  let dir: string;
  let outfile: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-"));
    outfile = await buildCli(path.join(dir, "kh.mjs"));
  }, 30_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("单个文件即可运行并输出版本号", async () => {
    const { stdout } = await execFileAsync(process.execPath, [outfile, "--version"]);
    expect(stdout.trim()).toBe(KH_VERSION);
  });

  it("首行是 node 的 shebang", async () => {
    const firstLine = (await fs.readFile(outfile, "utf8")).split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});

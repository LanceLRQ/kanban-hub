import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildCli } from "./build.mjs";

const execFileAsync = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgDir, "..", "..");

/**
 * 生成发布用的 kh.tgz：构建 kh.mjs，配一份干净的 package.json（只有 bin/engines/files，
 * 没有任何依赖），带上仓库根目录的 LICENSE，执行 npm pack。返回 tgz 的路径。
 *
 * 版本号不从 TS 源码里 import（本脚本是纯 .mjs，不经过打包/转译），而是运行刚构建出的
 * kh.mjs 的 --version 拿到——它已经是 commander 接到 KH_VERSION 的真实产物。
 */
export async function packCli(outDir = path.join(pkgDir, "dist")) {
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-pack-stage-"));
  try {
    const khMjsPath = path.join(stageDir, "kh.mjs");
    await buildCli(khMjsPath);

    const { stdout } = await execFileAsync(process.execPath, [khMjsPath, "--version"]);
    const version = stdout.trim();

    const pkg = {
      name: "@kanban-hub/cli",
      version,
      bin: { kh: "kh.mjs" },
      engines: { node: ">=22" },
      files: ["kh.mjs", "LICENSE"],
    };
    await fs.writeFile(path.join(stageDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    await fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(stageDir, "LICENSE"));

    await fs.mkdir(outDir, { recursive: true });
    const { stdout: packedName } = await execFileAsync("npm", ["pack", "--pack-destination", outDir], {
      cwd: stageDir,
    });

    const finalPath = path.join(outDir, "kh.tgz");
    await fs.rm(finalPath, { force: true });
    await fs.rename(path.join(outDir, packedName.trim()), finalPath);

    return finalPath;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

// 直接执行本脚本时才打包；argv[1] 可能是符号链接路径，而 import.meta.url 已解析为真实路径
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packCli();
}

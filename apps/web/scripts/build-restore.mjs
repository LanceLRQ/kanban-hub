import { build } from "esbuild";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 把独立恢复入口打包成单个 ESM 文件（dist/restore.mjs）：依赖全部内联，
 * 镜像里不需要 node_modules 就能跑，也便于放进体积精简的 runtime 镜像层。
 */
export async function buildRestore(outfile = path.join(pkgDir, "dist", "restore.mjs")) {
  await build({
    entryPoints: [path.join(pkgDir, "src", "restore.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      // 个别 CJS 依赖在 ESM 产物里会调用 require，文件头补上 createRequire
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __khCreateRequire } from 'node:module';",
        "const require = __khCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "warning",
  });
  return outfile;
}

// 直接执行本脚本时才打包；argv[1] 可能是符号链接路径，而 import.meta.url 已解析为真实路径
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRestore();
}

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 把 kh 打包成单个 ESM 文件。依赖全部打进产物，安装时不需要再下载任何依赖。 */
export async function buildCli(outfile = path.join(pkgDir, "dist", "kh.mjs")) {
  await build({
    entryPoints: [path.join(pkgDir, "src", "bin.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // commander 等 CJS 依赖在 ESM 产物里会调用 require，需要在文件头补上
    banner: {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildCli();
}

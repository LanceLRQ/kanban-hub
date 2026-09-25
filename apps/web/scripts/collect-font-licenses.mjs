#!/usr/bin/env node
// 从六个字体包里收集许可证文本，写到 apps/web/public/licenses/fonts/<包名>.txt，
// 另写一份 README.txt 汇总字体、版权方、许可证。在 build 之前自动跑一遍，
// 生成的文件入库，方便在 PR 里核对字体包升级后许可证有没有变。
//
// 缺少某个包的许可证文件时直接失败退出，不静默跳过——OFL 要求再分发字体时随附许可证文本，
// 漏掉一个就是违反许可证条款。

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

/** 六个字体包：id 对应 preferences.ts 的 MONO_FONTS / CJK_FONTS 取值 */
export const FONT_PACKAGES = [
  {
    id: "jetbrains-mono",
    displayName: "JetBrains Mono",
    copyright: "JetBrains",
    licenseName: "SIL Open Font License 1.1",
    resolve: () => resolvePackageFile("@fontsource/jetbrains-mono/package.json", "LICENSE"),
  },
  {
    id: "ibm-plex-mono",
    displayName: "IBM Plex Mono",
    copyright: "IBM Corp",
    licenseName: "SIL Open Font License 1.1",
    resolve: () => resolvePackageFile("@fontsource/ibm-plex-mono/package.json", "LICENSE"),
  },
  {
    id: "fira-code",
    displayName: "Fira Code",
    copyright: "The Fira Code Project Authors",
    licenseName: "SIL Open Font License 1.1",
    resolve: () => resolvePackageFile("@fontsource/fira-code/package.json", "LICENSE"),
  },
  {
    id: "noto-sans-sc",
    displayName: "思源黑体 Noto Sans SC",
    copyright: "Google Inc / Adobe 等 Noto CJK 贡献者",
    licenseName: "SIL Open Font License 1.1",
    resolve: () => resolvePackageFile("@fontsource/noto-sans-sc/package.json", "LICENSE"),
  },
  {
    id: "noto-serif-sc",
    displayName: "思源宋体 Noto Serif SC",
    copyright: "Google Inc / Adobe 等 Noto CJK 贡献者",
    licenseName: "SIL Open Font License 1.1",
    resolve: () => resolvePackageFile("@fontsource/noto-serif-sc/package.json", "LICENSE"),
  },
  {
    id: "lxgw-wenkai",
    displayName: "霞鹜文楷 LXGW WenKai",
    copyright: "LXGW；基于 Fontworks Klee",
    licenseName: "SIL Open Font License 1.1（含 LXGW 附加条款）",
    // lxgw-wenkai-webfont 的 package.json license 字段是打包工具自身的 MIT，
    // 字体本体的许可证在包内的 OFL.txt，两者不是同一份文本
    resolve: () => resolvePackageFile("lxgw-wenkai-webfont/package.json", "OFL.txt"),
  },
];

function resolvePackageFile(packageJsonSpecifier, relativeFile) {
  const packageJsonPath = require.resolve(packageJsonSpecifier);
  return path.join(path.dirname(packageJsonPath), relativeFile);
}

/**
 * 收集六个字体包的许可证，写到 outDir/fonts/<id>.txt 和 outDir/README.txt。
 * 缺少某个包的许可证文件时抛异常（调用方决定是退出进程还是在测试里断言）。
 */
export function collectFontLicenses(outDir, packages = FONT_PACKAGES) {
  const fontsDir = path.join(outDir, "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });

  const collected = [];
  for (const pkg of packages) {
    const licensePath = pkg.resolve();
    if (!fs.existsSync(licensePath)) {
      throw new Error(
        `字体包 ${pkg.id} 缺少许可证文件（期望路径：${licensePath}）。升级或更换字体包前，请确认新版本仍随附 OFL 许可证文本。`,
      );
    }
    const text = fs.readFileSync(licensePath, "utf8");
    if (!text.includes("SIL Open Font License")) {
      throw new Error(`字体包 ${pkg.id} 的许可证文件不含 "SIL Open Font License" 字样：${licensePath}`);
    }
    const outputPath = path.join(fontsDir, `${pkg.id}.txt`);
    fs.writeFileSync(outputPath, text);
    collected.push({ ...pkg, outputPath });
  }

  const readme = buildReadme(collected);
  fs.writeFileSync(path.join(outDir, "README.txt"), readme);

  return collected;
}

function buildReadme(collected) {
  const lines = [
    "kanban-hub 网页自托管的字体许可证",
    "",
    "以下字体均为 SIL Open Font License 1.1，与本项目 MIT 协议兼容，允许随源码/镜像分发与自托管。",
    "完整许可证文本见 fonts/<字体>.txt。",
    "",
  ];
  for (const pkg of collected) {
    lines.push(`- ${pkg.displayName}`);
    lines.push(`  版权：${pkg.copyright}`);
    lines.push(`  许可证：${pkg.licenseName}`);
    lines.push(`  文本：fonts/${pkg.id}.txt`);
    lines.push("");
  }
  return lines.join("\n");
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "licenses");
  try {
    const collected = collectFontLicenses(outDir);
    console.log(`已收集 ${collected.length} 个字体包的许可证到 ${outDir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

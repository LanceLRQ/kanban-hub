import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

// monorepo 根目录：Turbopack 解析 packages/* 源码、standalone 产物追踪都以它为根，两者必须一致
const monorepoRoot = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  // packages/core 直接以 TS 源码导出，需要由 Next 编译
  transpilePackages: ["@kanban-hub/core"],
  // 不让 next dev 在 apps/web 下自动生成 AGENTS.md / CLAUDE.md：
  // AGENTS.md 按仓库的文档治理规则属于私有文件，“先读 node_modules/next/dist/docs”的提示写在根 CLAUDE.md 里
  agentRules: false,
};

// 固定语言 zh-CN，不做语言路由：配置见 src/i18n/request.ts
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);

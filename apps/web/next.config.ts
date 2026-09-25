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
  // 开发环境常见的两种访问方式（localhost、127.0.0.1）虽然都指向同一台机器，浏览器仍把它们
  // 当成不同的源；Next 16 默认只信任发起请求所用的那个 origin 去加载开发资源（HMR、RSC
  // payload 等），从 127.0.0.1 访问时会被当成跨源请求拦下，页面能显示但无法完成水合，
  // 按钮点了没反应。只影响 `next dev`，生产构建（standalone 输出）没有这层校验。
  allowedDevOrigins: ["127.0.0.1"],
};

// 固定语言 zh-CN，不做语言路由：配置见 src/i18n/request.ts
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);

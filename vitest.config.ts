import { defineConfig } from "vitest/config";

// 每个包有自己的 Vitest 配置，根配置只负责把它们收拢成多个项目。
// apps/* 用 .mts：Next 应用的 package.json 不声明 "type": "module"，.ts 配置会被当成 CommonJS 加载并触发 Vite 告警。
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.mts"],
  },
});

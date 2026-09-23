import { defineConfig } from "vitest/config";

// 每个包有自己的 vitest.config.ts，根配置只负责把它们收拢成多个项目
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
  },
});

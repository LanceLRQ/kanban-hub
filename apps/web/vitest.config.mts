import { defineProject } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineProject({
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});

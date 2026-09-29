import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { transferDocSchema } from "@kanban-hub/core/transfer";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

function get(headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(GET(new Request("http://internal/setup/migrate.md", { headers })));
}

describe("GET /setup/migrate.md", () => {
  it("不带 cookie 返回 200，三个响应头齐全", async () => {
    api = await setupTestApi();
    const res = await get({ host: "kanban.example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("配置了 publicUrl 时用它；Host 非法时用占位符", async () => {
    api = await setupTestApi();
    api.services.publicUrl = "https://kanban.example.com";
    expect(await (await get({ host: "x" })).text()).toContain("https://kanban.example.com/setup/agent.md");
    api.services.publicUrl = null;
    const body = await (await get({ host: "evil.com/x" })).text();
    expect(body).toContain("向用户询问服务端地址");
    expect(body).not.toContain("evil.com");
  });

  it("步骤里的命令齐全", async () => {
    api = await setupTestApi();
    const body = await (await get({ host: "kanban.example.com" })).text();
    for (const piece of ["kh whoami", "kh register --dry-run", "--yes", "kh status", "kh import", "--dry-run", "原样告诉用户"]) {
      expect(body, piece).toContain(piece);
    }
  });

  it("第一个 yaml 示例能通过导入文件的 schema，且覆盖主要字段", async () => {
    api = await setupTestApi();
    const body = await (await get({ host: "kanban.example.com" })).text();
    const match = /```yaml\n([\s\S]*?)```/.exec(body);
    expect(match).not.toBeNull();
    const doc: unknown = parse(match![1]!);
    const result = transferDocSchema.safeParse(doc);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    const text = match![1]!;
    for (const key of ["project:", "manualReason", "human:", "checklist", "docRefs", "dueDate", "startedAt", "completedAt", "events:", "kind: misc"]) {
      expect(text, key).toContain(key);
    }
  });

  it("格式说明覆盖每个字段", async () => {
    api = await setupTestApi();
    const body = await (await get({ host: "kanban.example.com" })).text();
    for (const field of [
      "cycle", "health", "focus", "kind", "code", "title", "targetVersion", "targetDate", "manualStatus", "manualReason",
      "tasks", "status", "suspendReason", "human", "group", "note", "docRefs", "checklist", "dueDate", "startedAt", "completedAt", "events",
    ]) {
      expect(body, field).toContain(`\`${field}\``);
    }
    expect(body).toContain("加引号");
    expect(body).toContain("时区");
  });
});

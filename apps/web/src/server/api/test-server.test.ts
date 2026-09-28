import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { matchPattern, startTestServer, type TestServer } from "./test-server";

const APP_DIR = path.resolve(import.meta.dirname, "../../app");

/** 磁盘上的一段目录名换成 URL 写法：[[...x]] → :x*?，[...x] → :x*，[x] → :x */
function segmentPattern(seg: string): string {
  const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(seg);
  if (optionalCatchAll) return `:${optionalCatchAll[1]}*?`;
  const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
  if (catchAll) return `:${catchAll[1]}*`;
  return seg.startsWith("[") && seg.endsWith("]") ? `:${seg.slice(1, -1)}` : seg;
}

/** 把磁盘上一个 route.ts 的路径换成 URL 写法，去掉 /route.ts 后缀 */
function patternFromRouteFile(filePath: string): string {
  const rel = path.relative(APP_DIR, filePath);
  const withoutFile = rel.slice(0, -"/route.ts".length);
  return `/${withoutFile.split(path.sep).map(segmentPattern).join("/")}`;
}

async function collectDiskRoutePatterns(): Promise<string[]> {
  const entries = await fs.readdir(APP_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name === "route.ts")
    .map((e) => patternFromRouteFile(path.join(e.parentPath, e.name)));
}

let server: TestServer | undefined;

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

describe("matchPattern", () => {
  it("单段参数按段匹配并解码", () => {
    expect(matchPattern("/api/v1/projects/p1/tasks/t%201", "/api/v1/projects/:id/tasks/:tid")).toEqual({ id: "p1", tid: "t 1" });
    expect(matchPattern("/api/v1/projects/p1", "/api/v1/projects/:id/tasks")).toBeNull();
  });

  it("多段通配 :name* 捕获剩余的一段或多段，逐段解码成数组", () => {
    const pattern = "/api/v1/projects/:id/snapshots/:machineId/files/:path*";
    expect(matchPattern("/api/v1/projects/p1/snapshots/m1/files/a/b/c.md", pattern)).toEqual({
      id: "p1",
      machineId: "m1",
      path: ["a", "b", "c.md"],
    });
    expect(matchPattern("/api/v1/projects/p1/snapshots/m1/files/%E4%B8%AD%20%E6%96%87.md", pattern)).toEqual({
      id: "p1",
      machineId: "m1",
      path: ["中 文.md"],
    });
    expect(matchPattern("/api/v1/projects/p1/snapshots/m1/files", pattern)).toBeNull();
    expect(matchPattern("/api/v1/projects/p1/snapshots/m1/other/a", pattern)).toBeNull();
  });

  it("可选多段通配 :name*? 也匹配零段，此时不带这个参数", () => {
    const pattern = "/raw/:token/:path*?";
    expect(matchPattern("/raw/t1", pattern)).toEqual({ token: "t1" });
    expect(matchPattern("/raw/t1/a/b.png", pattern)).toEqual({ token: "t1", path: ["a", "b.png"] });
  });
});

describe("startTestServer 路由表", () => {
  it("与磁盘上的 route.ts 一一对应（漏登记会失败）", async () => {
    server = await startTestServer();
    const disk = (await collectDiskRoutePatterns()).sort();
    const registered = server.routePatterns().sort();
    expect(registered).toEqual(disk);
  });

  it("动态段的参数能取到：GET /api/v1/projects/:id 返回对应项目", async () => {
    server = await startTestServer();
    const { token } = await server.api.pairMachine();
    const { project } = await server.api.store.createProject({ name: "动态段测试项目" }, {
      userId: server.api.store.auth.listUsers()[0]!.id,
      machineId: null,
      via: "web",
      agent: null,
    });

    const res = await fetch(`${server.url}/api/v1/projects/${project.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { id: string; name: string } };
    expect(body.project.id).toBe(project.id);
    expect(body.project.name).toBe("动态段测试项目");
  });

  it("非 GET 请求的请求体能完整到达处理函数：POST /api/v1/projects", async () => {
    server = await startTestServer();
    const { token } = await server.api.pairMachine();
    const longDescription = "本项目的说明。".repeat(30);

    const res = await fetch(`${server.url}/api/v1/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "请求体完整性测试", description: longDescription }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { name: string; description: string } };
    expect(body.project.name).toBe("请求体完整性测试");
    expect(body.project.description).toBe(longDescription);
  });

  it("SSE 路由能正常工作：/api/v1/stream 先发出 ready 事件", async () => {
    server = await startTestServer();
    const controller = new AbortController();
    try {
      const res = await fetch(`${server.url}/api/v1/stream`, {
        headers: { cookie: server.api.sessionCookie() },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const text = new TextDecoder().decode(value);
      expect(text).toContain("event: ready");
      await reader.cancel().catch(() => {});
    } finally {
      controller.abort();
    }
  });
});

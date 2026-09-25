import { afterEach, describe, expect, it } from "vitest";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { buildSetupView, type RequestOrigin } from "./setup";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

const NO_ORIGIN: RequestOrigin = { forwardedProto: null, forwardedHost: null, host: null };

function adminId(api: TestApi): string {
  return api.store.auth.listUsers().find((u) => u.role === "admin")!.id;
}

describe("buildSetupView", () => {
  it("配置了 publicUrl 时直接使用，不理会请求来源", async () => {
    api = await setupTestApi();
    api.services.publicUrl = "https://kanban.example.com";

    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: "http",
      forwardedHost: "should-not-be-used",
      host: "should-not-be-used",
    });

    expect(view.publicUrl).toBe("https://kanban.example.com");
  });

  it("没有 publicUrl 时优先按转发头推断", async () => {
    api = await setupTestApi();

    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: "https",
      forwardedHost: "kanban.example.com",
      host: "internal-host:28970",
    });

    expect(view.publicUrl).toBe("https://kanban.example.com");
  });

  it("没有转发头时按 Host 推断", async () => {
    api = await setupTestApi();

    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: null,
      forwardedHost: null,
      host: "192.168.1.20:28970",
    });

    expect(view.publicUrl).toBe("http://192.168.1.20:28970");
  });

  it("什么都推断不出来时给空串", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), NO_ORIGIN);
    expect(view.publicUrl).toBe("");
  });

  it("协议不是 http/https（例如 X-Forwarded-Proto: ftp）时给空串", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: "ftp",
      forwardedHost: "kanban.example.com",
      host: null,
    });
    expect(view.publicUrl).toBe("");
  });

  it("host 是 javascript: 协议注入时给空串（拼出来的地址解析失败）", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: null,
      forwardedHost: "javascript:alert(1)",
      host: null,
    });
    expect(view.publicUrl).toBe("");
  });

  it("host 带路径时只取 origin，丢弃路径", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: "https",
      forwardedHost: "kanban.example.com/evil?x=1#y",
      host: null,
    });
    expect(view.publicUrl).toBe("https://kanban.example.com");
  });

  it("host 带换行时给空串，不依赖 URL 静默剥离控制字符", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: null,
      forwardedHost: "kanban.example.com\nX-Injected: 1",
      host: null,
    });
    expect(view.publicUrl).toBe("");
  });

  it("host 含空白时给空串", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: null,
      forwardedHost: null,
      host: "192.168.1.20 evil",
    });
    expect(view.publicUrl).toBe("");
  });

  it("多值转发头只取逗号分隔的第一个值", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: "https, http",
      forwardedHost: "kanban.example.com, evil.example.com",
      host: null,
    });
    expect(view.publicUrl).toBe("https://kanban.example.com");
  });

  it("非法 Host（端口不是数字，new URL() 解析失败）时给空串", async () => {
    api = await setupTestApi();
    const view = buildSetupView(api.services, adminId(api), {
      forwardedProto: null,
      forwardedHost: null,
      host: "kanban.example.com:not-a-port",
    });
    expect(view.publicUrl).toBe("");
  });

  it("只列出当前用户的机器，按接入时间排序", async () => {
    api = await setupTestApi();
    const admin = adminId(api);
    const other = await api.store.auth.createUser({ name: "Bob", role: "member", passwordHash: "x" });

    await api.pairMachine("第二台");
    await api.pairMachine("第一台");
    await api.store.auth.createMachine({ name: "别人的机器", userId: other.id, os: "linux", tokenHash: "a".repeat(64) });

    const view = buildSetupView(api.services, admin, NO_ORIGIN);

    expect(view.machines.map((m) => m.name)).toEqual(["第二台", "第一台"]);
  });
});

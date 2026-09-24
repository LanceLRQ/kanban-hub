import { afterEach, describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import { setStore } from "@/server/store/instance";
import type { Store } from "@/server/store/store";
import { GET } from "./route";

afterEach(() => {
  setStore(undefined);
});

describe("GET /api/health", () => {
  it("取不到存储实例时返回 503", async () => {
    const res = GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "starting", version: KH_VERSION });
  });

  it("取到存储实例时返回 ok 与当前版本号", async () => {
    setStore({} as Store);
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: KH_VERSION });
  });
});

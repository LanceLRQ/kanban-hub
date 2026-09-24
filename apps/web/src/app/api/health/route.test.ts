import { describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("返回 ok 与当前版本号", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: KH_VERSION });
  });
});

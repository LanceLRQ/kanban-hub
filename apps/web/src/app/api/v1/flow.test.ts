import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Event, Project, Task } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi, type TestRequestOptions } from "@/server/api/testing";
import { POST as login } from "./auth/login/route";
import { GET as listEvents } from "./events/route";
import { POST as pair } from "./pair/route";
import { POST as issuePairingCode } from "./pairing-codes/route";
import { POST as createProject } from "./projects/route";
import { PUT as putLocation } from "./projects/[id]/locations/[machineId]/route";
import { POST as appendLog } from "./projects/[id]/log/route";
import { POST as createTask } from "./projects/[id]/tasks/route";
import { PATCH as patchTask } from "./projects/[id]/tasks/[tid]/route";
import { GET as openStream } from "./stream/route";

/**
 * 全流程测试：在进程内直接调用各路由导出的处理函数，串起登录、配对、看板操作、
 * 事件查询和 SSE 推送。分开看每个路由的单元测试已经覆盖了各自的分支，这里只证明
 * 它们真的能拼在一起用：登录发的 cookie 能签发配对码，配对码换来的令牌能建项目、
 * 改任务，写入的事件既能查到、顺序也对，同一个会话开的 SSE 连接也确实收到通知。
 */

/** 从 SSE 流里读取字节，累积到出现 match 或超时；每次 read() 都套超时，避免测试挂死 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, match: string, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes(match)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`等待 SSE 内容超时：${match}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取 SSE 流超时")), remaining)),
    ]);
    if (result.done) throw new Error(`SSE 流已经关闭，等不到：${match}`);
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

describe("M2 全流程：登录 → 配对 → 看板操作 → 事件查询 → SSE 推送", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("从登录到查询事件全程走通，事件类型与顺序正确，SSE 收到每一次写入对应的 change", async () => {
    api = await setupTestApi();

    // 1. 登录：真的走 /auth/login，从响应的 Set-Cookie 里取会话值，不走 api.sessionCookie() 的捷径
    const loginRes = await login(api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword } }));
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const sessionCookie = setCookie!.split(";")[0]!;
    expect(sessionCookie).toMatch(/^kh_session=/);

    // SSE 连接在第一次写操作之前打开，用真正登录到的会话
    const streamRes = await openStream(api.request("/api/v1/stream", { cookie: sessionCookie }));
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    await readUntil(reader, "event: ready");

    // 2. 生成配对码：真的走 /pairing-codes
    const codeRes = await issuePairingCode(api.request("/api/v1/pairing-codes", { method: "POST", cookie: sessionCookie }));
    expect(codeRes.status).toBe(201);
    const { code } = (await codeRes.json()) as { code: string };

    // 3. 配对拿到令牌：真的走 /pair；调用方是 kh，不带 Origin
    const pairRes = await pair(
      api.request("/api/v1/pair", {
        method: "POST",
        origin: null,
        json: { code, machineName: "全流程测试机器", os: "darwin" },
      }),
    );
    expect(pairRes.status).toBe(201);
    const { token, machineId } = (await pairRes.json()) as { token: string; machineId: string };

    // 后续的令牌请求都带 X-KH-Agent，会写进事件的操作者
    const AGENT = "flow-test";
    function tokenRequest(path: string, opts: TestRequestOptions): Request {
      return api.request(path, { ...opts, token, headers: { ...opts.headers, [HEADER_KH_AGENT]: AGENT } });
    }

    // 4. 用令牌新建项目
    const projectName = `全流程测试-${Date.now()}`;
    const createProjectRes = await createProject(
      tokenRequest("/api/v1/projects", { method: "POST", json: { name: projectName } }),
      api.ctx({}),
    );
    expect(createProjectRes.status).toBe(201);
    const { project, board } = (await createProjectRes.json()) as {
      project: Project;
      board: { containers: { id: string }[] };
    };
    const containerId = board.containers[0]!.id;

    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    // 5. 登记位置
    const locationRes = await putLocation(
      tokenRequest(`/api/v1/projects/${project.id}/locations/${machineId}`, { method: "PUT", json: { path: "/repo" } }),
      api.ctx({ id: project.id, machineId }),
    );
    expect(locationRes.status).toBe(200);
    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    // 6. 新建任务
    const createTaskRes = await createTask(
      tokenRequest(`/api/v1/projects/${project.id}/tasks`, { method: "POST", json: { containerId, title: "全流程任务" } }),
      api.ctx({ id: project.id }),
    );
    expect(createTaskRes.status).toBe(201);
    const task = (await createTaskRes.json()) as Task;
    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    // 7. 状态依次改成 in_progress、done
    const toInProgress = await patchTask(
      tokenRequest(`/api/v1/projects/${project.id}/tasks/${task.id}`, { method: "PATCH", json: { status: "in_progress" } }),
      api.ctx({ id: project.id, tid: task.id }),
    );
    expect(toInProgress.status).toBe(200);
    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    const toDone = await patchTask(
      tokenRequest(`/api/v1/projects/${project.id}/tasks/${task.id}`, { method: "PATCH", json: { status: "done" } }),
      api.ctx({ id: project.id, tid: task.id }),
    );
    expect(toDone.status).toBe(200);
    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    // 8. 写一条日志
    const logRes = await appendLog(
      tokenRequest(`/api/v1/projects/${project.id}/log`, { method: "POST", json: { text: "全流程日志" } }),
      api.ctx({ id: project.id }),
    );
    expect(logRes.status).toBe(201);
    expect(await readUntil(reader, "event: change")).toContain(`"projectId":"${project.id}"`);

    await reader.cancel();

    // 9. 查询事件：断言类型与顺序（倒序），操作者带上了 X-KH-Agent 给出的 agent
    const eventsRes = await listEvents(api.request(`/api/v1/events?project=${project.id}&limit=50`, { cookie: sessionCookie }));
    expect(eventsRes.status).toBe(200);
    const { events } = (await eventsRes.json()) as { events: Event[] };

    expect(events.map((e) => e.type)).toEqual([
      "log",
      "task.status_changed",
      "task.status_changed",
      "task.created",
      "project.updated",
      "project.created",
    ]);
    expect(events[0]?.actor).toMatchObject({ via: "cli", machineId, agent: AGENT });
  });
});

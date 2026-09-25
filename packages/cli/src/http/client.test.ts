import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HEADER_KH_AGENT, HEADER_KH_VERSION } from "@kanban-hub/core/api";
import { KH_VERSION } from "@kanban-hub/core/version";
import { EXIT, type CliError } from "../errors";
import { ApiClient } from "./client";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface StubServer {
  url: string;
  close: () => Promise<void>;
  requests: http.IncomingMessage[];
}

let activeServers: StubServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.map((s) => s.close()));
  activeServers = [];
});

async function serve(handler: Handler): Promise<StubServer> {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stub: StubServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
  activeServers.push(stub);
  return stub;
}

function jsonHandler(status: number, body: unknown): Handler {
  return (req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

function htmlHandler(status: number, text: string): Handler {
  return (req, res) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(text);
  };
}

function makeClient(server: string, overrides: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}): ApiClient {
  return new ApiClient({ server, fetch, ...overrides });
}

async function captureError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望 promise 被 reject，但它 resolve 了");
}

const okSchema = z.object({ ok: z.boolean() });

describe("ApiClient 错误映射", () => {
  it("400：把 details.issues 逐行打出来，退出码 5", async () => {
    const { url } = await serve(
      jsonHandler(400, {
        error: {
          code: "invalid",
          message: "数据校验失败",
          details: { issues: ["title：不能为空", "order：必须是非负整数"] },
        },
      }),
    );
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toContain("数据校验失败");
    expect(err.message).toContain("title：不能为空");
    expect(err.message).toContain("order：必须是非负整数");
  });

  it("401：退出码 3，提示到 /setup 取配对码", async () => {
    const { url } = await serve(jsonHandler(401, { error: { code: "unauthorized", message: "令牌已失效" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.message).toBe("令牌已失效");
    expect(err.hint).toContain(`${url}/setup`);
    expect(err.hint).toContain("kh login");
  });

  it("403：退出码 3", async () => {
    const { url } = await serve(jsonHandler(403, { error: { code: "forbidden", message: "没有权限" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.message).toBe("没有权限");
  });

  it("404（错误格式）：退出码 5，原样显示服务端 message", async () => {
    const { url } = await serve(jsonHandler(404, { error: { code: "not_found", message: "任务不存在" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toBe("任务不存在");
  });

  it("404（HTML，非错误格式）：退出码 6，提示更新 kh", async () => {
    const { url } = await serve(htmlHandler(404, "<html>Not Found</html>"));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.INCOMPATIBLE);
    expect(err.hint).toContain("kh.tgz");
  });

  it("405（非错误格式）：退出码 6", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method Not Allowed");
    });
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.INCOMPATIBLE);
  });

  it("409：退出码 5", async () => {
    const { url } = await serve(jsonHandler(409, { error: { code: "conflict", message: "版本冲突" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toBe("版本冲突");
  });

  it("413：退出码 5", async () => {
    const { url } = await serve(jsonHandler(413, { error: { code: "payload_too_large", message: "请求体太大" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toBe("请求体太大");
  });

  it("426：退出码 6，提示 npm 安装命令", async () => {
    const { url } = await serve(jsonHandler(426, { error: { code: "upgrade_required", message: "kh 版本过旧" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.INCOMPATIBLE);
    expect(err.message).toBe("kh 版本过旧");
    expect(err.hint).toContain("npm i -g");
    expect(err.hint).toContain("kh.tgz");
  });

  it("429：退出码 3，只显示服务端的 message", async () => {
    const { url } = await serve(jsonHandler(429, { error: { code: "rate_limited", message: "尝试太频繁，请稍后再试" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.message).toBe("尝试太频繁，请稍后再试");
  });

  it("500：退出码 1", async () => {
    const { url } = await serve(jsonHandler(500, { error: { code: "internal", message: "服务端内部错误" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNEXPECTED);
  });

  it("502（HTML，网关错误）：退出码 4", async () => {
    const { url } = await serve(htmlHandler(502, "<html>Bad Gateway</html>"));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNREACHABLE);
  });

  it("503：退出码 4", async () => {
    const { url } = await serve(jsonHandler(503, { error: { code: "unavailable", message: "维护中" } }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNREACHABLE);
  });

  it("连接被拒绝：退出码 4，错误信息附上 err.cause.code", async () => {
    // 先监听拿一个空闲端口再关掉，确保这个端口上没有服务在监听
    const { url, close } = await serve(() => {});
    await close();
    activeServers = activeServers.filter((s) => s.url !== url);
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNREACHABLE);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("超时：退出码 4", async () => {
    const { url } = await serve((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 200);
    });
    const err = await captureError(makeClient(url, { timeoutMs: 30 }).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNREACHABLE);
  });

  it("发完响应头就不再发数据：超时覆盖到读响应体，退出码 4", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{"); // 发了响应头和部分正文，之后再也不写、也不 end()
    });
    const err = await captureError(makeClient(url, { timeoutMs: 50 }).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNREACHABLE);
  });

  it("重定向（带 Location）：退出码 2，提示改用新地址重新登录", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(302, { location: "https://new.example.test/api" });
      res.end();
    });
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("重定向");
    expect(err.hint).toContain("https://new.example.test");
    expect(err.hint).toContain("kh login");
  });

  it("重定向（没有 Location）：退出码 2，提示检查服务端地址", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(302);
      res.end();
    });
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("检查服务端地址");
  });

  it("成功响应的格式对不上 schema：退出码 1", async () => {
    const { url } = await serve(jsonHandler(200, { notOk: true }));
    const err = await captureError(makeClient(url).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNEXPECTED);
  });

  it("成功响应按 schema 解析后返回", async () => {
    const { url } = await serve(jsonHandler(200, { ok: true }));
    await expect(makeClient(url).get("/x", okSchema)).resolves.toEqual({ ok: true });
  });
});

describe("ApiClient 请求头", () => {
  it("每个请求都带 X-KH-Version", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url).get("/x", okSchema);
    expect(stub.requests[0]?.headers[HEADER_KH_VERSION]).toBe(KH_VERSION);
  });

  it("有令牌时带 Authorization: Bearer", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url, { token: "the-token" }).get("/x", okSchema);
    expect(stub.requests[0]?.headers.authorization).toBe("Bearer the-token");
  });

  it("没有令牌时不带 Authorization", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url).get("/x", okSchema);
    expect(stub.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("agent 为空时不带 X-KH-Agent", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url).get("/x", okSchema);
    expect(stub.requests[0]?.headers[HEADER_KH_AGENT]).toBeUndefined();
  });

  it("agent 非空时带 X-KH-Agent", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url, { agent: "claude-code" }).get("/x", okSchema);
    expect(stub.requests[0]?.headers[HEADER_KH_AGENT]).toBe("claude-code");
  });

  it("有请求体时带 Content-Type: application/json", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url).post("/x", { a: 1 }, okSchema);
    expect(stub.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("GET 请求不带 Content-Type", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    await makeClient(stub.url).get("/x", okSchema);
    expect(stub.requests[0]?.headers["content-type"]).toBeUndefined();
  });

  it("错误信息与提示里不出现令牌", async () => {
    const { url } = await serve(jsonHandler(401, { error: { code: "unauthorized", message: "令牌已失效" } }));
    const err = await captureError(makeClient(url, { token: "super-secret-token" }).get("/x", okSchema));
    expect(err.message).not.toContain("super-secret-token");
    expect(err.hint ?? "").not.toContain("super-secret-token");
  });

  it("agent 含控制字符时在发请求前拒绝，退出码 1，只报头名不报值", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    const err = await captureError(makeClient(stub.url, { agent: "bad\nagent-with-secret" }).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNEXPECTED);
    expect(err.message).toContain(HEADER_KH_AGENT);
    expect(err.message).not.toContain("bad\nagent-with-secret");
    expect(err.message).not.toContain("secret");
  });

  it("令牌含非 ASCII 字符时在发请求前拒绝，退出码 1，错误信息不含令牌本身", async () => {
    const stub = await serve(jsonHandler(200, { ok: true }));
    const err = await captureError(makeClient(stub.url, { token: "kh_café-token" }).get("/x", okSchema));
    expect(err.exitCode).toBe(EXIT.UNEXPECTED);
    expect(err.message).toContain("authorization");
    expect(err.message).not.toContain("café");
  });
});

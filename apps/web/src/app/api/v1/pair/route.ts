import { type PairResponse, type RateLimitDetails, pairInput } from "@kanban-hub/core/api";
import type { DeepReadonly } from "@kanban-hub/core/schema";
import { clientKey } from "@/server/auth/rate-limit";
import { generateMachineToken, hashToken } from "@/server/auth/token";
import { ApiError } from "@/server/api/errors";
import { json, readJson } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 调用方是 kh，不是浏览器，不做同源校验
export const POST = apiRoute({ auth: "none" }, async ({ req, services }) => {
  // 先读请求体（非法请求体照旧 400，不计入失败次数），再 check；check、consume、
  // 失败时的 recordFailure 全程同步、中间不能有 await——否则并发请求会在都
  // await 请求体的时候一起通过 check，限流形同虚设（scrypt 不存在但 consume
  // 本身也不便宜，同样的并发绕过风险）
  const input = await readJson(req, pairInput);

  const key = `pair:${clientKey(req.headers)}`;
  const limit = services.limiter.check(key);
  if (limit.blocked) {
    const details = { retryAfterSeconds: limit.retryAfterSec } satisfies RateLimitDetails;
    throw new ApiError("rate_limited", "配对尝试过于频繁，请稍后再试", details);
  }

  const grant = services.pairing.consume(input.code);
  if (!grant) {
    services.limiter.recordFailure(key);
    throw new ApiError("unauthorized", "配对码无效或已过期");
  }

  const token = generateMachineToken();
  try {
    const machine = await services.store.auth.createMachine({
      name: input.machineName,
      userId: grant.userId,
      os: input.os,
      tokenHash: hashToken(token),
    });
    const body = { token, machineId: machine.id } satisfies DeepReadonly<PairResponse>;
    return json(body, { status: 201 });
  } catch (e) {
    // 配对码已经被兑换掉了，创建机器失败时放回去，不然这个配对码就白白浪费了
    services.pairing.restore(grant);
    throw e;
  }
});
